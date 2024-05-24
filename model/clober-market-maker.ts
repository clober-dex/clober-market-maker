import * as fs from 'fs'
import * as path from 'path'

import _ from 'lodash'
import * as yaml from 'yaml'
import {
  approveERC20,
  baseToQuote,
  CHAIN_IDS,
  getOpenOrders,
  type OpenOrder,
  setApprovalOfOpenOrdersForAll,
  getContractAddresses,
} from '@clober/v2-sdk'
import type { PublicClient, WalletClient } from 'viem'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  http,
  isAddressEqual,
  parseUnits,
  zeroAddress,
  zeroHash,
} from 'viem'
import chalk from 'chalk'
import { privateKeyToAccount } from 'viem/accounts'
import BigNumber from 'bignumber.js'
import { arbitrumSepolia, base } from 'viem/chains'

import { logger, slackClient } from '../utils/logger.ts'
import { CHAIN_MAP } from '../constants/chain.ts'
import { ERC20_PERMIT_ABI } from '../abis/@openzeppelin/erc20-permit-abi.ts'
import {
  findCurrencyByAddress,
  findCurrencyBySymbol,
} from '../utils/currency.ts'
import { getGasPrice, waitTransaction } from '../utils/transaction.ts'
import { getDeadlineTimestampInSeconds } from '../utils/time.ts'
import { Action } from '../constants/action.ts'
import {
  CANCEL_ORDER_PARAMS_ABI,
  CLAIM_ORDER_PARAMS_ABI,
  MAKE_ORDER_PARAMS_ABI,
} from '../abis/core/params-abi.ts'
import { CONTROLLER_ABI } from '../abis/core/controller-abi.ts'
import { getBookTicks, getMarketPrice } from '../utils/tick.ts'

import { Clober } from './clober.ts'
import type { Config, Params } from './config.ts'
import type { MakeParam } from './make-param.ts'
import { ChainLink } from './chainLink.ts'

const BID = 0
const ASK = 1

export class CloberMarketMaker {
  // immutable state
  chainId: CHAIN_IDS
  userAddress: `0x${string}`
  publicClient: PublicClient
  walletClient: WalletClient
  config: Config
  erc20Tokens: `0x${string}`[] = []
  // define exchanges
  chainlink: ChainLink
  clober: Clober
  // mutable state
  openOrders: OpenOrder[] = []
  balances: { [address: `0x${string}`]: bigint } = {}
  private initialized = false

  constructor(configPath?: string) {
    configPath = configPath ?? path.join(__dirname, '../config.yaml')
    this.config = yaml.parse(fs.readFileSync(configPath, 'utf8')) as Config
    this.paramsValidator(this.config)
    this.chainId = Number(process.env.CHAIN_ID) as CHAIN_IDS
    if (!process.env.CHAIN_ID) {
      throw new Error('CHAIN_ID must be set')
    }

    this.publicClient = createPublicClient({
      chain: CHAIN_MAP[this.chainId],
      transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
    })

    const account = privateKeyToAccount(
      process.env.PRIVATE_KEY as `0x${string}`,
    )
    this.walletClient = createWalletClient({
      account,
      chain: CHAIN_MAP[this.chainId],
      transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
    })
    if (!this.walletClient.account) {
      throw new Error('WalletClient must have an account')
    }
    this.userAddress = getAddress(this.walletClient.account.address)

    // set up exchanges
    this.chainlink = new ChainLink(
      this.chainId === arbitrumSepolia.id ? base.id : this.chainId,
      _.mapValues(this.config.markets, (m) => m.chainlink),
    )
    this.clober = new Clober(
      this.chainId,
      _.mapValues(this.config.markets, (m) => m.clober),
    )
    this.erc20Tokens = Object.values(
      _.mapValues(this.config.markets, (m) => m.clober),
    )
      .map((m) => [
        getAddress(findCurrencyBySymbol(this.chainId, m.quote).address),
        getAddress(findCurrencyBySymbol(this.chainId, m.base).address),
      ])
      .flat()
      .filter(
        (address, index, self) =>
          self.findIndex((a) => getAddress(a) === getAddress(address)) ===
          index,
      )
      .filter((address) => getAddress(address) !== zeroAddress)

    logger(chalk.green, 'Clober market maker initialized', {
      chainId: this.chainId,
      account: this.userAddress,
      configPath,
      rpcUrl: this.publicClient.transport.url,
      markets: Object.keys(this.config.markets),
    })
  }

  async init() {
    // 1. approve all tokens
    for (const address of this.erc20Tokens) {
      const hash = await approveERC20({
        chainId: this.chainId,
        walletClient: this.walletClient,
        token: address,
      })
      await waitTransaction(
        'Approve',
        {
          token: address,
        },
        this.publicClient,
        hash,
      )
    }

    // 2. setApprovalOfOpenOrdersForAll
    const hash = await setApprovalOfOpenOrdersForAll({
      chainId: this.chainId,
      walletClient: this.walletClient,
    })
    await waitTransaction(
      'setApprovalOfOpenOrdersForAll',
      {},
      this.publicClient,
      hash,
    )

    // 3. cancel all orders
    const openOrders = await getOpenOrders({
      chainId: this.chainId,
      userAddress: this.userAddress,
    })
    await this.execute(
      [],
      openOrders.map((order) => order.id),
      [],
      [],
    )

    await this.sleep(5000)
    this.initialized = true
  }

  async update() {
    const fetchQueue: Promise<void>[] = []
    const start = performance.now()

    // get open orders
    fetchQueue.push(
      getOpenOrders({
        chainId: this.chainId,
        userAddress: this.userAddress,
      }).then((openOrder) => {
        this.openOrders = openOrder
      }),
    )

    // get balances
    fetchQueue.push(
      this.publicClient
        .multicall({
          contracts: this.erc20Tokens.map((address) => ({
            address,
            abi: ERC20_PERMIT_ABI,
            functionName: 'balanceOf',
            args: [this.userAddress],
          })),
        })
        .then((results) => {
          this.balances = results.reduce(
            (acc: {}, { result }, index: number) => {
              const address = this.erc20Tokens[index]
              return {
                ...acc,
                [getAddress(address)]: result ?? 0n,
              }
            },
            this.balances,
          )
        }),
    )

    // get eth balance
    fetchQueue.push(
      this.publicClient
        .getBalance({
          address: this.userAddress,
        })
        .then((balance) => {
          this.balances[zeroAddress] = balance
        }),
    )
    await Promise.all(fetchQueue)
    const end = performance.now()

    await logger(chalk.magenta, 'market maker updated', {
      second: ((end - start) / 1000).toFixed(2),
      openOrders: this.openOrders.length,
      balance: Object.entries(this.balances).map(([address, balance]) => ({
        address,
        balance: formatUnits(
          balance,
          findCurrencyByAddress(this.chainId, getAddress(address)).decimals,
        ),
      })),
    })
  }

  async run() {
    if (!this.initialized) {
      throw new Error('MarketMaker is not initialized')
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await Promise.all([
          this.chainlink.update(),
          this.clober.update(),
          this.update(),
        ])
      } catch (e) {
        console.error('Error in update', e)
        if (slackClient && (e as any).toString().includes('Error')) {
          slackClient
            .error({ message: 'Error in update', error: (e as any).toString() })
            .catch(() => {})
        }
      }

      try {
        await Promise.all(
          Object.entries(this.config.markets).map(([market, { params }]) =>
            this.marketMaking(market, params),
          ),
        )
      } catch (e) {
        console.error('Error in market making', e)
        if (slackClient && (e as any).toString().includes('Error')) {
          slackClient
            .error({
              message: 'Error in market making',
              error: (e as any).toString(),
            })
            .catch(() => {})
        }
      }

      await this.sleep(this.config.fetchIntervalMilliSeconds)
    }
  }

  async marketMaking(market: string, params: Params) {
    const [lowestAsk, highestBid, oraclePrice] = [
      this.clober.lowestAsk(market),
      this.clober.highestBid(market),
      this.chainlink.price(market),
    ]

    const [base, quote] = market.split('/')
    const quoteCurrency = findCurrencyBySymbol(this.chainId, quote)
    const baseCurrency = findCurrencyBySymbol(this.chainId, base)
    const openOrders = this.openOrders.filter(
      (order) =>
        (isAddressEqual(order.inputCurrency.address, baseCurrency.address) &&
          isAddressEqual(
            order.outputCurrency.address,
            quoteCurrency.address,
          )) ||
        (isAddressEqual(order.inputCurrency.address, quoteCurrency.address) &&
          isAddressEqual(order.outputCurrency.address, baseCurrency.address)),
    )
    const freeBase = new BigNumber(
      formatUnits(
        this.balances[getAddress(baseCurrency.address)],
        baseCurrency.decimals,
      ),
    )
    const freeQuote = new BigNumber(
      formatUnits(
        this.balances[getAddress(quoteCurrency.address)],
        quoteCurrency.decimals,
      ),
    )
    const claimableBase = openOrders.reduce(
      (acc, order) =>
        order.isBid ? acc.plus(order.claimable.value) : acc.plus(0),
      new BigNumber(0),
    )
    const claimableQuote = openOrders.reduce(
      (acc, order) =>
        order.isBid ? acc.plus(0) : acc.plus(order.claimable.value),
      new BigNumber(0),
    )
    const cancelableBase = openOrders.reduce(
      (acc, order) =>
        order.isBid ? acc.plus(0) : acc.plus(order.cancelable.value),
      new BigNumber(0),
    )
    const cancelableQuote = openOrders.reduce(
      (acc, order) =>
        order.isBid ? acc.plus(order.cancelable.value) : acc.plus(0),
      new BigNumber(0),
    )
    const totalBase = freeBase.plus(claimableBase).plus(cancelableBase)
    const totalQuote = freeQuote.plus(claimableQuote).plus(cancelableQuote)
    await logger(chalk.redBright, 'Balance', {
      market,
      totalBase: totalBase.toString(),
      freeBase: freeBase.toString(),
      claimableBase: claimableBase.toString(),
      cancelableBase: cancelableBase.toString(),
      totalQuote: totalQuote.toString(),
      freeQuote: freeQuote.toString(),
      claimableQuote: claimableQuote.toString(),
      cancelableQuote: cancelableQuote.toString(),
    })
    await logger(chalk.grey, 'PnL', {
      market,
      baseNet: totalBase.minus(params.startBaseAmount).toString(),
      quoteNet: totalQuote.minus(params.startQuoteAmount).toString(),
      onHold: oraclePrice
        .times(params.startBaseAmount)
        .plus(params.startQuoteAmount)
        .toString(),
      onCurrent: oraclePrice.times(totalBase).plus(totalQuote).toString(),
      basePnL: totalBase
        .minus(params.startBaseAmount)
        .plus(totalQuote.minus(params.startQuoteAmount).div(oraclePrice))
        .toString(),
      quotePnL: totalBase
        .minus(params.startBaseAmount)
        .times(oraclePrice)
        .plus(totalQuote.minus(params.startQuoteAmount))
        .toString(),
    })

    // 1. calculate skew (totalDollarBase - totalDollarQuote) / deltaLimit
    // @dev we suppose that quote is usdc
    let skew = totalBase
      .times(oraclePrice)
      .minus(totalQuote)
      .div(params.deltaLimit)
      .toNumber()
    if (skew > 1) {
      skew = 1 // too many base
    } else if (skew < -1) {
      skew = -1 // too many quote
    }

    /*
    if base balance = default + deltaLimit (skew = 1) => ask spread = min, bid spread = max
    if base balance = default - deltaLimit (skew = -1) => ask spread = max, bid spread = min
    */
    const askSpread = Math.round(
      (params.maxTickSpread - params.minTickSpread) * 0.5 * (skew + 1) +
        params.minTickSpread,
    )
    const bidSpread = Math.round(
      params.maxTickSpread + params.minTickSpread - askSpread,
    )

    const askSize = params.orderSize * Math.min(skew + 1, 1)
    const bidSize = params.orderSize * Math.min(1 - skew, 1)

    // 2. sort current open orders from openOrders
    const currentOpenOrders: [
      {
        [tick: number]: OpenOrder[]
      },
      { [tick: number]: OpenOrder[] },
    ] = [{}, {}]
    _.forEach(openOrders, (order) => {
      const arr = order.isBid ? currentOpenOrders[BID] : currentOpenOrders[ASK]
      if (!arr[order.tick]) {
        arr[order.tick] = []
      }
      arr[order.tick].push(order)
    })
    for (const side of [BID, ASK]) {
      for (const id of Object.keys(currentOpenOrders[side])) {
        currentOpenOrders[side][+id].sort(
          (a, b) => +a.orderIndex - +b.orderIndex,
        )
      }
    }

    // 3. calculate target orders
    const { bidBookTick, askBookTick } = getBookTicks({
      marketQuoteCurrency: findCurrencyBySymbol(this.chainId, quote),
      marketBaseCurrency: findCurrencyBySymbol(this.chainId, base),
      price: oraclePrice.toString(),
    })
    const targetOrders: [
      { [tick: number]: number },
      { [tick: number]: number },
    ] = [{}, {}]
    for (let i = 0; i < params.orderNum; i++) {
      const tick = askBookTick - BigInt(askSpread - params.orderGap * i)
      targetOrders[ASK][Number(tick)] = askSize
    }
    for (let i = 0; i < params.orderNum; i++) {
      const tick = bidBookTick - BigInt(bidSpread - params.orderGap * i)
      targetOrders[BID][Number(tick)] = bidSize
    }

    const requiredQuoteAmount = new BigNumber(
      formatUnits(
        Object.entries(targetOrders[BID])
          .map(([tick, size]) =>
            baseToQuote(
              BigInt(tick),
              parseUnits(size.toString(), baseCurrency.decimals),
              true,
            ),
          )
          .reduce((acc: bigint, quoteAmount) => acc + quoteAmount, 0n),
        quoteCurrency.decimals,
      ),
    )
    if (requiredQuoteAmount.isGreaterThan(totalQuote)) {
      await logger(chalk.redBright, 'Insufficient quote balance', {
        market,
        quoteCurrency: quoteCurrency.address,
        totalQuoteAmount: requiredQuoteAmount.toString(),
        balance: this.balances[getAddress(quoteCurrency.address)].toString(),
      })
      return
    }

    const requiredBaseAmount = new BigNumber(
      formatUnits(
        Object.values(targetOrders[ASK])
          .map((size) => parseUnits(size.toString(), baseCurrency.decimals))
          .reduce((acc: bigint, baseAmount) => acc + baseAmount, 0n),
        baseCurrency.decimals,
      ),
    )
    if (requiredBaseAmount.isGreaterThan(totalBase)) {
      await logger(chalk.redBright, 'Insufficient base balance', {
        market,
        baseCurrency: baseCurrency.address,
        totalBaseAmount: requiredBaseAmount.toString(),
        balance: this.balances[getAddress(baseCurrency.address)].toString(),
      })
      return
    }

    const { bidBookTick: lowestAskBidBookTick } = getBookTicks({
      marketQuoteCurrency: findCurrencyBySymbol(this.chainId, quote),
      marketBaseCurrency: findCurrencyBySymbol(this.chainId, base),
      price: lowestAsk.toString(),
    })
    const { bidBookTick: highestBidBidBookTick } = getBookTicks({
      marketQuoteCurrency: findCurrencyBySymbol(this.chainId, quote),
      marketBaseCurrency: findCurrencyBySymbol(this.chainId, base),
      price: highestBid.toString(),
    })

    // Skip when the oracle price is in the spread
    if (
      lowestAsk &&
      highestBid &&
      oraclePrice.isGreaterThan(highestBid) &&
      oraclePrice.isLessThan(lowestAsk) &&
      lowestAskBidBookTick - highestBidBidBookTick <=
        params.maxTickSpread + params.minTickSpread
      // highestBid < oraclePrice && oraclePrice < lowestAsk &&
      // lowestAskBidBookTick - highestBidBidBookTick <= params.maxTickSpread + params.minTickSpread
    ) {
      await logger(chalk.red, 'Skip making orders', {
        market,
        lowestAsk: lowestAsk.toString(),
        oraclePrice: oraclePrice.toString(),
        highestBid: highestBid.toString(),
      })
      return
    }

    // 4. calculate orders to cancel & claim
    const orderIdsToClaim: { id: string; isBid: boolean }[] = []
    const orderIdsToCancel: { id: string; isBid: boolean }[] = []
    for (const side of [BID, ASK]) {
      for (const id of Object.keys(currentOpenOrders[side])) {
        let cancelIndex = 0
        if (targetOrders[side][+id]) {
          for (
            ;
            cancelIndex < currentOpenOrders[side][+id].length;
            cancelIndex += 1
          ) {
            const order = currentOpenOrders[side][+id][cancelIndex]
            const openAmount = Number(order.cancelable.value) // without rebate
            if (openAmount > targetOrders[side][+id]) {
              break
            }
            targetOrders[side][+id] -= openAmount
          }
          if (targetOrders[side][+id] < params.minOrderSize) {
            // cutting off small orders
            delete targetOrders[side][+id]
          }
        }
        orderIdsToClaim.push(
          ...currentOpenOrders[side][+id]
            .filter((order) => Number(order.claimable.value) > 0)
            .map((order) => ({ id: order.id, isBid: order.isBid })),
        )
        orderIdsToCancel.push(
          ..._.map(
            currentOpenOrders[side][+id]
              .slice(cancelIndex)
              .filter((order) => order.amount.value !== order.filled.value),
            (order) => ({ id: order.id, isBid: order.isBid }),
          ),
        )
      }
    }

    const humanReadableTargetOrders = {
      ask: Object.keys(targetOrders[ASK])
        .map((tick) => [
          Number(
            getMarketPrice({
              marketQuoteCurrency: findCurrencyBySymbol(this.chainId, quote),
              marketBaseCurrency: findCurrencyBySymbol(this.chainId, base),
              askTick: BigInt(tick),
            }),
          ),
          targetOrders[ASK][Number(tick)],
        ])
        .sort((a, b) => b[0] - a[0])
        .filter((o) => o[1] > 0),
      bid: Object.keys(targetOrders[BID])
        .map((tick) => [
          Number(
            getMarketPrice({
              marketQuoteCurrency: findCurrencyBySymbol(this.chainId, quote),
              marketBaseCurrency: findCurrencyBySymbol(this.chainId, base),
              bidTick: BigInt(tick),
            }),
          ),
          targetOrders[BID][Number(tick)],
        ])
        .sort((a, b) => b[0] - a[0])
        .filter((o) => o[1] > 0),
    }

    const bidMakeParams: MakeParam[] = Object.entries(targetOrders[BID]).map(
      ([tick, size]) => ({
        id: BigInt(this.clober.bookIds[market][BID]),
        tick: Number(tick),
        quoteAmount: baseToQuote(
          BigInt(tick),
          parseUnits(size.toString(), baseCurrency.decimals),
          true,
        ),
        hookData: zeroHash,
        isBid: true,
        isETH: isAddressEqual(quoteCurrency.address, zeroAddress),
      }),
    )

    const askMakeParams: MakeParam[] = Object.entries(targetOrders[ASK]).map(
      ([tick, size]) => ({
        id: BigInt(this.clober.bookIds[market][ASK]),
        tick: Number(tick),
        quoteAmount: parseUnits(size.toString(), baseCurrency.decimals),
        hookData: zeroHash,
        isBid: false,
        isETH: isAddressEqual(baseCurrency.address, zeroAddress),
      }),
    )

    await logger(chalk.redBright, 'Execute Detail', {
      market,
      skew,
      orderIdsToClaim,
      claimBidOrderLength: orderIdsToClaim.filter((o) => o.isBid).length,
      claimAskOrderLength: orderIdsToClaim.filter((o) => !o.isBid).length,
      orderIdsToCancel,
      cancelBidOrderLength: orderIdsToCancel.filter((o) => o.isBid).length,
      cancelAskOrderLength: orderIdsToCancel.filter((o) => !o.isBid).length,
      askSpread,
      bidSpread,
      askSize,
      bidSize,
      targetOrders: humanReadableTargetOrders,
      targetBidOrderLength: humanReadableTargetOrders.bid.length,
      targetAskOrderLength: humanReadableTargetOrders.ask.length,
      lowestAsk:
        humanReadableTargetOrders.ask.sort((a, b) => a[0] - b[0])[0]?.[0] ||
        '-',
      oraclePrice: oraclePrice.toString(),
      highestBid:
        humanReadableTargetOrders.bid.sort((a, b) => b[0] - a[0])[0]?.[0] ||
        '-',
    })

    await this.execute(
      orderIdsToClaim.map(({ id }) => id),
      orderIdsToCancel.map(({ id }) => id),
      bidMakeParams,
      askMakeParams,
    )
  }

  async execute(
    orderIdsToClaim: string[],
    orderIdsToCancel: string[],
    bidMakeParams: MakeParam[],
    askMakeParams: MakeParam[],
  ): Promise<void> {
    if (
      [
        ...orderIdsToClaim,
        ...orderIdsToCancel,
        ...bidMakeParams,
        ...askMakeParams,
      ].length === 0
    ) {
      return
    }

    const gasPrice = await getGasPrice(
      this.publicClient,
      this.config.gasMultiplier,
    )
    const hash = await this.walletClient.writeContract({
      chain: CHAIN_MAP[this.chainId],
      address: getContractAddresses({ chainId: this.chainId })!.Controller,
      abi: CONTROLLER_ABI,
      account: this.walletClient.account!,
      functionName: 'execute',
      args: [
        [
          ...orderIdsToClaim.map(() => Action.CLAIM),
          ...orderIdsToCancel.map(() => Action.CANCEL),
          ...[...bidMakeParams, ...askMakeParams].map(() => Action.MAKE),
        ],
        [
          ...orderIdsToClaim.map((id) =>
            encodeAbiParameters(CLAIM_ORDER_PARAMS_ABI, [
              { id, hookData: zeroHash },
            ]),
          ),
          ...orderIdsToCancel.map((id) =>
            encodeAbiParameters(CANCEL_ORDER_PARAMS_ABI, [
              { id, leftQuoteAmount: 0n, hookData: zeroHash },
            ]),
          ),
          ...[...bidMakeParams, ...askMakeParams].map(
            ({ id, hookData, tick, quoteAmount }) =>
              encodeAbiParameters(MAKE_ORDER_PARAMS_ABI, [
                { id, tick, hookData, quoteAmount },
              ]),
          ),
        ],
        this.erc20Tokens,
        [],
        [],
        getDeadlineTimestampInSeconds(),
      ],
      value: [...bidMakeParams, ...askMakeParams]
        .filter((p) => p.isETH)
        .reduce((acc: bigint, { quoteAmount }) => acc + quoteAmount, 0n),
      gas: 5_000_000n,
      gasPrice,
    })
    await waitTransaction(
      'Execute Orders',
      {
        claimed: orderIdsToClaim.length,
        canceled: orderIdsToCancel.length,
        bid: bidMakeParams.length,
        ask: askMakeParams.length,
      },
      this.publicClient,
      hash,
    )
  }

  async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private paramsValidator(config: Config) {
    Object.values(config.markets).forEach(({ params }) => {
      // maxTickSpread > minTickSpread
      if (params.maxTickSpread <= params.minTickSpread) {
        throw new Error('maxTickSpread must be greater than minTickSpread')
      }
    })
  }
}

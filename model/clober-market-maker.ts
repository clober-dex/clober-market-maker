import * as fs from 'fs'
import * as path from 'path'

import _ from 'lodash'
import * as yaml from 'yaml'
import {
  approveERC20,
  CHAIN_IDS,
  type Currency,
  getContractAddresses,
  getOpenOrders,
  type OpenOrder,
  setApprovalOfOpenOrdersForAll,
  getMarketPrice,
} from '@clober/v2-sdk'
import type { PublicClient, WalletClient } from 'viem'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
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
import { arbitrumSepolia, base } from 'viem/chains'

import { logger, slackClient } from '../utils/logger.ts'
import { CHAIN_MAP } from '../constants/chain.ts'
import { ERC20_PERMIT_ABI } from '../abis/@openzeppelin/erc20-permit-abi.ts'
import { findCurrencyBySymbol } from '../utils/currency.ts'
import { getGasPrice, waitTransaction } from '../utils/transaction.ts'
import { convertTimestampToBlockNumber } from '../utils/time.ts'
import { Action } from '../constants/action.ts'
import {
  CANCEL_ORDER_PARAMS_ABI,
  CLAIM_ORDER_PARAMS_ABI,
  MAKE_ORDER_PARAMS_ABI,
} from '../abis/core/params-abi.ts'
import { CONTROLLER_ABI } from '../abis/core/controller-abi.ts'
import { buildTickAndPriceArray } from '../utils/tick.ts'
import BigNumber from '../utils/bignumber.ts'
import { calculateMinMaxPrice, getProposedPrice } from '../utils/price.ts'
import { isNewEpoch } from '../utils/epoch.ts'
import { calculateOrderSize } from '../utils/order.ts'
import { calculateUniV2ImpermanentLoss } from '../utils/uni-v2.ts'

import { Clober } from './exchange/clober.ts'
import type { Config, Params } from './config.ts'
import type { MakeParam } from './make-param.ts'
import type { Epoch } from './epoch.ts'
import { DexSimulator } from './dex-simulator.ts'
import { Binance } from './oracle/binance.ts'
import type { Oracle } from './oracle'

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
  dexSimulator: DexSimulator
  // define exchanges
  oracle: Oracle
  clober: Clober
  // mutable state
  epoch: { [market: string]: Epoch[] } = {}
  private initialized = false
  private lock: { [calldata: string]: boolean } = {}

  constructor(configPath?: string) {
    configPath = configPath ?? path.join(__dirname, '../config.yaml')
    this.config = yaml.parse(fs.readFileSync(configPath, 'utf8')) as Config
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
    this.dexSimulator = new DexSimulator(
      this.chainId === arbitrumSepolia.id ? base.id : this.chainId,
      _.mapValues(this.config.markets, (m) => m.clober),
      _.mapValues(this.config.markets, (m) => m.params),
    )

    // set up exchanges
    this.oracle = new Binance(
      _.mapValues(this.config.oracles, (m) => m.binance as any),
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
      openOrders
        .filter((order) => Number(order.claimable.value) > 0)
        .map((order) => order.id),
      openOrders
        .filter((order) => order.amount.value !== order.filled.value)
        .map((order) => order.id),
      [],
      [],
    )

    await this.sleep(5000)
    this.initialized = true
  }

  async run() {
    if (!this.initialized) {
      throw new Error('MarketMaker is not initialized')
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await Promise.all([
          this.dexSimulator.update(),
          this.oracle.update(),
          this.clober.update(),
        ])
      } catch (e) {
        console.error('Error in update', e)
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
        if ((e as any).toString().includes('transaction is too low')) {
          throw e
        }
      }

      await this.sleep(this.config.fetchIntervalMilliSeconds)
    }
  }

  async getOpenOrders(
    baseCurrency: Currency,
    quoteCurrency: Currency,
  ): Promise<OpenOrder[]> {
    const openOrders = await getOpenOrders({
      chainId: this.chainId,
      userAddress: this.userAddress,
    })
    return openOrders.filter(
      (order) =>
        (isAddressEqual(order.inputCurrency.address, baseCurrency.address) &&
          isAddressEqual(
            order.outputCurrency.address,
            quoteCurrency.address,
          )) ||
        (isAddressEqual(order.inputCurrency.address, quoteCurrency.address) &&
          isAddressEqual(order.outputCurrency.address, baseCurrency.address)),
    )
  }

  async getBalances(
    baseCurrency: Currency,
    quoteCurrency: Currency,
    openOrders: OpenOrder[],
  ): Promise<{
    claimableBase: BigNumber
    cancelableBase: BigNumber
    claimableQuote: BigNumber
    freeQuote: BigNumber
    totalQuote: BigNumber
    cancelableQuote: BigNumber
    totalBase: BigNumber
    freeBase: BigNumber
  }> {
    let balances: { [address: `0x${string}`]: bigint } = {}

    const fetchQueue: Promise<void>[] = []

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
          balances = results.reduce((acc: {}, { result }, index: number) => {
            const address = this.erc20Tokens[index]
            return {
              ...acc,
              [getAddress(address)]: result ?? 0n,
            }
          }, balances)
        }),
    )

    // get eth balance
    fetchQueue.push(
      this.publicClient
        .getBalance({
          address: this.userAddress,
        })
        .then((balance) => {
          balances[zeroAddress] = balance
        }),
    )
    await Promise.all(fetchQueue)

    const freeBase = new BigNumber(
      formatUnits(
        balances[getAddress(baseCurrency.address)],
        baseCurrency.decimals,
      ),
    )
    const freeQuote = new BigNumber(
      formatUnits(
        balances[getAddress(quoteCurrency.address)],
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
    return {
      totalBase,
      freeBase,
      claimableBase,
      cancelableBase,
      totalQuote,
      freeQuote,
      claimableQuote,
      cancelableQuote,
    }
  }

  async marketMaking(market: string, params: Params) {
    const quoteCurrency = findCurrencyBySymbol(
      this.chainId,
      market.split('/')[1],
    )
    const baseCurrency = findCurrencyBySymbol(
      this.chainId,
      market.split('/')[0],
    )
    const openOrders = await this.getOpenOrders(baseCurrency, quoteCurrency)
    const {
      totalBase,
      freeBase,
      claimableBase,
      cancelableBase,
      totalQuote,
      freeQuote,
      claimableQuote,
      cancelableQuote,
    } = await this.getBalances(baseCurrency, quoteCurrency, openOrders)
    const oraclePrice = this.oracle.price(market)
    const onHold = oraclePrice
      .times(params.startBaseAmount)
      .plus(params.startQuoteAmount)
    const onCurrent = oraclePrice.times(totalBase).plus(totalQuote)
    const currentTimestamp = Math.floor(Date.now() / 1000)

    if (
      this.epoch[market] &&
      isNewEpoch({
        oraclePrice,
        minPrice: this.epoch[market][this.epoch[market].length - 1].minPrice,
        maxPrice: this.epoch[market][this.epoch[market].length - 1].maxPrice,
        startTimestamp:
          this.epoch[market][this.epoch[market].length - 1].startTimestamp,
        currentTimestamp,
        maxEpochDurationSeconds: params.maxEpochDurationSeconds,
      })
    ) {
      const {
        startBlock,
        endBlock,
        askSpread,
        bidSpread,
        profit,
        askProfit,
        bidProfit,
        targetAskPrice,
        targetBidPrice,
        askVolume,
        bidVolume,
        tickDiff,
        fromEpochId,
        entropy,
      } = await this.spreadSimulation(market)

      logger(chalk.green, 'Simulation', {
        market,
        startBlock: Number(startBlock),
        endBlock: Number(endBlock),
        epoch: this.epoch[market][this.epoch[market].length - 1].id + 1,
        fromEpochId,
        profit: profit.toString(),
        askProfit: askProfit.toString(),
        bidProfit: bidProfit.toString(),
        targetAskPrice: targetAskPrice.toString(),
        targetBidPrice: targetBidPrice.toString(),
        askSpread,
        bidSpread,
        askVolume: askVolume.toString(),
        bidVolume: bidVolume.toString(),
        tickDiff: tickDiff.toString(),
      })

      const { askTicks, askPrices, bidTicks, bidPrices } =
        buildTickAndPriceArray({
          chainId: this.chainId,
          baseCurrency,
          quoteCurrency,
          oraclePrice,
          askSpread,
          bidSpread,
          orderNum: params.orderNum,
          orderGap: params.orderGap,
        })

      const { minPrice, maxPrice } = calculateMinMaxPrice({
        chainId: this.chainId,
        tickDiff,
        spongeTick: params.spongeTick,
        quoteCurrency,
        baseCurrency,
        askPrices,
        bidPrices,
      })
      if (
        oraclePrice.isLessThan(minPrice) ||
        oraclePrice.isGreaterThan(maxPrice)
      ) {
        throw new Error(
          `Oracle price ${oraclePrice.toString()} is not in the range of minPrice ${minPrice.toString()} and maxPrice ${maxPrice.toString()}`,
        )
      }

      const newEpoch: Epoch = {
        id: this.epoch[market][this.epoch[market].length - 1].id + 1,
        startTimestamp: currentTimestamp,
        askSpread,
        bidSpread,
        minPrice,
        maxPrice,
        oraclePrice,
        entropy,
        tickDiff,
        askTicks,
        askPrices,
        bidTicks,
        bidPrices,
        onHold,
        onCurrent,
        pnl: onCurrent
          .minus(onHold)
          .minus(
            this.epoch[market][this.epoch[market].length - 1].onCurrent.minus(
              this.epoch[market][this.epoch[market].length - 1].onHold,
            ),
          ),
      }

      this.epoch[market].push(newEpoch)

      await logger(chalk.redBright, 'New Epoch', {
        market,
        ...newEpoch,
      })
    }

    // first epoch
    else if (!this.epoch[market]) {
      const { askTicks, askPrices, bidTicks, bidPrices } =
        buildTickAndPriceArray({
          chainId: this.chainId,
          baseCurrency,
          quoteCurrency,
          oraclePrice,
          askSpread: params.defaultAskTickSpread,
          bidSpread: params.defaultBidTickSpread,
          orderNum: params.orderNum,
          orderGap: params.orderGap,
        })

      const { askPrice, bidPrice } = getProposedPrice({ askPrices, bidPrices })
      const newEpoch: Epoch = {
        id: 0,
        startTimestamp: currentTimestamp,
        askSpread: params.defaultAskTickSpread,
        bidSpread: params.defaultBidTickSpread,
        minPrice: bidPrice,
        maxPrice: askPrice,
        oraclePrice,
        entropy: new BigNumber(1),
        tickDiff: 0,
        askTicks,
        askPrices,
        bidTicks,
        bidPrices,
        onHold,
        onCurrent,
        pnl: new BigNumber(0),
      }

      this.epoch[market] = [newEpoch]

      await logger(chalk.redBright, 'New Epoch', {
        market,
        ...newEpoch,
      })
    }

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
      onUniV2: calculateUniV2ImpermanentLoss({
        currentPrice: oraclePrice,
        startPrice: new BigNumber(params.startPrice),
        startBaseAmount: new BigNumber(params.startBaseAmount),
        startQuoteAmount: new BigNumber(params.startQuoteAmount),
      }),
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

    const currentEpoch: Epoch =
      this.epoch[market][this.epoch[market].length - 1]
    const { askOrderSizeInBase, bidOrderSizeInQuote } = calculateOrderSize({
      totalBase,
      totalQuote,
      oraclePrice,
      entropy: currentEpoch.entropy,
      minEntropy: new BigNumber(params.minEntropy),
      balancePercentage: params.balancePercentage,
      minBalancePercentage: params.minBalancePercentage,
    })
    const bidSize = bidOrderSizeInQuote.div(params.orderNum).toFixed()
    const bidMakeParams: MakeParam[] = currentEpoch.bidTicks
      .map((tick) => ({
        id: BigInt(this.clober.bookIds[market][BID]),
        tick,
        quoteAmount: parseUnits(bidSize, quoteCurrency.decimals),
        hookData: zeroHash,
        isBid: true,
        isETH: isAddressEqual(quoteCurrency.address, zeroAddress),
      }))
      // filter out the open order is smaller than the minimum order size
      .filter((params) =>
        new BigNumber(bidSize)
          .times(0.5)
          .gt(
            openOrders
              .filter((o) => o.isBid && o.tick === params.tick)
              .reduce(
                (acc, o) => acc.plus(o.cancelable.value),
                new BigNumber(0),
              ),
          ),
      )
      .map((params) => ({
        ...params,
        quoteAmount: parseUnits(
          new BigNumber(bidSize)
            .minus(
              openOrders
                .filter((o) => o.isBid && o.tick === params.tick)
                .reduce(
                  (acc, o) => acc.plus(o.cancelable.value),
                  new BigNumber(0),
                ),
            )
            .toFixed(),
          quoteCurrency.decimals,
        ),
      }))

    const askSize = askOrderSizeInBase.div(params.orderNum).toFixed()
    const askMakeParams: MakeParam[] = currentEpoch.askTicks
      .map((tick) => ({
        id: BigInt(this.clober.bookIds[market][ASK]),
        tick: Number(tick),
        quoteAmount: parseUnits(askSize, baseCurrency.decimals),
        hookData: zeroHash,
        isBid: false,
        isETH: isAddressEqual(baseCurrency.address, zeroAddress),
      }))
      // filter out the open order is smaller than the minimum order size
      .filter((params) =>
        new BigNumber(askSize)
          .times(0.5)
          .gt(
            openOrders
              .filter((o) => !o.isBid && o.tick === params.tick)
              .reduce(
                (acc, o) => acc.plus(o.cancelable.value),
                new BigNumber(0),
              ),
          ),
      )
      .map((params) => ({
        ...params,
        quoteAmount: parseUnits(
          new BigNumber(askSize)
            .minus(
              openOrders
                .filter((o) => !o.isBid && o.tick === params.tick)
                .reduce(
                  (acc, o) => acc.plus(o.cancelable.value),
                  new BigNumber(0),
                ),
            )
            .toFixed(),
          baseCurrency.decimals,
        ),
      }))

    const bidOrderIdsToClaim = openOrders
      .filter((order) => order.isBid && Number(order.claimable.value) > 0)
      .filter(
        (order) =>
          currentEpoch.bidTicks.find((tick) => tick === order.tick) ===
          undefined,
      )
      .map((order) => ({ id: order.id, isBid: true }))
    const askOrderIdsToClaim = openOrders
      .filter((order) => !order.isBid && Number(order.claimable.value) > 0)
      .filter(
        (order) =>
          currentEpoch.askTicks.find((tick) => tick === order.tick) ===
          undefined,
      )
      .map((order) => ({ id: order.id, isBid: false }))
    const orderIdsToClaim: { id: string; isBid: boolean }[] = [
      ...bidOrderIdsToClaim,
      ...askOrderIdsToClaim,
    ]

    const bidOrderIdsToCancel = openOrders
      .filter(
        (order) => order.isBid && order.amount.value !== order.filled.value,
      )
      // filter out the tick that trying to make
      .filter(
        (order) => !currentEpoch.bidTicks.find((tick) => tick === order.tick),
      )
      .map((order) => ({ id: order.id, isBid: true }))
    const askOrderIdsToCancel = openOrders
      .filter(
        (order) => !order.isBid && order.amount.value !== order.filled.value,
      )
      // filter out the tick that trying to make
      .filter(
        (order) => !currentEpoch.askTicks.find((tick) => tick === order.tick),
      )
      .map((order) => ({ id: order.id, isBid: false }))
    const orderIdsToCancel: { id: string; isBid: boolean }[] = [
      ...bidOrderIdsToCancel,
      ...askOrderIdsToCancel,
    ]

    const humanReadableTargetOrders: {
      ask: [string, string][]
      bid: [string, string][]
    } = {
      ask: askMakeParams.map(({ tick }) => [
        getMarketPrice({
          marketQuoteCurrency: quoteCurrency,
          marketBaseCurrency: baseCurrency,
          askTick: BigInt(tick),
        }),
        askSize,
      ]),
      bid: bidMakeParams.map(({ tick }) => [
        getMarketPrice({
          marketQuoteCurrency: quoteCurrency,
          marketBaseCurrency: baseCurrency,
          bidTick: BigInt(tick),
        }),
        bidSize,
      ]),
    }

    await logger(chalk.redBright, 'Execute Detail', {
      market,
      orderIdsToClaim,
      claimBidOrderLength: orderIdsToClaim.filter((o) => o.isBid).length,
      claimAskOrderLength: orderIdsToClaim.filter((o) => !o.isBid).length,
      orderIdsToCancel,
      cancelBidOrderLength: orderIdsToCancel.filter((o) => o.isBid).length,
      cancelAskOrderLength: orderIdsToCancel.filter((o) => !o.isBid).length,
      askSpread: currentEpoch.askSpread,
      bidSpread: currentEpoch.bidSpread,
      askSize,
      bidSize,
      targetOrders: humanReadableTargetOrders,
      targetBidOrderLength: humanReadableTargetOrders.bid.length,
      targetAskOrderLength: humanReadableTargetOrders.ask.length,
      lowestAsk:
        humanReadableTargetOrders.ask.sort(
          (a, b) => Number(a[0]) - Number(b[0]),
        )[0]?.[0] || '-',
      oraclePrice: oraclePrice.toString(),
      highestBid:
        humanReadableTargetOrders.bid.sort(
          (a, b) => Number(b[0]) - Number(a[0]),
        )[0]?.[0] || '-',
      askOrderSizeInBase,
      bidOrderSizeInQuote,
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
    const args = {
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
        2n ** 64n - 1n,
      ],
      value: [...bidMakeParams, ...askMakeParams]
        .filter((p) => p.isETH)
        .reduce((acc: bigint, { quoteAmount }) => acc + quoteAmount, 0n),
      gasPrice,
    } as any
    const calldata = encodeFunctionData({
      abi: args.abi,
      functionName: args.functionName,
      args: args.args,
    })
    if (this.lock[calldata]) {
      return
    }

    this.lock[calldata] = true
    try {
      const { request } = await this.publicClient.simulateContract(args)
      const hash = await this.walletClient.writeContract({
        account: this.walletClient.account!,
        ...request,
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
    } catch (e) {
      console.error('Error in execute', e)
      throw e
    } finally {
      this.lock[calldata] = false
      await this.sleep(5000)
    }
  }

  async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async spreadSimulation(market: string): Promise<{
    startBlock: bigint
    endBlock: bigint
    askSpread: number
    bidSpread: number
    profit: BigNumber
    askProfit: BigNumber
    bidProfit: BigNumber
    targetAskPrice: BigNumber
    targetBidPrice: BigNumber
    askVolume: BigNumber
    bidVolume: BigNumber
    tickDiff: number
    fromEpochId: number
    entropy: BigNumber
  }> {
    const endTimestamp = Math.floor(Date.now() / 1000)
    for (let i = this.epoch[market].length - 1; i >= 0; i--) {
      const [startBlock, endBlock] = await Promise.all([
        convertTimestampToBlockNumber(
          this.chainId === arbitrumSepolia.id ? base.id : this.chainId,
          this.epoch[market][i].startTimestamp,
        ),
        convertTimestampToBlockNumber(
          this.chainId === arbitrumSepolia.id ? base.id : this.chainId,
          endTimestamp,
        ),
      ])
      const {
        askSpread,
        bidSpread,
        profit,
        askProfit,
        bidProfit,
        targetAskPrice,
        targetBidPrice,
        askVolume,
        bidVolume,
        tickDiff,
        entropy,
      } = this.dexSimulator.findSpread(
        market,
        startBlock,
        endBlock,
        this.epoch[market][i].oraclePrice,
      )

      if (profit.isGreaterThan(0) || i === 0) {
        return {
          startBlock,
          endBlock,
          askSpread,
          bidSpread,
          profit,
          askProfit,
          bidProfit,
          targetAskPrice,
          targetBidPrice,
          askVolume,
          bidVolume,
          tickDiff,
          fromEpochId: this.epoch[market][i].id,
          entropy,
        }
      }
    }
    throw new Error('Should not reach here')
  }
}

import * as fs from 'fs'
import * as path from 'path'

import _ from 'lodash'
import * as yaml from 'yaml'
import {
  approveERC20,
  CHAIN_IDS,
  getContractAddresses,
  getOpenOrders,
  type OpenOrder,
  setApprovalOfOpenOrdersForAll,
  getPriceNeighborhood,
  type Currency,
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
import { arbitrumSepolia, base } from 'viem/chains'

import { logger, slackClient } from '../utils/logger.ts'
import { CHAIN_MAP } from '../constants/chain.ts'
import { ERC20_PERMIT_ABI } from '../abis/@openzeppelin/erc20-permit-abi.ts'
import {
  findCurrencyByAddress,
  findCurrencyBySymbol,
} from '../utils/currency.ts'
import { getGasPrice, waitTransaction } from '../utils/transaction.ts'
import {
  convertTimestampToBlockNumber,
  getDeadlineTimestampInSeconds,
} from '../utils/time.ts'
import { Action } from '../constants/action.ts'
import {
  CANCEL_ORDER_PARAMS_ABI,
  CLAIM_ORDER_PARAMS_ABI,
  MAKE_ORDER_PARAMS_ABI,
} from '../abis/core/params-abi.ts'
import { CONTROLLER_ABI } from '../abis/core/controller-abi.ts'
import { getMarketPrice } from '../utils/tick.ts'
import BigNumber from '../utils/bignumber.ts'

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
  openOrders: OpenOrder[] = []
  balances: { [address: `0x${string}`]: bigint } = {}
  epoch: { [market: string]: Epoch[] } = {}
  private initialized = false

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
          this.dexSimulator.update(),
          this.oracle.update(),
          this.clober.update(),
          this.update(),
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
      }

      await this.sleep(this.config.fetchIntervalMilliSeconds)
    }
  }

  buildTickAndPriceArray(
    baseCurrency: Currency,
    quoteCurrency: Currency,
    oraclePrice: BigNumber,
    askSpread: number,
    bidSpread: number,
    orderNum: number,
    orderGap: number,
  ): {
    askTicks: number[]
    askPrices: BigNumber[]
    bidTicks: number[]
    bidPrices: BigNumber[]
    minPrice: BigNumber
    maxPrice: BigNumber
  } {
    const {
      normal: {
        now: { tick: oraclePriceBidBookTick },
      },
      inverted: {
        now: { tick: oraclePriceAskBookTick },
      },
    } = getPriceNeighborhood({
      chainId: this.chainId,
      price: oraclePrice.toString(),
      currency0: quoteCurrency,
      currency1: baseCurrency,
    })

    const askTicks = Array.from(
      { length: orderNum },
      (_, i) => oraclePriceAskBookTick - BigInt(askSpread + orderGap * i),
    )
    const askPrices = askTicks
      .map((tick) =>
        getMarketPrice({
          marketQuoteCurrency: quoteCurrency,
          marketBaseCurrency: baseCurrency,
          askTick: tick,
        }),
      )
      .map((price) => new BigNumber(price))

    const bidTicks = Array.from(
      { length: orderNum },
      (_, i) => oraclePriceBidBookTick - BigInt(bidSpread + orderGap * i),
    )
    const bidPrices = bidTicks
      .map((tick) =>
        getMarketPrice({
          marketQuoteCurrency: quoteCurrency,
          marketBaseCurrency: baseCurrency,
          bidTick: tick,
        }),
      )
      .map((price) => new BigNumber(price))

    return {
      askTicks: askTicks.map((tick) => Number(tick)),
      askPrices,
      bidTicks: bidTicks.map((tick) => Number(tick)),
      bidPrices,
      minPrice: bidPrices
        .reduce((acc, price) => acc.plus(price), new BigNumber(0))
        .div(bidPrices.length),
      maxPrice: askPrices
        .reduce((acc, price) => acc.plus(price), new BigNumber(0))
        .div(askPrices.length),
    }
  }

  getOpenOrders(baseCurrency: Currency, quoteCurrency: Currency): OpenOrder[] {
    return this.openOrders.filter(
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

  getBalances(baseCurrency: Currency, quoteCurrency: Currency) {
    const openOrders = this.getOpenOrders(baseCurrency, quoteCurrency)
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

  getMoveOraclePrice(
    quoteCurrency: Currency,
    baseCurrency: Currency,
    currentEpoch: Epoch,
    currentOraclePrice: BigNumber,
  ) {
    const {
      normal: {
        now: { tick: oraclePriceBidBookTick },
      },
      inverted: {
        now: { tick: oraclePriceAskBookTick },
      },
    } = getPriceNeighborhood({
      chainId: this.chainId,
      price: currentOraclePrice.toString(),
      currency0: quoteCurrency,
      currency1: baseCurrency,
    })
    if (currentEpoch.askSpread < 0) {
      const weight =
        Math.abs(currentEpoch.askSpread) /
        (Math.abs(currentEpoch.askSpread) + Math.abs(currentEpoch.bidSpread))
      const weightedMeanSpread = Math.floor(
        (currentEpoch.askSpread + currentEpoch.bidSpread) * weight,
      )
      return new BigNumber(
        getMarketPrice({
          marketQuoteCurrency: quoteCurrency,
          marketBaseCurrency: baseCurrency,
          askTick:
            oraclePriceAskBookTick -
            BigInt(currentEpoch.askSpread) +
            BigInt(weightedMeanSpread),
        }),
      )
    }
    if (currentEpoch.bidSpread < 0) {
      const weight =
        Math.abs(currentEpoch.bidSpread) /
        (Math.abs(currentEpoch.askSpread) + Math.abs(currentEpoch.bidSpread))
      const weightedMeanSpread = Math.floor(
        (currentEpoch.askSpread + currentEpoch.bidSpread) * weight,
      )
      return new BigNumber(
        getMarketPrice({
          marketQuoteCurrency: quoteCurrency,
          marketBaseCurrency: baseCurrency,
          bidTick:
            oraclePriceBidBookTick -
            BigInt(currentEpoch.bidSpread) +
            BigInt(weightedMeanSpread),
        }),
      )
    }
    return currentOraclePrice
  }

  isNewEpoch(
    quoteCurrency: Currency,
    baseCurrency: Currency,
    currentEpoch: Epoch,
    currentOraclePrice: BigNumber,
  ): boolean {
    return (
      this.getMoveOraclePrice(
        quoteCurrency,
        baseCurrency,
        currentEpoch,
        currentOraclePrice,
      ).isLessThan(currentEpoch.minPrice) ||
      this.getMoveOraclePrice(
        quoteCurrency,
        baseCurrency,
        currentEpoch,
        currentOraclePrice,
      ).isGreaterThan(currentEpoch.maxPrice)
    )
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
    const oraclePrice = this.oracle.price(market)

    if (
      this.epoch[market] &&
      this.isNewEpoch(
        quoteCurrency,
        baseCurrency,
        this.epoch[market][this.epoch[market].length - 1],
        oraclePrice,
      )
    ) {
      const timestamp = Math.floor(Date.now() / 1000)
      const [startBlock, endBlock] = await Promise.all([
        convertTimestampToBlockNumber(
          this.chainId === arbitrumSepolia.id ? base.id : this.chainId,
          this.epoch[market][this.epoch[market].length - 1].startTimestamp,
        ),
        convertTimestampToBlockNumber(
          this.chainId === arbitrumSepolia.id ? base.id : this.chainId,
          timestamp,
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
      } = this.dexSimulator.findSpread(
        market,
        startBlock,
        endBlock,
        this.epoch[market][this.epoch[market].length - 1].oraclePrice,
      )

      logger(chalk.green, 'Simulation', {
        market,
        startBlock: Number(startBlock),
        endBlock: Number(endBlock),
        epoch: this.epoch[market][this.epoch[market].length - 1].id,
        oraclePrice:
          this.epoch[market][
            this.epoch[market].length - 1
          ].oraclePrice.toString(),
        profit: profit.toString(),
        askProfit: askProfit.toString(),
        bidProfit: bidProfit.toString(),
        targetAskPrice: targetAskPrice.toString(),
        targetBidPrice: targetBidPrice.toString(),
        askSpread,
        bidSpread,
        askVolume: askVolume.toString(),
        bidVolume: bidVolume.toString(),
      })

      const { askTicks, askPrices, bidTicks, bidPrices, minPrice, maxPrice } =
        this.buildTickAndPriceArray(
          baseCurrency,
          quoteCurrency,
          oraclePrice,
          askSpread,
          bidSpread,
          params.orderNum,
          params.orderGap,
        )

      const newEpoch: Epoch = {
        id: this.epoch[market][this.epoch[market].length - 1].id + 1,
        startTimestamp: timestamp,
        askSpread,
        bidSpread,
        minPrice,
        maxPrice,
        oraclePrice,
        movedOraclePrice: this.getMoveOraclePrice(
          quoteCurrency,
          baseCurrency,
          this.epoch[market][this.epoch[market].length - 1],
          oraclePrice,
        ),
        askTicks,
        askPrices,
        bidTicks,
        bidPrices,
      }

      this.epoch[market].push(newEpoch)

      await logger(chalk.redBright, 'New Epoch', {
        market,
        ...newEpoch,
      })
    }

    // first epoch
    else if (!this.epoch[market]) {
      const { askTicks, askPrices, bidTicks, bidPrices, minPrice, maxPrice } =
        this.buildTickAndPriceArray(
          baseCurrency,
          quoteCurrency,
          oraclePrice,
          params.defaultAskTickSpread,
          params.defaultBidTickSpread,
          params.orderNum,
          params.orderGap,
        )

      const newEpoch: Epoch = {
        id: 0,
        startTimestamp: Math.floor(Date.now() / 1000),
        askSpread: params.defaultAskTickSpread,
        bidSpread: params.defaultBidTickSpread,
        minPrice,
        maxPrice,
        oraclePrice,
        movedOraclePrice: oraclePrice,
        askTicks,
        askPrices,
        bidTicks,
        bidPrices,
      }

      this.epoch[market] = [newEpoch]

      await logger(chalk.redBright, 'New Epoch', {
        market,
        ...newEpoch,
      })
    }

    const openOrders = this.getOpenOrders(baseCurrency, quoteCurrency)
    const {
      totalBase,
      freeBase,
      claimableBase,
      cancelableBase,
      totalQuote,
      freeQuote,
      claimableQuote,
      cancelableQuote,
    } = this.getBalances(baseCurrency, quoteCurrency)

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

    const currentEpoch: Epoch =
      this.epoch[market][this.epoch[market].length - 1]
    const bidSize = totalQuote
      .times(params.balancePercentage / 100)
      .div(params.orderNum)
      .toFixed()
    const bidMakeParams: MakeParam[] = currentEpoch.bidTicks
      .map((tick) => ({
        id: BigInt(this.clober.bookIds[market][BID]),
        tick,
        quoteAmount: parseUnits(bidSize, quoteCurrency.decimals),
        hookData: zeroHash,
        isBid: true,
        isETH: isAddressEqual(quoteCurrency.address, zeroAddress),
      }))
      // filter out the tick that already has open orders
      .filter(
        (params) =>
          openOrders
            .filter((o) => o.isBid)
            .find((o) => o.tick === params.tick) === undefined,
      )

    const askSize = totalBase
      .times(params.balancePercentage / 100)
      .div(params.orderNum)
      .toFixed()
    const askMakeParams: MakeParam[] = currentEpoch.askTicks
      .map((tick) => ({
        id: BigInt(this.clober.bookIds[market][ASK]),
        tick: Number(tick),
        quoteAmount: parseUnits(askSize, baseCurrency.decimals),
        hookData: zeroHash,
        isBid: false,
        isETH: isAddressEqual(baseCurrency.address, zeroAddress),
      }))
      // filter out the tick that already has open orders
      .filter(
        (params) =>
          openOrders
            .filter((o) => !o.isBid)
            .find((o) => o.tick === params.tick) === undefined,
      )

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
      gas: 15_000_000n,
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
}

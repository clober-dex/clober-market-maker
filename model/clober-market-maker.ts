import * as fs from 'fs'
import * as path from 'path'

import _ from 'lodash'
import * as yaml from 'yaml'
import {
  CHAIN_IDS,
  getOpenOrders,
  approveERC20,
  setApprovalOfOpenOrdersForAll,
  getTick,
  type OpenOrder,
  cancelOrders,
  claimOrders,
} from '@clober/v2-sdk'
import type { PublicClient, WalletClient } from 'viem'
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  zeroAddress,
} from 'viem'
import chalk from 'chalk'
import { privateKeyToAccount } from 'viem/accounts'
import { eip712WalletActions } from 'viem/zksync'
import BigNumber from 'bignumber.js'

import { logger } from '../utils/logger.ts'
import { CHAIN_MAP } from '../constants/chain.ts'
import { ERC20_PERMIT_ABI } from '../abis/@openzeppelin/erc20-permit-abi.ts'
import { findCurrency } from '../utils/currency.ts'
import { getGasPrice, waitTransaction } from '../utils/transaction.ts'

import { Binance } from './binance.ts'
import { Clober } from './clober.ts'
import type { Config, Params } from './config.ts'

const BID = 0
const ASK = 1

export class CloberMarketMaker {
  private initialized = false
  chainId: CHAIN_IDS
  userAddress: `0x${string}`
  publicClient: PublicClient
  walletClient: WalletClient
  config: Config
  erc20Tokens: `0x${string}`[] = []

  // define exchanges
  binance: Binance
  clober: Clober

  // variables state
  openOrders: OpenOrder[] = []
  balances: { [address: `0x${string}`]: bigint } = {}

  constructor(configPath?: string) {
    configPath = configPath ?? path.join(__dirname, '../config.yaml')
    this.config = yaml.parse(fs.readFileSync(configPath, 'utf8')) as Config
    this.chainId = Number(process.env.CHAIN_ID) as CHAIN_IDS

    this.publicClient = createPublicClient({
      chain: CHAIN_MAP[this.chainId],
      transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
    })
    if (this.chainId === CHAIN_IDS.ZKSYNC_SEPOLIA) {
      this.publicClient = this.publicClient.extend(eip712WalletActions())
    }

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
    this.binance = new Binance(
      _.mapValues(this.config.markets, (m) => m.binance),
    )
    this.clober = new Clober(
      this.chainId,
      _.mapValues(this.config.markets, (m) => m.clober),
    )
    this.erc20Tokens = Object.values(
      _.mapValues(this.config.markets, (m) => m.clober),
    )
      .map((m) => [
        getAddress(findCurrency(this.chainId, m.quote).address),
        getAddress(findCurrency(this.chainId, m.base).address),
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
    await this.cancelOrders(openOrders.map((order) => order.id))

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
            {} as { [address: `0x${string}`]: bigint },
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

    logger(chalk.magenta, 'market maker updated', {
      second: (end - start) / 1000,
      openOrders: this.openOrders.length,
      balance: Object.entries(this.balances).map(([address, balance]) => ({
        address,
        balance: balance.toString(),
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
          this.binance.update(),
          this.clober.update(),
          this.update(),
        ])
      } catch (e) {
        console.error('Error in update', e)
      }

      const marketMakerTasks: Promise<void>[] = []
      for (const [market, { params }] of Object.entries(this.config.markets)) {
        marketMakerTasks.push(this.marketMaking(market, params))
      }
      await Promise.all(marketMakerTasks)

      await this.sleep(this.config.fetchIntervalMilliSeconds)
    }
  }

  async marketMaking(market: string, params: Params) {
    const [lowestAsk, highestBid, oraclePrice] = [
      this.clober.lowestAsk(market),
      this.clober.highestBid(market),
      this.binance.price(market),
    ]
    // Skip when the oracle price is in the spread
    if (
      lowestAsk &&
      highestBid &&
      oraclePrice.isGreaterThan(highestBid) &&
      oraclePrice.isLessThan(lowestAsk)
      // highestBid < oraclePrice && oraclePrice < lowestAsk
    ) {
      logger(chalk.red, 'Skip making orders', {
        market,
        lowestAsk: lowestAsk.toString(),
        highestBid: highestBid.toString(),
        oraclePrice: oraclePrice.toString(),
      })
      return
    }

    const [base, quote] = market.split('/')
    const openOrders = this.openOrders.filter(
      (order) =>
        (order.inputCurrency.symbol === base &&
          order.outputCurrency.symbol === quote) ||
        (order.inputCurrency.symbol === quote &&
          order.outputCurrency.symbol === base),
    )

    // 1. calculate skew (sum of amount of open orders - defaultBaseBalance) / deltaLimit
    let skew = openOrders
      .reduce((acc, order) => acc.plus(order.amount.value), new BigNumber(0))
      .minus(params.defaultBaseBalance)
      .div(params.deltaLimit)
      .toNumber()
    if (skew > 1) {
      skew = 1
    } else if (skew < -1) {
      skew = -1
    }

    /*
    if base balance = default + deltaLimit (skew = 1) => ask spread = min, bid spread = max
    if base balance = default - deltaLimit (skew = -1) => ask spread = max, bid spread = min
    */
    const askSpread = Math.round(
      (params.maxSpread - params.minSpread) * 0.5 * (skew + 1) +
        params.minSpread,
    )
    const bidSpread = Math.round(
      params.maxSpread + params.minSpread - askSpread,
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
    const targetOrders: [
      { [tick: number]: number },
      { [tick: number]: number },
    ] = [{}, {}]
    for (let i = 0; i < params.orderNum; i++) {
      const oracleTick = getTick({
        chainId: this.chainId,
        inputCurrency: findCurrency(this.chainId, base),
        outputCurrency: findCurrency(this.chainId, quote),
        price: oraclePrice.toString(),
      })
      const priceIndex = oracleTick + BigInt(askSpread + params.orderGap * i)
      targetOrders[ASK][Number(priceIndex)] = askSize
    }
    for (let i = 0; i < params.orderNum; i++) {
      const oracleTick = getTick({
        chainId: this.chainId,
        inputCurrency: findCurrency(this.chainId, quote),
        outputCurrency: findCurrency(this.chainId, base),
        price: oraclePrice.toString(),
      })
      const priceIndex = oracleTick - BigInt(bidSpread - params.orderGap * i)
      targetOrders[BID][Number(priceIndex)] = bidSize
    }

    // 4. calculate orders to cancel & claim
    const orderIdsToClaim: string[] = []
    const orderIdsToCancel: string[] = []
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
            if (order.amount.value === order.filled.value) {
              // fully filled
              orderIdsToClaim.push(order.id)
            } else if (
              Math.abs(openAmount) >=
              Math.abs(targetOrders[side][+id]) + params.minOrderSize
            ) {
              // don't need to make new order
              break
            }
            targetOrders[side][+id] -= openAmount
          }
          if (targetOrders[side][+id] < params.minOrderSize) {
            // cutting off small orders
            delete targetOrders[side][+id]
          }
        }
        orderIdsToCancel.push(
          ..._.map(
            currentOpenOrders[side][+id].slice(cancelIndex),
            (order) => order.id,
          ),
        )
      }
    }

    // TODO: build 1 tx
    console.log({ orderIdsToClaim, orderIdsToCancel })
    console.log({ targetOrders })
  }

  async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async cancelOrders(ids: string[]) {
    if (ids.length > 0) {
      const { transaction } = await cancelOrders({
        chainId: this.chainId,
        userAddress: this.userAddress,
        ids,
      })
      const gasPrice = await getGasPrice(
        this.publicClient,
        this.config.gasMultiplier,
      )
      const hash = await this.walletClient.sendTransaction({
        ...transaction,
        gasPrice,
        account: this.userAddress,
        chain: CHAIN_MAP[this.chainId],
      })
      await waitTransaction(
        'Cancel Orders',
        {
          ids,
        },
        this.publicClient,
        hash,
      )
    }
  }

  async claimOrders(ids: string[]) {
    if (ids.length > 0) {
      const { transaction } = await claimOrders({
        chainId: this.chainId,
        userAddress: this.userAddress,
        ids,
      })
      const gasPrice = await getGasPrice(
        this.publicClient,
        this.config.gasMultiplier,
      )
      const hash = await this.walletClient.sendTransaction({
        ...transaction,
        gasPrice,
        account: this.userAddress,
        chain: CHAIN_MAP[this.chainId],
      })
      await waitTransaction(
        'Claim Orders',
        {
          ids,
        },
        this.publicClient,
        hash,
      )
    }
  }
}

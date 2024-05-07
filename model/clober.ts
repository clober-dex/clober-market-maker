import {
  createPublicClient,
  getAddress,
  http,
  isAddressEqual,
  type PublicClient,
  type WalletClient,
  zeroAddress,
} from 'viem'
import {
  approveERC20,
  cancelOrders,
  CHAIN_IDS,
  getMarket,
  getOpenOrders,
  type OpenOrder,
  setApprovalOfOpenOrdersForAll,
} from '@clober/v2-sdk'
import { eip712WalletActions } from 'viem/zksync'
import chalk from 'chalk'

import { findCurrency } from '../utils/currency.ts'
import { CHAIN_MAP } from '../constants/chain.ts'
import { ERC20_PERMIT_ABI } from '../abis/@openzeppelin/erc20-permit-abi.ts'
import { logger } from '../utils/logger.ts'
import { getGasPrice, waitTransaction } from '../utils/transaction.ts'

import { type OrderBook } from './order-book.ts'
import type { Config } from './config.ts'
import type { Exchange } from './exchange.ts'

type Market = {
  quote: `0x${string}`
  base: `0x${string}`
}

export class Clober implements Exchange {
  markets: { [id: string]: Market }
  orderBooks: { [id: string]: OrderBook } = {}

  chainId: CHAIN_IDS
  userAddress: `0x${string}`
  publicClient: PublicClient
  walletClient: WalletClient
  openOrders: OpenOrder[] = []
  balances: { [address: `0x${string}`]: bigint } = {}
  config: Config
  erc20Tokens: `0x${string}`[] = []

  constructor(chainId: CHAIN_IDS, walletClient: WalletClient, config: Config) {
    this.chainId = chainId
    this.publicClient = createPublicClient({
      chain: CHAIN_MAP[chainId],
      transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
    })
    if (chainId === CHAIN_IDS.ZKSYNC_SEPOLIA) {
      this.publicClient = this.publicClient!.extend(eip712WalletActions())
    }

    this.walletClient = walletClient
    if (!this.walletClient.account) {
      throw new Error('WalletClient must have an account')
    }
    this.userAddress = getAddress(this.walletClient.account.address)

    this.markets = Object.fromEntries(
      Object.entries(config.markets).map(
        ([
          id,
          {
            clober: { quote, base },
          },
        ]) => [
          id,
          {
            quote: getAddress(findCurrency(this.chainId, quote).address),
            base: getAddress(findCurrency(this.chainId, base).address),
          },
        ],
      ),
    )
    this.erc20Tokens = Object.values(this.markets)
      .map((market) => [market.quote, market.base])
      .flat()
      .filter(
        (address, index, self) =>
          self.findIndex((a) => isAddressEqual(a, address)) === index,
      )
      .filter((address) => !isAddressEqual(address, zeroAddress))
    this.config = config
  }

  async init() {
    // 1. approve all tokens
    for (const address of this.erc20Tokens) {
      const hash = await approveERC20({
        chainId: this.chainId,
        walletClient: this.walletClient,
        token: '0xfb2c2196831deeb8311d2cb4b646b94ed5ecf684',
        amount:
          '115792089237316195423570985008687907853269984665640564039457.584007913129639935',
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
    await this.cancelAll()
  }

  async update() {
    const fetchQueue: Promise<void>[] = []
    const start = performance.now()

    // 1. get order book
    for (const [id, market] of Object.entries(this.markets)) {
      fetchQueue.push(
        getMarket({
          chainId: this.chainId,
          token0: market.base,
          token1: market.quote,
        }).then(({ bids, asks }) => {
          this.orderBooks[id] = <OrderBook>{
            bids: bids.map((bid) => [+bid.price, +bid.baseAmount]),
            asks: asks.map((ask) => [+ask.price, +ask.baseAmount]),
          }
        }),
      )
    }

    // 2. get open orders
    fetchQueue.push(
      getOpenOrders({
        chainId: this.chainId,
        userAddress: this.userAddress,
      }).then((openOrder) => {
        this.openOrders = openOrder
      }),
    )

    // 3. get balances
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

    // 4. get eth balance
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

    logger(chalk.yellow, 'Clober updated', {
      second: (end - start) / 1000,
      markets: Object.keys(this.markets),
      openOrders: this.openOrders.length,
      balance: Object.entries(this.balances).map(([address, balance]) => ({
        address,
        balance: balance.toString(),
      })),
    })
  }

  async cancelAll() {
    const openOrders = await getOpenOrders({
      chainId: this.chainId,
      userAddress: this.userAddress,
    })
    if (openOrders.length > 0) {
      const { transaction } = await cancelOrders({
        chainId: this.chainId,
        userAddress: this.userAddress,
        ids: openOrders.map((order) => order.id),
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
        'Cancel All Orders',
        {
          ids: openOrders.map((order) => order.id),
        },
        this.publicClient,
        hash,
      )
    }
  }
}

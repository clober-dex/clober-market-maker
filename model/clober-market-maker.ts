import * as fs from 'fs'
import * as path from 'path'

import _ from 'lodash'
import * as yaml from 'yaml'
import {
  CHAIN_IDS,
  getOpenOrders,
  approveERC20,
  setApprovalOfOpenOrdersForAll,
  type OpenOrder,
  cancelOrders,
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

import { logger } from '../utils/logger.ts'
import { CHAIN_MAP } from '../constants/chain.ts'
import { ERC20_PERMIT_ABI } from '../abis/@openzeppelin/erc20-permit-abi.ts'
import { findCurrency } from '../utils/currency.ts'
import { getGasPrice, waitTransaction } from '../utils/transaction.ts'

import { Binance } from './binance.ts'
import { Clober } from './clober.ts'
import type { Config } from './config.ts'

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
    await this.cancelAll()

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

      await this.sleep(this.config.fetchIntervalMilliSeconds)
    }
  }

  async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
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

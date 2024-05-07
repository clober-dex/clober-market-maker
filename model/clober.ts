import { createPublicClient, getAddress, http, type PublicClient } from 'viem'
import { CHAIN_IDS, getMarket } from '@clober/v2-sdk'
import { eip712WalletActions } from 'viem/zksync'
import chalk from 'chalk'

import { CHAIN_MAP } from '../constants/chain.ts'
import { logger } from '../utils/logger.ts'
import { findCurrency } from '../utils/currency.ts'

import { type OrderBook } from './order-book.ts'
import type { Exchange } from './exchange.ts'
import type { Market } from './market.ts'

export class Clober implements Exchange {
  markets: { [id: string]: Market }
  orderBooks: { [id: string]: OrderBook } = {}

  chainId: CHAIN_IDS
  publicClient: PublicClient

  constructor(chainId: CHAIN_IDS, markets: { [id: string]: Market }) {
    this.chainId = chainId
    this.publicClient = createPublicClient({
      chain: CHAIN_MAP[chainId],
      transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
    })
    if (chainId === CHAIN_IDS.ZKSYNC_SEPOLIA) {
      this.publicClient = this.publicClient!.extend(eip712WalletActions())
    }
    this.markets = markets
  }

  async update() {
    const fetchQueue: Promise<void>[] = []
    const start = performance.now()
    for (const [id, { quote, base }] of Object.entries(this.markets)) {
      fetchQueue.push(
        getMarket({
          chainId: this.chainId,
          token0: getAddress(findCurrency(this.chainId, quote).address),
          token1: getAddress(findCurrency(this.chainId, base).address),
        }).then(({ bids, asks }) => {
          this.orderBooks[id] = <OrderBook>{
            bids: bids.map((bid) => [+bid.price, +bid.baseAmount]),
            asks: asks.map((ask) => [+ask.price, +ask.baseAmount]),
          }
        }),
      )
    }

    await Promise.all(fetchQueue)
    const end = performance.now()

    logger(chalk.yellow, 'Clober orderbook updated', {
      second: (end - start) / 1000,
      markets: Object.keys(this.markets),
    })
  }
}

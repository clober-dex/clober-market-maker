import { binance, pro as ccxt } from 'ccxt'
import chalk from 'chalk'
import BigNumber from 'bignumber.js'

import { logger } from '../utils/logger.ts'

import type { OrderBook } from './order-book.ts'
import type { Exchange } from './exchange.ts'
import type { Market } from './market.ts'

export class Binance implements Exchange {
  markets: { [id: string]: Market }
  orderBooks: { [id: string]: OrderBook } = {}

  public api: binance

  constructor(markets: { [id: string]: Market }) {
    this.api = new ccxt.binance({
      enableRateLimit: true,
    })
    this.markets = markets
  }

  async update() {
    const fetchQueue: Promise<void>[] = []
    const start = performance.now()
    for (const [id, { quote, base }] of Object.entries(this.markets)) {
      fetchQueue.push(
        this.api.watchOrderBook(`${base}/${quote}`).then((data) => {
          this.orderBooks[id] = <OrderBook>data
        }),
      )
    }
    await Promise.all(fetchQueue)
    const end = performance.now()

    await logger(chalk.blue, 'Binance orderbook updated', {
      second: ((end - start) / 1000).toFixed(2),
      markets: Object.keys(this.markets),
      prices: Object.entries(this.markets).map(([id]) => ({
        id,
        highestBid: this.highestBid(id),
        price: this.price(id).toString(),
        lowestAsk: this.lowestAsk(id),
      })),
    })
  }

  price(id: string): BigNumber {
    const orderBook = this.orderBooks[id]
    return new BigNumber(orderBook.bids[0][0]).plus(orderBook.asks[0][0]).div(2)
  }

  highestBid(id: string): number {
    return this.orderBooks[id].bids[0][0]
  }

  lowestAsk(id: string): number {
    return this.orderBooks[id].asks[0][0]
  }
}

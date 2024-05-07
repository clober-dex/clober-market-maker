import { binance, pro as ccxt } from 'ccxt'
import chalk from 'chalk'

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

    logger(chalk.blue, 'Binance orderbook updated', {
      second: (end - start) / 1000,
      markets: Object.keys(this.markets),
    })
  }
}

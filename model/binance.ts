import { binance, pro as ccxt } from 'ccxt'
import chalk from 'chalk'

import { logger } from '../utils/logger.ts'

import type { OrderBook } from './order-book.ts'
import type { Exchange } from './exchange.ts'

type Market = {
  symbol: string
  reversed: boolean
}

export class Binance implements Exchange {
  markets: { [id: string]: Market }
  orderBooks: { [id: string]: OrderBook } = {}

  public api: binance

  constructor(markets: {
    [id: string]: {
      symbol: string
    }
  }) {
    this.api = new ccxt.binance({
      enableRateLimit: true,
    })
    this.markets = Object.fromEntries(
      Object.entries(markets).map(([id, market]) => [
        id,
        {
          symbol: market.symbol,
          reversed: false,
        },
      ]),
    )
  }

  async update() {
    const fetchQueue: Promise<void>[] = []
    const start = performance.now()
    for (const [id, market] of Object.entries(this.markets)) {
      fetchQueue.push(
        this.api.watchOrderBook(market.symbol).then((data) => {
          this.orderBooks[id] = <OrderBook>data
        }),
      )
    }
    await Promise.all(fetchQueue)
    const end = performance.now()

    logger(chalk.blue, 'Binance updated', {
      second: (end - start) / 1000,
      markets: Object.keys(this.markets),
    })
  }

  init(): Promise<void> {
    return Promise.resolve(undefined)
  }
}

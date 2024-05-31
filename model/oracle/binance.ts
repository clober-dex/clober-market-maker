import { binance, pro as ccxt } from 'ccxt'
import chalk from 'chalk'
import { EMA } from 'technicalindicators'

import { logger } from '../../utils/logger.ts'
import BigNumber from '../../utils/bignumber.ts'
import type { Market } from '../market.ts'

import type { Oracle } from './index.ts'

export type BinanceMarket = Market & {
  period: number
  interval: string
}

export class Binance implements Oracle {
  markets: { [id: string]: BinanceMarket }
  prices: { [p: string]: BigNumber } = {}

  public api: binance

  constructor(markets: { [id: string]: BinanceMarket }) {
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
        this.api
          .fetchOHLCV(
            `${base}/${quote}`,
            this.markets[id].interval,
            undefined,
            this.markets[id].period,
          )
          .then((data) => {
            const results = EMA.calculate({
              period: this.markets[id].period,
              values: data.map((d) => Number(d[4])),
            })
            this.prices[id] = new BigNumber(results[results.length - 1])
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
        price: this.price(id).toString(),
      })),
    })
  }

  price(id: string): BigNumber {
    return this.prices[id]
  }
}

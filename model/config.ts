import type { Market } from './market.ts'

export type Config = {
  fetchIntervalMilliSeconds: number
  gasMultiplier: number
  markets: {
    [id: string]: {
      binance: Market
      clober: Market
      params: {
        defaultBaseBalance: number
        deltaLimit: number
        minSpread: number
        maxSpread: number
        orderGap: number
        orderNum: number
        orderSize: number
        minOrderSize: number
      }
    }
  }
}

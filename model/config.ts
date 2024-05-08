import type { Market } from './market.ts'

/**
 * Represents the parameters required for configuring a trading strategy.
 * @typedef Params
 * @property {number} defaultBaseBalance - The expectation of the base balance for trading.
 * @property {number} deltaLimit - The standard deviation base of the base balance for trading.
 * @property {number} minTickSpread - The minimum spread allowed for trading.
 * @property {number} maxTickSpread - The maximum spread allowed for trading.
 * @property {number} orderGap - The order gap for trading.
 * @property {number} orderNum - The number of orders for trading.
 * @property {number} orderSize - The size of each order for trading.
 * @property {number} minOrderSize - The minimum order size for trading.
 */

export type Params = {
  defaultBaseBalance: number
  deltaLimit: number
  minTickSpread: number
  maxTickSpread: number
  orderGap: number
  orderNum: number
  orderSize: number
  minOrderSize: number
}

export type Config = {
  fetchIntervalMilliSeconds: number
  gasMultiplier: number
  markets: {
    [id: string]: {
      binance: Market
      clober: Market
      params: Params
    }
  }
}

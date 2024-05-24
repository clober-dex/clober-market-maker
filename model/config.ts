import type { Market } from './market.ts'

/**
 * Represents the parameters required for configuring a trading strategy.
 * @typedef Params
 * @property {number} deltaLimit - The standard deviation abs(base - quote) limit in dollars for trading.
 * @property {number} minTickSpread - The minimum spread allowed for trading.
 * @property {number} maxTickSpread - The maximum spread allowed for trading.
 * @property {number} orderGap - The order gap for trading.
 * @property {number} orderNum - The number of orders for trading.
 * @property {number} orderSize - The size of each order for trading.
 * @property {number} minOrderSize - The minimum order size for trading.
 * @property {number} startQuoteAmount - The starting quote amount for trading.
 * @property {number} startBaseAmount - The starting base amount for trading.
 */

export type Params = {
  deltaLimit: number
  minTickSpread: number
  maxTickSpread: number
  orderGap: number
  orderNum: number
  orderSize: number
  minOrderSize: number
  startQuoteAmount: number
  startBaseAmount: number
}

export type Config = {
  fetchIntervalMilliSeconds: number
  gasMultiplier: number
  markets: {
    [id: string]: {
      chainlink: Market
      clober: Market
      params: Params
    }
  }
}

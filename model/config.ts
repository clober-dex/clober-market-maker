import type { Market } from './market.ts'

/**
 * Represents the parameters required for configuring a trading strategy.
 * @typedef Params
 * @property {number} defaultBidTickSpread - The default spread for bid orders.
 * @property {number} defaultAskTickSpread - The default spread for ask orders.
 * @property {number} orderGap - The order gap for trading.
 * @property {number} orderNum - The number of orders for trading.
 * @property {number} balancePercentage - The balance percentage for trading.
 * @property {number} startQuoteAmount - The starting quote amount for trading.
 * @property {number} startBaseAmount - The starting base amount for trading.
 */

export type Params = {
  defaultBidTickSpread: number
  defaultAskTickSpread: number
  orderGap: number
  orderNum: number
  balancePercentage: number
  startQuoteAmount: number
  startBaseAmount: number
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

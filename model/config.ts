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
 * @property {number} maxEpochDurationSeconds - The maximum epoch duration in seconds.
 * @property {number} minSpongeTick - The minimum sponge tick for trading.
 * @property {number} maxSpongeTick - The maximum sponge tick for trading.
 */

export type Params = {
  defaultBidTickSpread: number
  defaultAskTickSpread: number
  orderGap: number
  orderNum: number
  balancePercentage: number
  startQuoteAmount: number
  startBaseAmount: number
  maxEpochDurationSeconds: number
  minSpongeTick: number
  maxSpongeTick: number
}

export type Config = {
  fetchIntervalMilliSeconds: number
  gasMultiplier: number
  oracles: {
    [marketId: string]: {
      [subject: string]: Market
    }
  }
  markets: {
    [marketId: string]: {
      clober: Market
      params: Params
    }
  }
}

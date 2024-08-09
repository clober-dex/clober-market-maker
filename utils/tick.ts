import type { CHAIN_IDS, Currency } from '@clober/v2-sdk'
import { getMarketPrice, getPriceNeighborhood } from '@clober/v2-sdk'

import BigNumber from './bignumber.ts'
import { min } from './bigint.ts'

export const getWeightedSpreadAndSpongeDiff = ({
  chainId,
  baseCurrency,
  quoteCurrency,
  askSpread,
  bidSpread,
  totalBase,
  totalQuote,
  currentOraclePrice,
  correctionFactor,
}: {
  chainId: CHAIN_IDS
  baseCurrency: Currency
  quoteCurrency: Currency
  askSpread: number
  bidSpread: number
  totalBase: BigNumber
  totalQuote: BigNumber
  currentOraclePrice: BigNumber
  correctionFactor: BigNumber
}): {
  weightedAskSpread: number
  weightedAskSpongeDiff: BigNumber
  weightedBidSpread: number
  weightedBidSpongeDiff: BigNumber
} => {
  const {
    normal: {
      now: { tick: currentOraclePriceBidBookTick },
    },
    inverted: {
      now: { tick: currentOraclePriceAskBookTick },
    },
  } = getPriceNeighborhood({
    chainId,
    price: currentOraclePrice.toFixed(),
    currency0: quoteCurrency,
    currency1: baseCurrency,
  })

  const currentAskPrice = BigNumber(
    getMarketPrice({
      marketQuoteCurrency: quoteCurrency,
      marketBaseCurrency: baseCurrency,
      askTick: currentOraclePriceAskBookTick - BigInt(askSpread),
    }),
  )
  const currentBidPrice = BigNumber(
    getMarketPrice({
      marketQuoteCurrency: quoteCurrency,
      marketBaseCurrency: baseCurrency,
      bidTick: currentOraclePriceBidBookTick - BigInt(bidSpread),
    }),
  )
  const currentCentralPrice = currentOraclePrice.div(correctionFactor)
  const ethSkew = totalBase.times(currentOraclePrice).div(totalQuote)
  const weightedAskPrice = currentCentralPrice.plus(
    currentAskPrice.minus(currentCentralPrice).div(ethSkew),
  )
  const weightedBidPrice = currentCentralPrice.minus(
    currentCentralPrice.minus(currentBidPrice).times(ethSkew),
  )
  const weightedAskSpongeDiff = weightedAskPrice.minus(currentCentralPrice)
  const weightedBidSpongeDiff = currentCentralPrice.minus(weightedBidPrice)

  const {
    inverted: {
      now: { tick: weightedAskPriceAskBookTick },
    },
  } = getPriceNeighborhood({
    chainId,
    price: weightedAskPrice.toFixed(),
    currency0: quoteCurrency,
    currency1: baseCurrency,
  })
  const {
    normal: {
      now: { tick: weightedBidPriceBidBookTick },
    },
  } = getPriceNeighborhood({
    chainId,
    price: weightedBidPrice.toFixed(),
    currency0: quoteCurrency,
    currency1: baseCurrency,
  })

  return {
    weightedAskSpread: Number(
      currentOraclePriceAskBookTick - weightedAskPriceAskBookTick,
    ),
    weightedAskSpongeDiff,
    weightedBidSpread: Number(
      currentOraclePriceBidBookTick - weightedBidPriceBidBookTick,
    ),
    weightedBidSpongeDiff,
  }
}

export const buildTickAndPriceArray = ({
  chainId,
  baseCurrency,
  quoteCurrency,
  oraclePrice,
  askSpread,
  bidSpread,
  orderNum,
  orderGap,
}: {
  chainId: CHAIN_IDS
  baseCurrency: Currency
  quoteCurrency: Currency
  oraclePrice: BigNumber
  askSpread: number
  bidSpread: number
  orderNum: number
  orderGap: number
}): {
  askTicks: number[]
  askPrices: BigNumber[]
  bidTicks: number[]
  bidPrices: BigNumber[]
} => {
  const {
    normal: {
      now: { tick: oraclePriceBidBookTick },
    },
    inverted: {
      now: { tick: oraclePriceAskBookTick },
    },
  } = getPriceNeighborhood({
    chainId,
    price: oraclePrice.toString(),
    currency0: quoteCurrency,
    currency1: baseCurrency,
  })

  const askTicks = Array.from(
    { length: orderNum },
    (_, i) => oraclePriceAskBookTick - BigInt(askSpread + orderGap * i),
  )
  const askPrices = askTicks
    .map((tick) =>
      getMarketPrice({
        marketQuoteCurrency: quoteCurrency,
        marketBaseCurrency: baseCurrency,
        askTick: tick,
      }),
    )
    .map((price) => new BigNumber(price))

  const bidTicks = Array.from(
    { length: orderNum },
    (_, i) => oraclePriceBidBookTick - BigInt(bidSpread + orderGap * i),
  )
  const bidPrices = bidTicks
    .map((tick) =>
      getMarketPrice({
        marketQuoteCurrency: quoteCurrency,
        marketBaseCurrency: baseCurrency,
        bidTick: tick,
      }),
    )
    .map((price) => new BigNumber(price))

  return {
    askTicks: askTicks.map((tick) => Number(tick)),
    askPrices,
    bidTicks: bidTicks.map((tick) => Number(tick)),
    bidPrices,
  }
}

export const buildProtectedTickAndPriceArray = ({
  chainId,
  baseCurrency,
  quoteCurrency,
  oraclePrice,
  protectedPrice,
  askSpread,
  bidSpread,
  orderNum,
  orderGap,
}: {
  chainId: CHAIN_IDS
  baseCurrency: Currency
  quoteCurrency: Currency
  oraclePrice: BigNumber
  protectedPrice: BigNumber
  askSpread: number
  bidSpread: number
  orderNum: number
  orderGap: number
}): {
  askTicks: number[]
  askPrices: BigNumber[]
  bidTicks: number[]
  bidPrices: BigNumber[]
} => {
  const {
    normal: {
      now: { tick: oraclePriceBidBookTick },
    },
    inverted: {
      now: { tick: oraclePriceAskBookTick },
    },
  } = getPriceNeighborhood({
    chainId,
    price: oraclePrice.toString(),
    currency0: quoteCurrency,
    currency1: baseCurrency,
  })

  const {
    normal: {
      now: { tick: protectedPriceBidBookTick },
    },
    inverted: {
      now: { tick: protectedPriceAskBookTick },
    },
  } = getPriceNeighborhood({
    chainId,
    price: protectedPrice.toString(),
    currency0: quoteCurrency,
    currency1: baseCurrency,
  })

  const askTicks = Array.from(
    { length: orderNum },
    (_, i) =>
      min(
        oraclePriceAskBookTick - BigInt(askSpread),
        protectedPriceAskBookTick,
      ) - BigInt(orderGap * i),
  )
  const askPrices = askTicks
    .map((tick) =>
      getMarketPrice({
        marketQuoteCurrency: quoteCurrency,
        marketBaseCurrency: baseCurrency,
        askTick: tick,
      }),
    )
    .map((price) => new BigNumber(price))

  const bidTicks = Array.from(
    { length: orderNum },
    (_, i) =>
      min(
        oraclePriceBidBookTick - BigInt(bidSpread),
        protectedPriceBidBookTick,
      ) - BigInt(orderGap * i),
  )
  const bidPrices = bidTicks
    .map((tick) =>
      getMarketPrice({
        marketQuoteCurrency: quoteCurrency,
        marketBaseCurrency: baseCurrency,
        bidTick: tick,
      }),
    )
    .map((price) => new BigNumber(price))

  return {
    askTicks: askTicks.map((tick) => Number(tick)),
    askPrices,
    bidTicks: bidTicks.map((tick) => Number(tick)),
    bidPrices,
  }
}

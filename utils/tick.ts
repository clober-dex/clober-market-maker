import type { CHAIN_IDS, Currency } from '@clober/v2-sdk'
import {
  formatPrice,
  getPriceNeighborhood,
  invertPrice,
  toPrice,
} from '@clober/v2-sdk'

import BigNumber from './bignumber.ts'

export const calculateSpongeTick = ({
  previousEpochDuration,
  maxEpochDurationSeconds,
  minSpongeTick,
  maxSpongeTick,
}: {
  previousEpochDuration: number
  maxEpochDurationSeconds: number
  minSpongeTick: number
  maxSpongeTick: number
}): number => {
  return Math.floor(
    minSpongeTick +
      (maxSpongeTick - minSpongeTick) *
        Math.min(previousEpochDuration / maxEpochDurationSeconds, 1),
  )
}

export const buildTickAndPriceArray = ({
  chainId,
  baseCurrency,
  quoteCurrency,
  oraclePrice,
  onChainOraclePrice,
  askSpread,
  bidSpread,
  orderNum,
  orderGap,
  useBidPremium,
  useAskPremium,
}: {
  chainId: CHAIN_IDS
  baseCurrency: Currency
  quoteCurrency: Currency
  oraclePrice: BigNumber
  onChainOraclePrice: BigNumber
  askSpread: number
  bidSpread: number
  orderNum: number
  orderGap: number
  useBidPremium: boolean
  useAskPremium: boolean
}): {
  askTicks: number[]
  askPrices: BigNumber[]
  bidTicks: number[]
  bidPrices: BigNumber[]
  askTickPremium: number
  bidTickPremium: number
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
      now: { tick: onChainOraclePriceBidBookTick },
    },
    inverted: {
      now: { tick: onChainOraclePriceAskBookTick },
    },
  } = getPriceNeighborhood({
    chainId,
    price: onChainOraclePrice.toString(),
    currency0: quoteCurrency,
    currency1: baseCurrency,
  })

  let askTicks = Array.from(
    { length: orderNum },
    (_, i) => oraclePriceAskBookTick - BigInt(askSpread + orderGap * i),
  )
  let askTickPremium = 0n
  const lowestAskTick = askTicks.sort((a, b) => Number(a) - Number(b))[0]
  if (
    useAskPremium &&
    lowestAskTick &&
    lowestAskTick > onChainOraclePriceAskBookTick
  ) {
    askTickPremium = lowestAskTick - onChainOraclePriceAskBookTick + 1n // TODO: Set as parameter
    askTicks = askTicks.map((tick) => tick - askTickPremium)
  }

  let bidTicks = Array.from(
    { length: orderNum },
    (_, i) => oraclePriceBidBookTick - BigInt(bidSpread + orderGap * i),
  )
  let bidTickPremium = 0n
  const highestBidTick = bidTicks.sort((a, b) => Number(b) - Number(a))[0]
  if (
    useBidPremium &&
    highestBidTick &&
    highestBidTick < onChainOraclePriceBidBookTick
  ) {
    bidTickPremium = onChainOraclePriceBidBookTick - highestBidTick + 1n // TODO: Set as parameter
    bidTicks = bidTicks.map((tick) => tick - bidTickPremium)
  }

  return {
    askTicks: askTicks.map((tick) => Number(tick)),
    askPrices: askTicks
      .map((tick) =>
        getMarketPrice({
          marketQuoteCurrency: quoteCurrency,
          marketBaseCurrency: baseCurrency,
          askTick: tick,
        }),
      )
      .map((price) => new BigNumber(price)),
    bidTicks: bidTicks.map((tick) => Number(tick)),
    bidPrices: bidTicks
      .map((tick) =>
        getMarketPrice({
          marketQuoteCurrency: quoteCurrency,
          marketBaseCurrency: baseCurrency,
          bidTick: tick,
        }),
      )
      .map((price) => new BigNumber(price)),
    askTickPremium: Number(askTickPremium),
    bidTickPremium: Number(bidTickPremium),
  }
}

export const getMarketPrice = ({
  marketQuoteCurrency,
  marketBaseCurrency,
  bidTick,
  askTick,
}: {
  marketQuoteCurrency: Currency
  marketBaseCurrency: Currency
  bidTick?: bigint
  askTick?: bigint
}): string => {
  if (bidTick) {
    return formatPrice(
      toPrice(bidTick),
      marketQuoteCurrency.decimals,
      marketBaseCurrency.decimals,
    )
  } else if (askTick) {
    return formatPrice(
      invertPrice(toPrice(askTick)),
      marketQuoteCurrency.decimals,
      marketBaseCurrency.decimals,
    )
  } else {
    throw new Error('Either bidTick or askTick must be provided')
  }
}

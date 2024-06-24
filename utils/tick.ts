import type { CHAIN_IDS, Currency } from '@clober/v2-sdk'
import { getMarketPrice, getPriceNeighborhood } from '@clober/v2-sdk'

import BigNumber from './bignumber.ts'

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

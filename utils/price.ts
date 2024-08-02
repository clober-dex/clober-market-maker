import {
  CHAIN_IDS,
  type Currency,
  getMarketPrice,
  getPriceNeighborhood,
} from '@clober/v2-sdk'

import BigNumber from './bignumber.ts'
import { max, min } from './bigint.ts'

export const calculateMinMaxPrice = ({
  chainId,
  tickDiff,
  quoteCurrency,
  baseCurrency,
  askPrices,
  askSpongeDiff,
  bidPrices,
  bidSpongeDiff,
}: {
  chainId: CHAIN_IDS
  tickDiff: number
  quoteCurrency: Currency
  baseCurrency: Currency
  askPrices: BigNumber[]
  askSpongeDiff: BigNumber
  bidPrices: BigNumber[]
  bidSpongeDiff: BigNumber
}): {
  minPrice: BigNumber
  maxPrice: BigNumber
} => {
  const { askPrice, bidPrice } = getProposedPrice({ askPrices, bidPrices })
  const [meanAskPriceBidBookTick, meanBidPriceBidBookTick] = [
    askPrice,
    bidPrice,
  ].map((price) => {
    const {
      normal: {
        now: { tick: bidBookTick },
      },
    } = getPriceNeighborhood({
      chainId,
      price: price.toString(),
      currency0: quoteCurrency,
      currency1: baseCurrency,
    })
    return bidBookTick
  })

  return {
    minPrice: BigNumber(
      getMarketPrice({
        marketQuoteCurrency: quoteCurrency,
        marketBaseCurrency: baseCurrency,
        bidTick: meanBidPriceBidBookTick + min(BigInt(tickDiff), 0n),
      }),
    ).minus(bidSpongeDiff),
    maxPrice: BigNumber(
      getMarketPrice({
        marketQuoteCurrency: quoteCurrency,
        marketBaseCurrency: baseCurrency,
        bidTick: meanAskPriceBidBookTick + max(BigInt(tickDiff), 0n),
      }),
    ).plus(askSpongeDiff),
  }
}

export const getProposedPrice = ({
  askPrices,
  bidPrices,
}: {
  askPrices: BigNumber[]
  bidPrices: BigNumber[]
}): {
  askPrice: BigNumber
  bidPrice: BigNumber
} => {
  return {
    askPrice: askPrices
      .reduce((acc, price) => acc.plus(price), BigNumber(0))
      .div(askPrices.length),
    bidPrice: bidPrices
      .reduce((acc, price) => acc.plus(price), BigNumber(0))
      .div(bidPrices.length),
  }
}

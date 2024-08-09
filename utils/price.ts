import BigNumber from './bignumber.ts'

export const calculateMinMaxPrice = ({
  correctionFactor,
  askPrices,
  askSpongeDiff,
  bidPrices,
  bidSpongeDiff,
}: {
  correctionFactor: BigNumber
  askPrices: BigNumber[]
  askSpongeDiff: BigNumber
  bidPrices: BigNumber[]
  bidSpongeDiff: BigNumber
}): {
  minPrice: BigNumber
  maxPrice: BigNumber
} => {
  const { askPrice, bidPrice } = getProposedPrice({ askPrices, bidPrices })
  const minPrice1 = bidPrice.times(correctionFactor).minus(bidSpongeDiff)
  const maxPrice1 = askPrice.times(correctionFactor).plus(askSpongeDiff)
  const minPrice2 = bidPrice.minus(bidSpongeDiff)
  const maxPrice2 = askPrice.plus(askSpongeDiff)

  return {
    minPrice: minPrice1.isLessThan(minPrice2) ? minPrice1 : minPrice2,
    maxPrice: maxPrice1.isGreaterThan(maxPrice2) ? maxPrice1 : maxPrice2,
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

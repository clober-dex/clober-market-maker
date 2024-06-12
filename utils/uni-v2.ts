import BigNumber from './bignumber.ts'

export const calculateUniV2ImpermanentLoss = ({
  currentPrice,
  startPrice,
  startQuoteAmount,
  startBaseAmount,
}: {
  currentPrice: BigNumber
  startPrice: BigNumber
  startQuoteAmount: BigNumber
  startBaseAmount: BigNumber
}) => {
  const k = currentPrice.div(new BigNumber(startPrice))
  const onHold = currentPrice.times(startBaseAmount).plus(startQuoteAmount)
  return new BigNumber(2).times(k.sqrt()).div(k.plus(1)).minus(1).times(onHold)
}

import BigNumber from './bignumber.ts'

export const calculateOrderSize = ({
  totalBase,
  totalQuote,
  oraclePrice,
  entropy,
  minEntropy,
  balancePercentage,
  minBalancePercentage,
}: {
  totalBase: BigNumber
  totalQuote: BigNumber
  oraclePrice: BigNumber
  entropy: BigNumber
  minEntropy: BigNumber
  balancePercentage: number
  minBalancePercentage: number
}): { askOrderSizeInBase: BigNumber; bidOrderSizeInQuote: BigNumber } => {
  const [askOrderSizeInBase, bidOrderSizeInBase] = [
    totalBase.times(balancePercentage / 100),
    totalQuote.times(balancePercentage / 100).div(oraclePrice),
  ]
  const [minimumAskOrderSizeInBase, minimumBidOrderSizeInBase] = [
    totalBase.times(minBalancePercentage / 100),
    totalQuote.times(minBalancePercentage / 100).div(oraclePrice),
  ]
  const orderSizeInBase = BigNumber.min(askOrderSizeInBase, bidOrderSizeInBase)
  const cuttedEntropy = BigNumber.max(entropy, minEntropy)

  return {
    askOrderSizeInBase: BigNumber.max(
      orderSizeInBase,
      minimumAskOrderSizeInBase,
    ).times(cuttedEntropy),
    bidOrderSizeInQuote: BigNumber.max(
      orderSizeInBase,
      minimumBidOrderSizeInBase,
    )
      .times(oraclePrice)
      .times(cuttedEntropy),
  }
}

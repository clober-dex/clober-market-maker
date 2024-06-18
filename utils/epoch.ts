import BigNumber from './bignumber'

export const isNewEpoch = ({
  oraclePrice,
  minPrice,
  maxPrice,
  startTimestamp,
  currentTimestamp,
  maxEpochDurationSeconds,
}: {
  oraclePrice: BigNumber
  minPrice: BigNumber
  maxPrice: BigNumber
  startTimestamp: number
  currentTimestamp: number
  maxEpochDurationSeconds: number
}): boolean => {
  return (
    oraclePrice.isLessThan(minPrice) ||
    oraclePrice.isGreaterThan(maxPrice) ||
    startTimestamp + maxEpochDurationSeconds <= currentTimestamp
  )
}

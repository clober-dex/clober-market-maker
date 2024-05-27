import BigNumber from 'bignumber.js'

export type Epoch = {
  id: number
  minSpread: number
  maxSpread: number
  startTimestamp: number
  maxPrice: BigNumber
  minPrice: BigNumber
}

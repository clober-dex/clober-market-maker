import type BigNumber from '../utils/bignumber'

// Constants values when epoch is created
export type Epoch = {
  id: number
  minSpread: number
  maxSpread: number
  startTimestamp: number
  minPrice: BigNumber
  maxPrice: BigNumber
  oraclePrice: BigNumber
}

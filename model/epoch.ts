import type BigNumber from '../utils/bignumber'

// Constants values when epoch is created
export type Epoch = {
  id: number
  askSpread: number
  bidSpread: number
  startTimestamp: number
  minPrice: BigNumber
  maxPrice: BigNumber
  oraclePrice: BigNumber
  centralPrice: BigNumber
  askTicks: number[]
  askPrices: BigNumber[]
  bidTicks: number[]
  bidPrices: BigNumber[]
}

import type BigNumber from '../utils/bignumber'

// Constants values when epoch is created
export type Epoch = {
  id: number
  askSpread: number
  bidSpread: number
  tickDiff: number
  startTimestamp: number
  minPrice: BigNumber // toTick(oraclePrice) + askSpread + tickDiff
  maxPrice: BigNumber // toTick(oraclePrice) - bidSpread + tickDiff
  oraclePrice: BigNumber
  entropy: BigNumber
  askTicks: number[] // toTick(oraclePrice) + askSpread
  askPrices: BigNumber[]
  askSpongeTick: number
  bidTicks: number[] // toTick(oraclePrice) - bidSpread
  bidPrices: BigNumber[]
  bidSpongeTick: number
  onHold: BigNumber
  onCurrent: BigNumber
  pnl: BigNumber
}

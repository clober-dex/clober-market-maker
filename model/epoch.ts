import type BigNumber from '../utils/bignumber'

// Constants values when epoch is created
export type Epoch = {
  id: number
  askSpread: number
  bidSpread: number
  correctionFactor: BigNumber
  startTimestamp: number
  minPrice: BigNumber // toTick(oraclePrice) + askSpread + tickDiff
  maxPrice: BigNumber // toTick(oraclePrice) - bidSpread + tickDiff
  oraclePrice: BigNumber
  onChainOraclePrice: BigNumber
  entropy: BigNumber
  askTicks: number[] // toTick(oraclePrice) + askSpread
  askPrices: BigNumber[]
  bidTicks: number[] // toTick(oraclePrice) - bidSpread
  bidPrices: BigNumber[]
  onHold: BigNumber
  onCurrent: BigNumber
  pnl: BigNumber
}

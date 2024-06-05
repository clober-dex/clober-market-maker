import type BigNumber from '../utils/bignumber'

// Constants values when epoch is created
export type Epoch = {
  id: number
  askSpread: number
  bidSpread: number
  tickDiff: number
  startTimestamp: number
  minPrice: BigNumber // toTick(oraclePrice) + askSpread + tickDiff - spongeTick
  maxPrice: BigNumber // toTick(oraclePrice) - bidSpread + tickDiff + spongeTick
  oraclePrice: BigNumber
  askTicks: number[] // toTick(oraclePrice) + askSpread
  askPrices: BigNumber[]
  bidTicks: number[] // toTick(oraclePrice) - bidSpread
  bidPrices: BigNumber[]
  spongeTick: number
  onHold: BigNumber
  onCurrent: BigNumber
  pnl: BigNumber
}

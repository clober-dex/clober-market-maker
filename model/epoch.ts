import type BigNumber from '../utils/bignumber'

// Constants values when epoch is created
export type Epoch = {
  id: number
  askSpread: number
  bidSpread: number
  askTickPremium: number
  bidTickPremium: number
  startTimestamp: number
  minPrice: BigNumber // toTick(oraclePrice) + askSpread - spongeTick
  maxPrice: BigNumber // toTick(oraclePrice) - bidSpread + spongeTick
  oraclePrice: BigNumber
  onChainOraclePrice: BigNumber
  askTicks: number[] // toTick(oraclePrice) + askSpread
  askPrices: BigNumber[]
  bidTicks: number[] // toTick(oraclePrice) - bidSpread
  bidPrices: BigNumber[]
  onHold: BigNumber
  onCurrent: BigNumber
  pnl: BigNumber
}

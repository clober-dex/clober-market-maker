import type { Currency } from '@clober/v2-sdk'

export type TakenTrade = {
  isTakingBidSide: boolean
  amountIn: string
  amountOut: string
  price: string
  pool: `0x${string}`
  blockNumber: bigint
  logIndex: number
  currency0: Currency
  currency1: Currency
}

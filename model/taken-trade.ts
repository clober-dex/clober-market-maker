export type TakenTrade = {
  isTakingBidSide: boolean
  amountIn: string
  amountOut: string
  price: string
  pool: `0x${string}`
  blockNumber: bigint
  logIndex: number
}

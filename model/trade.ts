export type Trade = {
  type: 'bid' | 'ask'
  amountIn: string
  amountOut: string
  price: string
  pool: `0x${string}`
  blockNumber: bigint
  logIndex: number
}

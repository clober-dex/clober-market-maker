export type OrderBook = {
  asks: [number, number][] // price, baseAmount
  bids: [number, number][] // price, baseAmount
  timestamp: number
}

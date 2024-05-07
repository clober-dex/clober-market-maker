import { type OrderBook } from './order-book.ts'
import type { Market } from './market.ts'

export interface Exchange {
  markets: { [id: string]: Market }
  orderBooks: { [id: string]: OrderBook }

  update(): Promise<void>
}

import { type OrderBook } from './order-book.ts'

export interface Exchange {
  markets: { [id: string]: any }
  orderBooks: { [id: string]: OrderBook }

  init(): Promise<void>

  update(): Promise<void>
}

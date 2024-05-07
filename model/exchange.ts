import BigNumber from 'bignumber.js'

import { type OrderBook } from './order-book.ts'
import type { Market } from './market.ts'

export interface Exchange {
  markets: { [id: string]: Market }
  orderBooks: { [id: string]: OrderBook }

  update(): Promise<void>

  price(id: string): BigNumber

  highestBid(id: string): number

  lowestAsk(id: string): number
}

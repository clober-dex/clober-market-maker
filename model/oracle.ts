import BigNumber from 'bignumber.js'

import type { Market } from './market.ts'

export interface Oracle {
  markets: { [id: string]: Market }
  prices: { [p: string]: BigNumber }

  update(): Promise<void>

  price(id: string): BigNumber
}

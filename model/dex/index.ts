import type { AbiEvent } from 'viem'
import type { Currency } from '@clober/v2-sdk'

import type { TakenTrade } from '../taken-trade.ts'

export interface Dex {
  address: `0x${string}`
  swapEvent: AbiEvent
  currency0: Currency
  currency1: Currency
  isCurrency0Base: boolean

  extract(logs: any[]): TakenTrade[]
}

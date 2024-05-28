import type { TakenTrade } from '../taken-trade.ts'

export interface Dex {
  address: `0x${string}`

  extract(logs: any[]): TakenTrade[]
}

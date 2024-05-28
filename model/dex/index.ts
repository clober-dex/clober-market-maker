import type { Trade } from '../trade.ts'

export interface Dex {
  address: `0x${string}`

  extract(logs: any[]): Trade[]
}

import { CHAIN_IDS, type Currency } from '@clober/v2-sdk'

import { WHITELISTED_CURRENCIES } from '../constants/currency.ts'

export const findCurrency = (chain: CHAIN_IDS, symbol: string): Currency => {
  const currency = WHITELISTED_CURRENCIES[chain].find(
    (currency) => currency.symbol === symbol,
  )
  if (!currency) {
    throw new Error(`Currency ${symbol} not found in chain ${chain}`)
  }
  return currency
}

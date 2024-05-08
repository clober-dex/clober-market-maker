import { CHAIN_IDS, type Currency } from '@clober/v2-sdk'
import { isAddressEqual } from 'viem'

import { WHITELISTED_CURRENCIES } from '../constants/currency.ts'

export const findCurrencyBySymbol = (
  chain: CHAIN_IDS,
  symbol: string,
): Currency => {
  const currency = WHITELISTED_CURRENCIES[chain].find(
    (currency) => currency.symbol === symbol,
  )
  if (!currency) {
    throw new Error(`Currency ${symbol} not found in chain ${chain}`)
  }
  return currency
}

export const findCurrencyByAddress = (
  chain: CHAIN_IDS,
  address: `0x${string}`,
): Currency => {
  const currency = WHITELISTED_CURRENCIES[chain].find((currency) =>
    isAddressEqual(currency.address, address),
  )
  if (!currency) {
    throw new Error(`Currency ${address} not found in chain ${chain}`)
  }
  return currency
}

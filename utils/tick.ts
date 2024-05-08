import type { Currency } from '@clober/v2-sdk'
import {
  formatPrice,
  fromPrice,
  invertPrice,
  parsePrice,
  toPrice,
} from '@clober/v2-sdk'

export const getBookTicks = ({
  marketQuoteCurrency,
  marketBaseCurrency,
  price,
}: {
  marketQuoteCurrency: Currency
  marketBaseCurrency: Currency
  price: string
}): {
  bidBookTick: bigint
  askBookTick: bigint
} => {
  return {
    bidBookTick:
      fromPrice(
        parsePrice(
          Number(price),
          marketQuoteCurrency.decimals,
          marketBaseCurrency.decimals,
        ),
      ) + 1n,
    askBookTick: fromPrice(
      invertPrice(
        parsePrice(
          Number(price),
          marketQuoteCurrency.decimals,
          marketBaseCurrency.decimals,
        ),
      ),
    ),
  }
}

export const getMarketPrice = ({
  marketQuoteCurrency,
  marketBaseCurrency,
  bidTick,
  askTick,
}: {
  marketQuoteCurrency: Currency
  marketBaseCurrency: Currency
  bidTick?: bigint
  askTick?: bigint
}): string => {
  if (bidTick) {
    return formatPrice(
      toPrice(bidTick),
      marketQuoteCurrency.decimals,
      marketBaseCurrency.decimals,
    )
  } else if (askTick) {
    return formatPrice(
      invertPrice(toPrice(askTick)),
      marketQuoteCurrency.decimals,
      marketBaseCurrency.decimals,
    )
  } else {
    throw new Error('Either bidTick or askTick must be provided')
  }
}

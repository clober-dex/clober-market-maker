import { CHAIN_IDS } from '@clober/v2-sdk'
import chalk from 'chalk'

import { logger } from '../../utils/logger.ts'
import BigNumber from '../../utils/bignumber.ts'
import type { Market } from '../market.ts'
import { findCurrencyBySymbol } from '../../utils/currency.ts'

import type { Oracle } from './index.ts'

export class OnChain implements Oracle {
  markets: { [p: string]: Market }
  prices: { [p: string]: BigNumber } = {}

  chainId: CHAIN_IDS

  constructor(chainId: CHAIN_IDS, markets: { [id: string]: Market }) {
    this.chainId = chainId
    this.markets = markets
  }

  price(id: string): BigNumber {
    return this.prices[id]
  }

  async update() {
    const fetchQueue: Promise<void>[] = []
    const start = performance.now()
    for (const [id] of Object.entries(this.markets)) {
      const baseCurrency = findCurrencyBySymbol(this.chainId, id.split('/')[0])
      fetchQueue.push(
        fetch(
          `https://api.odos.xyz/pricing/token/${this.chainId}/${baseCurrency.address}`,
        )
          .then((res) => res.json() as unknown as { price: string })
          .then(({ price }) => {
            this.prices[id] = new BigNumber(price)
          }),
      )
    }

    await Promise.all(fetchQueue)
    const end = performance.now()

    await logger(chalk.yellow, 'OnChain updated', {
      second: ((end - start) / 1000).toFixed(2),
      markets: Object.keys(this.markets),
      prices: Object.entries(this.markets).map(([id]) => ({
        id,
        price: this.price(id).toString(),
      })),
    })
  }
}

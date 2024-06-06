import { CHAIN_IDS } from '@clober/v2-sdk'
import chalk from 'chalk'
import { formatUnits, getAddress, parseUnits } from 'viem'

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
      const quoteCurrency = findCurrencyBySymbol(this.chainId, id.split('/')[1])
      fetchQueue.push(
        fetch(`https://api.odos.xyz/sor/quote/v2`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            chainId: this.chainId,
            inputTokens: [
              {
                tokenAddress: getAddress(baseCurrency.address),
                amount: parseUnits('1', baseCurrency.decimals).toString(),
              },
            ],
            outputTokens: [
              {
                tokenAddress: getAddress(quoteCurrency.address),
                proportion: 1,
              },
            ],
            slippageLimitPercent: 0.3,
            disableRFQs: false,
            compact: true,
          }),
        })
          .then(
            (res) =>
              res.json() as unknown as {
                outAmounts: string[]
              },
          )
          .then(({ outAmounts }) => {
            this.prices[id] = new BigNumber(
              formatUnits(BigInt(outAmounts[0]), quoteCurrency.decimals),
            )
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

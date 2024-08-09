import { CHAIN_IDS } from '@clober/v2-sdk'
import chalk from 'chalk'
import { formatUnits, getAddress, parseUnits } from 'viem'

import { logger } from '../../utils/logger.ts'
import BigNumber from '../../utils/bignumber.ts'
import type { Market } from '../market.ts'
import { findCurrencyBySymbol } from '../../utils/currency.ts'

import type { Oracle } from './index.ts'

export type OnChainMarket = Market & {
  quoteAmount: number
  baseAmount: number
}

export class OnChain implements Oracle {
  markets: { [p: string]: OnChainMarket }
  prices: { [p: string]: BigNumber } = {}

  chainId: CHAIN_IDS

  constructor(chainId: CHAIN_IDS, markets: { [id: string]: OnChainMarket }) {
    this.chainId = chainId
    this.markets = markets
  }

  price(id: string): BigNumber {
    return this.prices[id]
  }

  async update() {
    const fetchQueue: Promise<void>[] = []
    const start = performance.now()
    const price: { [id: string]: [BigNumber, BigNumber] } = {}
    for (const [id] of Object.entries(this.markets)) {
      price[id] = [new BigNumber(0), new BigNumber(0)]
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
                amount: parseUnits(
                  this.markets[id].baseAmount.toString(),
                  baseCurrency.decimals,
                ).toString(),
              },
            ],
            outputTokens: [
              {
                tokenAddress: getAddress(quoteCurrency.address),
                proportion: 1,
              },
            ],
            slippageLimitPercent: 0.3,
            disableRFQs: true,
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
            if (outAmounts && outAmounts.length > 0) {
              price[id][0] = new BigNumber(
                formatUnits(BigInt(outAmounts[0]), quoteCurrency.decimals),
              ).div(this.markets[id].baseAmount)
            }
          }),
      )
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
                tokenAddress: getAddress(quoteCurrency.address),
                amount: parseUnits(
                  this.markets[id].quoteAmount.toString(),
                  quoteCurrency.decimals,
                ).toString(),
              },
            ],
            outputTokens: [
              {
                tokenAddress: getAddress(baseCurrency.address),
                proportion: 1,
              },
            ],
            slippageLimitPercent: 0.3,
            disableRFQs: true,
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
            if (outAmounts && outAmounts.length > 0) {
              price[id][1] = new BigNumber(this.markets[id].quoteAmount).div(
                formatUnits(BigInt(outAmounts[0]), baseCurrency.decimals),
              )
            }
          }),
      )
    }

    await Promise.all(fetchQueue)
    for (const [id] of Object.entries(this.markets)) {
      this.prices[id] = price[id][0].plus(price[id][1]).div(2)
    }
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

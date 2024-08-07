import { CHAIN_IDS, getPriceNeighborhood } from '@clober/v2-sdk'
import { createPublicClient, getAddress, http, type PublicClient } from 'viem'
import { Queue } from 'async-await-queue'

import { CHAIN_MAP } from '../constants/chain.ts'
import { WHITELIST_DEX } from '../constants/dex.ts'
import BigNumber from '../utils/bignumber.ts'
import { findCurrencyBySymbol } from '../utils/currency.ts'
import { min } from '../utils/bigint.ts'
import { isZero } from '../utils/number.ts'

import type { Market } from './market.ts'
import type { TakenTrade } from './taken-trade.ts'
import type { Params } from './config.ts'

export class DexSimulator {
  private readonly BATCH_SIZE: bigint = 2000n
  markets: { [id: string]: Market }
  params: { [id: string]: Params }
  chainId: CHAIN_IDS
  publicClient: PublicClient

  trades: { [id: string]: TakenTrade[] } = {}
  startBlock: bigint = 0n
  latestBlock: bigint = 0n

  constructor(
    chainId: CHAIN_IDS,
    markets: { [id: string]: Market },
    params: { [id: string]: Params },
  ) {
    this.chainId = chainId
    this.publicClient = createPublicClient({
      chain: CHAIN_MAP[chainId],
      transport: process.env.TAKER_RPC_URL
        ? http(process.env.TAKER_RPC_URL)
        : process.env.RPC_URL
          ? http(process.env.RPC_URL)
          : http(),
    })
    this.markets = markets
    this.params = params
  }

  async update() {
    if (this.startBlock === 0n) {
      this.startBlock = await this.publicClient.getBlockNumber()
    }

    this.latestBlock = await this.publicClient.getBlockNumber()
    if (this.startBlock > this.latestBlock) {
      return
    }

    const queue = new Queue(10, 1000)

    const p = []
    const allLogs: any[] = []
    for (let i = this.startBlock; i < this.latestBlock; i += this.BATCH_SIZE) {
      /* Each iteration is an anonymous async function */
      p.push(
        (async () => {
          const me = Symbol()
          await queue.wait(me, 0)
          try {
            const fromBlock = BigInt(i === this.startBlock ? i : i + 1n)
            const toBlock = BigInt(min(i + this.BATCH_SIZE, this.latestBlock))
            const logs = await this.publicClient.getLogs({
              address: Object.values(WHITELIST_DEX[this.chainId])
                .flat()
                .map((dex) => getAddress(dex.address)),
              events: Object.values(WHITELIST_DEX[this.chainId])
                .flat()
                .map((dex) => dex.swapEvent),
              fromBlock,
              toBlock,
            })
            allLogs.push(...logs)
          } catch (e) {
            console.error(`Error in block ${i}: ${e}`)
          } finally {
            queue.end(me)
          }
        })(),
      )
    }

    for (const [id] of Object.entries(this.markets)) {
      const trades = WHITELIST_DEX[this.chainId][id].reduce(
        (acc, dex) => acc.concat(dex.extract(allLogs)),
        [] as TakenTrade[],
      )
      this.trades[id] = [...(this.trades[id] || []), ...trades]
    }

    this.startBlock = this.latestBlock + 1n
  }

  getTrades(
    marketId: string,
    startBlock: bigint,
    endBlock: bigint,
  ): TakenTrade[] {
    return this.trades[marketId].filter(
      (trade) =>
        startBlock <= trade.blockNumber && trade.blockNumber <= endBlock,
    )
  }

  findSpread(
    marketId: string,
    startBlock: bigint,
    endBlock: bigint,
    previousOraclePrice: number,
    currentOraclePrice: number,
  ): {
    askSpread: number
    askSpongeDiff: BigNumber
    bidSpread: number
    bidSpongeDiff: BigNumber
    profit: BigNumber
    askProfit: BigNumber
    bidProfit: BigNumber
    targetAskPrice: BigNumber
    targetBidPrice: BigNumber
    askVolume: BigNumber
    bidVolume: BigNumber
    tickDiff: number
    entropy: BigNumber
  } {
    const trades = this.trades[marketId]
      .filter(
        (trade) =>
          startBlock <= trade.blockNumber && trade.blockNumber <= endBlock,
      )
      .sort(
        // if block number is same sort by log index
        (a, b) =>
          a.blockNumber === b.blockNumber
            ? a.logIndex - b.logIndex
            : Number(a.blockNumber) - Number(b.blockNumber),
      )

    const bidPrices: number[] = [
      ...trades.map((trade) => Number(trade.price)),
      previousOraclePrice,
    ].sort()

    const askPirces: number[] = [
      ...trades.map((trade) => Number(trade.price)),
      previousOraclePrice,
    ].sort()

    const askProfits: {
      targetAskPrice: number
      baseDelta: number
      quoteDelta: number
    }[] = []
    const bidProfits: {
      targetBidPrice: number
      baseDelta: number
      quoteDelta: number
    }[] = []
    for (const targetAskPrice of askPirces) {
      let baseAmount = 0
      let quoteAmount = 0

      for (const { isTakingBidSide, amountIn, price: takenPrice } of trades) {
        // simulate trade
        if (
          !isTakingBidSide &&
          Number(takenPrice) >= targetAskPrice // not considering taker fee in Clober
        ) {
          const cloberAmountOut = Number(amountIn) / targetAskPrice
          baseAmount = baseAmount - cloberAmountOut
          quoteAmount = quoteAmount + Number(amountIn)
        }
      }

      askProfits.push({
        targetAskPrice,
        baseDelta: baseAmount,
        quoteDelta: quoteAmount,
      })
    }
    for (const targetBidPrice of bidPrices) {
      let baseAmount = 0
      let quoteAmount = 0

      for (const { isTakingBidSide, amountIn, price: takenPrice } of trades) {
        // simulate trade
        if (
          isTakingBidSide &&
          targetBidPrice >= Number(takenPrice) // not considering taker fee in Clober
        ) {
          const cloberAmountOut = Number(amountIn) * targetBidPrice
          baseAmount = baseAmount + Number(amountIn)
          quoteAmount = quoteAmount - cloberAmountOut
        }
      }

      bidProfits.push({
        targetBidPrice,
        baseDelta: baseAmount,
        quoteDelta: quoteAmount,
      })
    }

    const bestSpreadPair = {
      profit: 0,
      askSideProfit: 0,
      bidSideProfit: 0,
      entropy: 0,
      score: 0, // entropy * profit
      askPrice: previousOraclePrice,
      bidPrice: previousOraclePrice,
      askBaseVolume: 0,
      bidBaseVolume: 0,
      centralPrice: previousOraclePrice,
    }
    for (const askProfit of askProfits) {
      for (const bidProfit of bidProfits) {
        if (
          BigNumber(askProfit.targetAskPrice).isLessThan(
            bidProfit.targetBidPrice,
          )
        ) {
          continue
        }

        const askBaseVolume = Math.abs(askProfit.baseDelta)
        const bidBaseVolume = Math.abs(bidProfit.baseDelta)

        const centralPrice = isZero(askBaseVolume + bidBaseVolume)
          ? previousOraclePrice
          : (askProfit.targetAskPrice * askBaseVolume +
              bidProfit.targetBidPrice * bidBaseVolume) /
            (askBaseVolume + bidBaseVolume)
        const totalBaseDelta = askProfit.baseDelta + bidProfit.baseDelta
        const totalQuoteDelta = askProfit.quoteDelta + bidProfit.quoteDelta
        const totalQuoteProfit = totalQuoteDelta + totalBaseDelta * centralPrice

        const askSideQuoteProfit =
          askProfit.quoteDelta + askProfit.baseDelta * centralPrice
        const bidSideQuoteProfit =
          bidProfit.quoteDelta + bidProfit.baseDelta * centralPrice

        // calculate entropy
        const totalBaseVolume = askBaseVolume + bidBaseVolume
        const askBaseVolumeRatio = isZero(totalBaseVolume)
          ? 0
          : askBaseVolume / totalBaseVolume
        const bidBaseVolumeRatio = isZero(totalBaseVolume)
          ? 0
          : bidBaseVolume / totalBaseVolume
        const askBaseVolumeRatioLog2 = isZero(askBaseVolumeRatio)
          ? 0
          : Math.log2(askBaseVolumeRatio)
        const bidBaseVolumeRatioLog2 = isZero(bidBaseVolumeRatio)
          ? 0
          : Math.log2(bidBaseVolumeRatio)

        const entropy = -(
          askBaseVolumeRatio * askBaseVolumeRatioLog2 +
          bidBaseVolumeRatio * bidBaseVolumeRatioLog2
        )

        // calculate score
        const score = entropy * totalQuoteProfit

        if (
          score > bestSpreadPair.score ||
          (isZero(score - bestSpreadPair.score) &&
            totalQuoteProfit > bestSpreadPair.profit)
        ) {
          bestSpreadPair.profit = totalQuoteProfit
          bestSpreadPair.askSideProfit = askSideQuoteProfit
          bestSpreadPair.bidSideProfit = bidSideQuoteProfit
          bestSpreadPair.entropy = entropy
          bestSpreadPair.score = score
          bestSpreadPair.askPrice = askProfit.targetAskPrice
          bestSpreadPair.bidPrice = bidProfit.targetBidPrice
          bestSpreadPair.askBaseVolume = askBaseVolume
          bestSpreadPair.bidBaseVolume = bidBaseVolume
          bestSpreadPair.centralPrice = centralPrice
        }
      }
    }

    const [base, quote] = marketId.split('/')

    const {
      inverted: {
        now: { tick: previousOraclePriceAskBookTick },
      },
    } = getPriceNeighborhood({
      chainId: this.chainId,
      price: previousOraclePrice.toString(),
      currency0: findCurrencyBySymbol(this.chainId, quote),
      currency1: findCurrencyBySymbol(this.chainId, base),
    })
    const {
      normal: {
        now: { tick: previousOraclePriceBidBookTick },
      },
    } = getPriceNeighborhood({
      chainId: this.chainId,
      price: previousOraclePrice.toString(),
      currency0: findCurrencyBySymbol(this.chainId, quote),
      currency1: findCurrencyBySymbol(this.chainId, base),
    })

    const {
      inverted: {
        now: { tick: lowestAskBidBookTick },
      },
    } = getPriceNeighborhood({
      chainId: this.chainId,
      price: bestSpreadPair.askPrice.toString(),
      currency0: findCurrencyBySymbol(this.chainId, quote),
      currency1: findCurrencyBySymbol(this.chainId, base),
    })
    const {
      normal: {
        now: { tick: highestBidBidBookTick },
      },
    } = getPriceNeighborhood({
      chainId: this.chainId,
      price: bestSpreadPair.bidPrice.toString(),
      currency0: findCurrencyBySymbol(this.chainId, quote),
      currency1: findCurrencyBySymbol(this.chainId, base),
    })

    if (
      BigNumber(bestSpreadPair.askSideProfit).isZero() ||
      BigNumber(bestSpreadPair.bidSideProfit).isZero()
    ) {
      return {
        askSpread: this.params[marketId].defaultAskTickSpread,
        askSpongeDiff: BigNumber(currentOraclePrice).times(
          BigNumber(1.0001)
            .pow(this.params[marketId].defaultAskTickSpread)
            .minus(1),
        ),
        bidSpread: this.params[marketId].defaultBidTickSpread,
        bidSpongeDiff: BigNumber(currentOraclePrice).times(
          BigNumber(1.0001)
            .pow(this.params[marketId].defaultBidTickSpread)
            .minus(1),
        ),
        profit: BigNumber(0),
        askProfit: BigNumber(0),
        bidProfit: BigNumber(0),
        targetAskPrice: BigNumber(previousOraclePrice),
        targetBidPrice: BigNumber(previousOraclePrice),
        askVolume: BigNumber(0),
        bidVolume: BigNumber(0),
        tickDiff: 0,
        entropy: BigNumber(this.params[marketId].minEntropy),
      }
    }

    const spreads = {
      askSpread: Number(previousOraclePriceAskBookTick - lowestAskBidBookTick),
      bidSpread: Number(previousOraclePriceBidBookTick - highestBidBidBookTick),
    }

    const {
      normal: {
        now: { tick: centralPriceBidBookTick },
      },
    } = getPriceNeighborhood({
      chainId: this.chainId,
      price: bestSpreadPair.centralPrice.toString(),
      currency0: findCurrencyBySymbol(this.chainId, quote),
      currency1: findCurrencyBySymbol(this.chainId, base),
    })

    return {
      askSpread: spreads.askSpread,
      askSpongeDiff: BigNumber(bestSpreadPair.askPrice).minus(
        bestSpreadPair.centralPrice,
      ),
      bidSpread: spreads.bidSpread,
      bidSpongeDiff: BigNumber(bestSpreadPair.centralPrice).minus(
        bestSpreadPair.bidPrice,
      ),
      profit: BigNumber(bestSpreadPair.profit),
      askProfit: BigNumber(bestSpreadPair.askSideProfit),
      bidProfit: BigNumber(bestSpreadPair.bidSideProfit),
      targetAskPrice: BigNumber(bestSpreadPair.askPrice),
      targetBidPrice: BigNumber(bestSpreadPair.bidPrice),
      askVolume: BigNumber(bestSpreadPair.askBaseVolume),
      bidVolume: BigNumber(bestSpreadPair.bidBaseVolume),
      tickDiff: Number(
        previousOraclePriceBidBookTick - centralPriceBidBookTick,
      ),
      entropy: BigNumber(bestSpreadPair.entropy),
    }
  }
}

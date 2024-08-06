import { CHAIN_IDS, getPriceNeighborhood } from '@clober/v2-sdk'
import { createPublicClient, getAddress, http, type PublicClient } from 'viem'

import { CHAIN_MAP } from '../constants/chain.ts'
import { WHITELIST_DEX } from '../constants/dex.ts'
import BigNumber from '../utils/bignumber.ts'
import { findCurrencyBySymbol } from '../utils/currency.ts'

import type { Market } from './market.ts'
import type { TakenTrade } from './taken-trade.ts'
import type { Params } from './config.ts'

export class DexSimulator {
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

    const logs = await this.publicClient.getLogs({
      address: Object.values(WHITELIST_DEX[this.chainId])
        .flat()
        .map((dex) => getAddress(dex.address)),
      events: Object.values(WHITELIST_DEX[this.chainId])
        .flat()
        .map((dex) => dex.swapEvent),
      fromBlock: this.startBlock,
      toBlock: this.latestBlock,
    })

    for (const [id] of Object.entries(this.markets)) {
      const trades = WHITELIST_DEX[this.chainId][id].reduce(
        (acc, dex) => acc.concat(dex.extract(logs)),
        [] as TakenTrade[],
      )
      this.trades[id] = [...(this.trades[id] || []), ...trades]
    }

    this.startBlock = this.latestBlock + 1n
  }

  findSpread(
    marketId: string,
    startBlock: bigint,
    endBlock: bigint,
    previousOraclePrice: BigNumber,
    currentOraclePrice: BigNumber,
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

    const bidPrices = [
      ...trades.map((trade) => trade.price),
      previousOraclePrice.toString(),
    ].sort((a, b) => new BigNumber(a).comparedTo(new BigNumber(b)))

    const askPirces = [
      ...trades.map((trade) => trade.price),
      previousOraclePrice.toString(),
    ].sort((a, b) => new BigNumber(a).comparedTo(new BigNumber(b)))

    const askProfits: {
      targetAskPrice: string
      baseDelta: BigNumber
      quoteDelta: BigNumber
    }[] = []
    const bidProfits: {
      targetBidPrice: string
      baseDelta: BigNumber
      quoteDelta: BigNumber
    }[] = []
    for (const targetAskPrice of askPirces) {
      let baseAmount = new BigNumber(0)
      let quoteAmount = new BigNumber(0)

      for (const { isTakingBidSide, amountIn, price: takenPrice } of trades) {
        // simulate trade
        if (
          !isTakingBidSide &&
          new BigNumber(takenPrice).comparedTo(targetAskPrice) >= 0 // not considering taker fee in Clober
        ) {
          const cloberAmountOut = new BigNumber(amountIn).div(targetAskPrice)
          baseAmount = baseAmount.minus(cloberAmountOut)
          quoteAmount = quoteAmount.plus(amountIn)
        }
      }

      askProfits.push({
        targetAskPrice,
        baseDelta: baseAmount,
        quoteDelta: quoteAmount,
      })
    }
    for (const targetBidPrice of bidPrices) {
      let baseAmount = new BigNumber(0)
      let quoteAmount = new BigNumber(0)

      for (const { isTakingBidSide, amountIn, price: takenPrice } of trades) {
        // simulate trade
        if (
          isTakingBidSide &&
          new BigNumber(targetBidPrice).comparedTo(takenPrice) >= 0 // not considering taker fee in Clober
        ) {
          const cloberAmountOut = new BigNumber(amountIn).times(targetBidPrice)
          baseAmount = baseAmount.plus(amountIn)
          quoteAmount = quoteAmount.minus(cloberAmountOut)
        }
      }

      bidProfits.push({
        targetBidPrice,
        baseDelta: baseAmount,
        quoteDelta: quoteAmount,
      })
    }

    const bestSpreadPair = {
      profit: new BigNumber(0),
      askSideProfit: new BigNumber(0),
      bidSideProfit: new BigNumber(0),
      entropy: new BigNumber(0),
      score: new BigNumber(0), // entropy * profit
      askPrice: previousOraclePrice.toString(),
      bidPrice: previousOraclePrice.toString(),
      askBaseVolume: new BigNumber(0),
      bidBaseVolume: new BigNumber(0),
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

        const askBaseVolume = askProfit.baseDelta.abs()
        const bidBaseVolume = bidProfit.baseDelta.abs()

        const centralPrice = askBaseVolume.plus(bidBaseVolume).isZero()
          ? previousOraclePrice
          : BigNumber(askProfit.targetAskPrice)
              .times(askBaseVolume)
              .plus(BigNumber(bidProfit.targetBidPrice).times(bidBaseVolume))
              .div(askBaseVolume.plus(bidBaseVolume))
        const totalBaseDelta = askProfit.baseDelta.plus(bidProfit.baseDelta)
        const totalQuoteDelta = askProfit.quoteDelta.plus(bidProfit.quoteDelta)
        const totalQuoteProfit = totalQuoteDelta.plus(
          totalBaseDelta.times(centralPrice),
        )

        const askSideQuoteProfit = askProfit.quoteDelta.plus(
          askProfit.baseDelta.times(centralPrice),
        )
        const bidSideQuoteProfit = bidProfit.quoteDelta.plus(
          bidProfit.baseDelta.times(centralPrice),
        )

        // calculate entropy
        const totalBaseVolume = askBaseVolume.plus(bidBaseVolume)
        const askBaseVolumeRatio = totalBaseVolume.isZero()
          ? new BigNumber(0)
          : askBaseVolume.div(totalBaseVolume)
        const bidBaseVolumeRatio = totalBaseVolume.isZero()
          ? new BigNumber(0)
          : bidBaseVolume.div(totalBaseVolume)
        const askBaseVolumeRatioLog2 = askBaseVolumeRatio.isZero()
          ? new BigNumber(0)
          : Math.log2(askBaseVolumeRatio.toNumber())
        const bidBaseVolumeRatioLog2 = bidBaseVolumeRatio.isZero()
          ? new BigNumber(0)
          : Math.log2(bidBaseVolumeRatio.toNumber())

        const entropy = askBaseVolumeRatio
          .times(askBaseVolumeRatioLog2)
          .plus(bidBaseVolumeRatio.times(bidBaseVolumeRatioLog2))
          .negated()

        // calculate score
        const score = entropy.times(totalQuoteProfit)

        if (
          score.comparedTo(bestSpreadPair.score) > 0 ||
          (score.eq(bestSpreadPair.score) &&
            totalQuoteProfit.comparedTo(bestSpreadPair.profit) > 0)
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
      bestSpreadPair.askSideProfit.isZero() ||
      bestSpreadPair.bidSideProfit.isZero()
    ) {
      return {
        askSpread: this.params[marketId].defaultAskTickSpread,
        askSpongeDiff: currentOraclePrice.times(
          BigNumber(1.0001)
            .pow(this.params[marketId].defaultAskTickSpread)
            .minus(1),
        ),
        bidSpread: this.params[marketId].defaultBidTickSpread,
        bidSpongeDiff: currentOraclePrice.times(
          BigNumber(1.0001)
            .pow(this.params[marketId].defaultBidTickSpread)
            .minus(1),
        ),
        profit: BigNumber(0),
        askProfit: BigNumber(0),
        bidProfit: BigNumber(0),
        targetAskPrice: previousOraclePrice,
        targetBidPrice: previousOraclePrice,
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
      profit: bestSpreadPair.profit,
      askProfit: bestSpreadPair.askSideProfit,
      bidProfit: bestSpreadPair.bidSideProfit,
      targetAskPrice: BigNumber(bestSpreadPair.askPrice),
      targetBidPrice: BigNumber(bestSpreadPair.bidPrice),
      askVolume: bestSpreadPair.askBaseVolume,
      bidVolume: bestSpreadPair.bidBaseVolume,
      tickDiff: Number(
        previousOraclePriceBidBookTick - centralPriceBidBookTick,
      ),
      entropy: bestSpreadPair.entropy,
    }
  }
}

import { CHAIN_IDS, getPriceNeighborhood } from '@clober/v2-sdk'
import { createPublicClient, http, parseAbiItem, type PublicClient } from 'viem'

import { CHAIN_MAP } from '../constants/chain.ts'
import { ODOS_ROUTER_CONTRACT_ADDRESS } from '../constants/odos.ts'
import { WHITELIST_DEX } from '../constants/dex.ts'
import BigNumber from '../utils/bignumber.ts'
import { findCurrencyBySymbol } from '../utils/currency.ts'

import type { Market } from './market.ts'
import type { TakenTrade } from './taken-trade.ts'

export class DexSimulator {
  markets: { [id: string]: Market }
  chainId: CHAIN_IDS
  publicClient: PublicClient

  trades: { [id: string]: TakenTrade[] } = {}
  startBlock: bigint = 0n
  latestBlock: bigint = 0n

  constructor(chainId: CHAIN_IDS, markets: { [id: string]: Market }) {
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
  }

  async update() {
    if (this.startBlock === 0n) {
      this.startBlock = await this.publicClient.getBlockNumber()
    }

    this.latestBlock = await this.publicClient.getBlockNumber()
    if (this.startBlock > this.latestBlock) {
      return
    }

    const transactions = (
      await this.publicClient.getLogs({
        address: ODOS_ROUTER_CONTRACT_ADDRESS[this.chainId],
        event: parseAbiItem(
          'event Swap(address sender, uint256 inputAmount, address inputToken, uint256 amountOut, address outputToken, int256 slippage, uint32 referralCode)',
        ),
        fromBlock: this.startBlock,
        toBlock: this.latestBlock,
      })
    )
      .map((log) => log.transactionHash)
      .filter((value, index, self) => self.indexOf(value) === index)

    const receipts = (
      await Promise.all(
        transactions.map((hash) =>
          this.publicClient.getTransactionReceipt({ hash }),
        ),
      )
    ).filter((r) => r.status === 'success')
    const logs = receipts.map((r) => r.logs)

    for (const [id] of Object.entries(this.markets)) {
      const trades = WHITELIST_DEX[this.chainId][id].reduce(
        (acc, dex) => acc.concat(dex.extract(logs.flat())),
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
  ): {
    askSpread: number
    bidSpread: number
    profit: BigNumber
    askProfit: BigNumber
    bidProfit: BigNumber
    targetAskPrice: BigNumber
    targetBidPrice: BigNumber
    askVolume: BigNumber
    bidVolume: BigNumber
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
      ...trades
        .filter((trade) => trade.isTakingBidSide)
        .map((trade) => trade.price),
      previousOraclePrice.toString(),
    ].sort((a, b) => new BigNumber(a).comparedTo(new BigNumber(b)))

    const askPirces = [
      ...trades
        .filter((trade) => !trade.isTakingBidSide)
        .map((trade) => trade.price),
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

        const centerPrice = BigNumber(askProfit.targetAskPrice)
          .plus(bidProfit.targetBidPrice)
          .div(2)
        const totalBaseDelta = askProfit.baseDelta.plus(bidProfit.baseDelta)
        const totalQuoteDelta = askProfit.quoteDelta.plus(bidProfit.quoteDelta)
        const totalQuoteProfit = totalQuoteDelta.plus(
          totalBaseDelta.times(centerPrice),
        )

        const askSideQuoteProfit = askProfit.quoteDelta.plus(
          askProfit.baseDelta.times(centerPrice),
        )
        const bidSideQuoteProfit = bidProfit.quoteDelta.plus(
          bidProfit.baseDelta.times(centerPrice),
        )

        // calculate entropy
        const askBaseVolume = askProfit.baseDelta.abs()
        const bidBaseVolume = bidProfit.baseDelta.abs()
        const totalBaseVolume = askBaseVolume.plus(bidBaseVolume)
        const askBaseVolumeRatio = askBaseVolume.div(totalBaseVolume)
        const bidBaseVolumeRatio = bidBaseVolume.div(totalBaseVolume)
        const entropy = askBaseVolumeRatio
          .times(Math.log2(askBaseVolumeRatio.toNumber()))
          .plus(
            bidBaseVolumeRatio.times(Math.log2(bidBaseVolumeRatio.toNumber())),
          )
          .negated()

        // calculate score
        const score = entropy.times(totalQuoteProfit)

        if (score.comparedTo(bestSpreadPair.score) > 0) {
          bestSpreadPair.profit = totalQuoteProfit
          bestSpreadPair.askSideProfit = askSideQuoteProfit
          bestSpreadPair.bidSideProfit = bidSideQuoteProfit
          bestSpreadPair.entropy = entropy
          bestSpreadPair.score = score
          bestSpreadPair.askPrice = askProfit.targetAskPrice
          bestSpreadPair.bidPrice = bidProfit.targetBidPrice
          bestSpreadPair.askBaseVolume = askBaseVolume
          bestSpreadPair.bidBaseVolume = bidBaseVolume
        }
      }
    }

    const spreads = {
      askSpread: 0,
      bidSpread: 0,
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

    spreads.askSpread = Number(
      previousOraclePriceAskBookTick - lowestAskBidBookTick,
    )
    spreads.bidSpread = Number(
      previousOraclePriceBidBookTick - highestBidBidBookTick,
    )

    return {
      askSpread: spreads.askSpread,
      bidSpread: spreads.bidSpread,
      profit: bestSpreadPair.profit,
      askProfit: bestSpreadPair.askSideProfit,
      bidProfit: bestSpreadPair.bidSideProfit,
      targetAskPrice: BigNumber(bestSpreadPair.askPrice),
      targetBidPrice: BigNumber(bestSpreadPair.bidPrice),
      askVolume: bestSpreadPair.askBaseVolume,
      bidVolume: bestSpreadPair.bidBaseVolume,
    }
  }
}

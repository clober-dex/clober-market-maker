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
    targetAskPrice: BigNumber
    targetBidPrice: BigNumber
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
    ]
      .sort((a, b) => new BigNumber(a).comparedTo(new BigNumber(b)))
      .filter(
        (price) => new BigNumber(price).comparedTo(previousOraclePrice) <= 0,
      )

    const askPirces = [
      ...trades
        .filter((trade) => !trade.isTakingBidSide)
        .map((trade) => trade.price),
      previousOraclePrice.toString(),
    ]
      .sort((a, b) => new BigNumber(a).comparedTo(new BigNumber(b)))
      .filter(
        (price) => new BigNumber(price).comparedTo(previousOraclePrice) >= 0,
      )

    const askProfits: {
      quoteProfit: BigNumber
      targetAskPrice: string
    }[] = []
    const bidProfits: {
      quoteProfit: BigNumber
      targetBidPrice: string
    }[] = []
    for (const targetAskPrice of askPirces) {
      let baseAmount = new BigNumber(0)
      let quoteAmount = new BigNumber(0)

      for (const { isTakingBidSide, amountIn, price: takenPrice } of trades) {
        // simulate trade
        if (
          !isTakingBidSide &&
          new BigNumber(takenPrice).comparedTo(targetAskPrice) > 0 // not considering taker fee in Clober
        ) {
          const cloberAmountOut = new BigNumber(amountIn).div(targetAskPrice)
          baseAmount = baseAmount.minus(cloberAmountOut)
          quoteAmount = quoteAmount.plus(amountIn)
        }
      }
      const quoteProfit = quoteAmount.plus(
        baseAmount.times(previousOraclePrice),
      )

      askProfits.push({
        quoteProfit,
        targetAskPrice,
      })
    }
    for (const targetBidPrice of bidPrices) {
      let baseAmount = new BigNumber(0)
      let quoteAmount = new BigNumber(0)

      for (const { isTakingBidSide, amountIn, price: takenPrice } of trades) {
        // simulate trade
        if (
          isTakingBidSide &&
          new BigNumber(targetBidPrice).comparedTo(takenPrice) > 0 // not considering taker fee in Clober
        ) {
          const cloberAmountOut = new BigNumber(amountIn).times(targetBidPrice)
          baseAmount = baseAmount.plus(amountIn)
          quoteAmount = quoteAmount.minus(cloberAmountOut)
        }
      }
      const quoteProfit = quoteAmount.plus(
        baseAmount.times(previousOraclePrice),
      )

      bidProfits.push({
        quoteProfit,
        targetBidPrice,
      })
    }

    const sortedAskProfits = askProfits
      .filter((profit) => profit.quoteProfit.gt(0))
      .sort((a, b) => b.quoteProfit.comparedTo(a.quoteProfit))

    const sortedBidProfits = bidProfits
      .filter((profit) => profit.quoteProfit.gt(0))
      .sort((a, b) => b.quoteProfit.comparedTo(a.quoteProfit))

    const askProfit =
      sortedAskProfits.length > 0
        ? sortedAskProfits[0].quoteProfit
        : new BigNumber(0)
    const bidProfit =
      sortedBidProfits.length > 0
        ? sortedBidProfits[0].quoteProfit
        : new BigNumber(0)

    const spreads = {
      askSpread: 0,
      bidSpread: 0,
    }

    const [base, quote] = marketId.split('/')
    if (askProfit.gt(0)) {
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
        inverted: {
          now: { tick: lowestAskBidBookTick },
        },
      } = getPriceNeighborhood({
        chainId: this.chainId,
        price: sortedAskProfits[0].targetAskPrice.toString(),
        currency0: findCurrencyBySymbol(this.chainId, quote),
        currency1: findCurrencyBySymbol(this.chainId, base),
      })

      spreads.askSpread = Number(
        previousOraclePriceAskBookTick - lowestAskBidBookTick,
      )
    }
    if (bidProfit.gt(0)) {
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
        normal: {
          now: { tick: highestBidBidBookTick },
        },
      } = getPriceNeighborhood({
        chainId: this.chainId,
        price: sortedBidProfits[0].targetBidPrice.toString(),
        currency0: findCurrencyBySymbol(this.chainId, quote),
        currency1: findCurrencyBySymbol(this.chainId, base),
      })

      spreads.bidSpread = Number(
        previousOraclePriceBidBookTick - highestBidBidBookTick,
      )
    }

    return {
      askSpread: spreads.askSpread,
      bidSpread: spreads.bidSpread,
      profit: askProfit.plus(bidProfit),
      targetAskPrice: new BigNumber(
        sortedAskProfits.length > 0
          ? sortedAskProfits[0].targetAskPrice
          : previousOraclePrice.toString(),
      ),
      targetBidPrice: new BigNumber(
        sortedBidProfits.length > 0
          ? sortedBidProfits[0].targetBidPrice
          : previousOraclePrice.toString(),
      ),
    }
  }
}

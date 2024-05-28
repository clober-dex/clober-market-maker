import { CHAIN_IDS } from '@clober/v2-sdk'
import { createPublicClient, http, parseAbiItem, type PublicClient } from 'viem'
import chalk from 'chalk'

import { CHAIN_MAP } from '../constants/chain.ts'
import { ODOS_ROUTER_CONTRACT_ADDRESS } from '../constants/odos.ts'
import { WHITELIST_DEX } from '../constants/dex.ts'
import BigNumber from '../utils/bignumber.ts'
import { logger } from '../utils/logger.ts'

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
    oraclePrice: BigNumber,
  ) {
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
      oraclePrice.toString(),
    ]
      .sort((a, b) => new BigNumber(a).comparedTo(new BigNumber(b)))
      .filter((price) => new BigNumber(price).comparedTo(oraclePrice) <= 0)

    const askPirces = [
      ...trades
        .filter((trade) => !trade.isTakingBidSide)
        .map((trade) => trade.price),
      oraclePrice.toString(),
    ]
      .sort((a, b) => new BigNumber(a).comparedTo(new BigNumber(b)))
      .filter((price) => new BigNumber(price).comparedTo(oraclePrice) >= 0)

    const profits: {
      quoteProfit: BigNumber
      targetAskPrice: string
      targetBidPrice: string
    }[] = []
    // O(trades ^ 2)
    for (const targetBidPrice of bidPrices) {
      for (const targetAskPrice of askPirces) {
        if (new BigNumber(targetAskPrice).comparedTo(targetBidPrice) > 0) {
          let baseAmount = new BigNumber(0)
          let quoteAmount = new BigNumber(0)

          for (const {
            isTakingBidSide,
            amountIn,
            amountOut,
            price: takenPrice,
          } of trades) {
            // simulate trade
            if (
              isTakingBidSide &&
              new BigNumber(targetBidPrice).comparedTo(takenPrice) > 0 // not considering taker fee in Clober
            ) {
              baseAmount = baseAmount.plus(amountIn)
              quoteAmount = quoteAmount.minus(amountOut)
            } else if (
              !isTakingBidSide &&
              new BigNumber(takenPrice).comparedTo(targetAskPrice) > 0 // not considering taker fee in Clober
            ) {
              baseAmount = baseAmount.minus(amountOut)
              quoteAmount = quoteAmount.plus(amountIn)
            }
          }
          const quoteProfit = quoteAmount.plus(baseAmount.times(targetBidPrice))

          profits.push({
            quoteProfit,
            targetAskPrice,
            targetBidPrice,
          })
        }
      }
    }

    const sortedProfits = profits
      .filter((profit) => profit.quoteProfit.gt(0))
      .sort((a, b) => b.quoteProfit.comparedTo(a.quoteProfit))

    if (sortedProfits.length > 0) {
      logger(chalk.green, 'Simulation', {
        market: marketId,
        startBlock,
        endBlock,
        oraclePrice: oraclePrice.toString(),
        profit: sortedProfits[0].quoteProfit.toString(),
        targetAskPrice: sortedProfits[0].targetAskPrice,
        targetBidPrice: sortedProfits[0].targetBidPrice,
      })
    }
  }
}

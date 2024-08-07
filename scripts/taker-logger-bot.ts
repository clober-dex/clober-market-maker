import fs from 'fs'

import _ from 'lodash'
import * as YAML from 'yaml'
import { base } from 'viem/chains'
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  parseAbiItem,
  type PublicClient,
} from 'viem'
import {
  CHAIN_IDS,
  type Currency,
  getContractAddresses,
  getMarket,
  getMarketPrice,
  type Market,
} from '@clober/v2-sdk'
import chalk from 'chalk'

import { type Config } from '../model/config.ts'
import { OnChain } from '../model/oracle/onchain.ts'
import { Binance } from '../model/oracle/binance.ts'
import { Clober } from '../model/exchange/clober.ts'
import { WHITELIST_DEX } from '../constants/dex.ts'
import { logger } from '../utils/logger.ts'
import type { TakenTrade } from '../model/taken-trade.ts'
import { getLogs } from '../utils/event.ts'

const BASE_CURRENCY = {
  address: '0x4200000000000000000000000000000000000006',
  name: 'Wrapped Ether',
  symbol: 'WETH',
  decimals: 18,
} as Currency
const QUOTE_CURRENCY = {
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  name: 'USD Coin',
  symbol: 'USDC',
  decimals: 6,
} as Currency

const publicClient = createPublicClient({
  chain: base,
  transport: process.env.BASE_RPC_URL ? http(process.env.BASE_RPC_URL) : http(),
})

type Trade = {
  price: number
  baseVolume: number
  isTakenBidSide: boolean
}

const fetchUniswapTrades = async (
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Trade[]> => {
  if (fromBlock > toBlock) {
    return []
  }
  const whitelistDexes = WHITELIST_DEX[CHAIN_IDS.BASE]['WETH/USDC']
  const logs = await getLogs(
    publicClient as PublicClient,
    fromBlock,
    toBlock,
    whitelistDexes.map((dex) => getAddress(dex.address)),
    whitelistDexes.map((dex) => dex.swapEvent),
  )

  const trades = whitelistDexes
    .reduce((acc, dex) => acc.concat(dex.extract(logs)), [] as TakenTrade[])
    .sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : Number(a.blockNumber) - Number(b.blockNumber),
    )

  return trades.map((takenTrade) => {
    const baseVolume = takenTrade.isTakingBidSide
      ? Number(takenTrade.amountIn)
      : Number(takenTrade.amountOut)
    return {
      isTakenBidSide: takenTrade.isTakingBidSide,
      baseVolume: baseVolume,
      price: Number(takenTrade.price),
    }
  })
}

const fetchTradesFromClober = async (
  market: Market,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Trade[]> => {
  if (fromBlock > toBlock) {
    return []
  }

  const filter = await publicClient.createEventFilter({
    address: getContractAddresses({ chainId: base.id }).BookManager,
    event: parseAbiItem(
      'event Take(uint192 indexed bookId, address indexed user, int24 tick, uint64 unit)',
    ),
    fromBlock,
    toBlock,
    args: {
      bookId: [
        3635527855256395834557663895503514098149724873652369924861n,
        5768588446199258063507297122440121414468447696628377168219n,
      ],
    },
  })
  const logs = await publicClient.getFilterLogs({ filter })
  return logs
    .map(({ args: { bookId, tick, unit } }) => {
      if (!bookId || !tick || !unit) {
        return null
      }
      if (
        bookId !== BigInt(market.bidBook.id) &&
        bookId !== BigInt(market.askBook.id)
      ) {
        return null
      }

      const price = Number(
        bookId === BigInt(market.bidBook.id)
          ? getMarketPrice({
              marketQuoteCurrency: market.quote,
              marketBaseCurrency: market.base,
              bidTick: BigInt(tick),
            })
          : getMarketPrice({
              marketQuoteCurrency: market.quote,
              marketBaseCurrency: market.base,
              askTick: BigInt(tick),
            }),
      )
      const amount: bigint =
        bookId === BigInt(market.bidBook.id)
          ? unit * BigInt(market.bidBook.unitSize)
          : unit * BigInt(market.askBook.unitSize)
      return {
        isTakenBidSide: bookId === BigInt(market.bidBook.id),
        baseVolume:
          bookId === BigInt(market.bidBook.id)
            ? Number(formatUnits(amount, market.quote.decimals)) / price
            : Number(formatUnits(amount, market.base.decimals)),
        price,
      }
    })
    .filter((m) => m !== null) as Trade[]
}

const main = async () => {
  const config = YAML.parse(fs.readFileSync('config.yaml', 'utf8')) as Config
  const onchainOracle = new OnChain(
    base.id,
    _.mapValues(config.oracles, (m) => m.onchain as any),
  )
  const binance = new Binance(
    _.mapValues(config.oracles, (m) => m.binance as any),
  )
  const clober = new Clober(
    base.id,
    _.mapValues(config.markets, (m: { clober: any }) => m.clober),
  )
  const market = await getMarket({
    chainId: base.id,
    token0: BASE_CURRENCY.address,
    token1: QUOTE_CURRENCY.address,
    options: {
      rpcUrl: process.env.BASE_RPC_URL ?? '',
    },
  })

  let startBlock = await publicClient.getBlockNumber()

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const [latestBlock] = await Promise.all([
      publicClient.getBlockNumber(),
      onchainOracle.update(),
      binance.update(),
      clober.update(),
    ])
    const uniswapTrades = await fetchUniswapTrades(startBlock, latestBlock)
    const cloberTrades = await fetchTradesFromClober(
      market,
      startBlock,
      latestBlock,
    )

    console.log(
      `Fetched ${uniswapTrades.length} vs ${cloberTrades.length} trades from block ${startBlock} to ${latestBlock}`,
    )

    if (uniswapTrades.length + cloberTrades.length > 0) {
      for (const cloberTrade of cloberTrades) {
        await logger(
          chalk.green,
          cloberTrade.isTakenBidSide
            ? 'Success Clober Sell Event'
            : 'Success Clober Buy Event',
          {
            price: cloberTrade.price,
            volume: cloberTrade.baseVolume,
          },
          false,
        )
      }

      for (const uniswapTrade of uniswapTrades) {
        await logger(
          chalk.green,
          uniswapTrade.isTakenBidSide
            ? 'UniSwap Sell Event'
            : 'UniSwap Buy Event',
          {
            price: uniswapTrade.price,
            volume: uniswapTrade.baseVolume,
          },
          false,
        )
      }

      await logger(
        chalk.green,
        'Swap Event',
        {
          startBlock: Number(startBlock),
          latestBlock: Number(latestBlock),
          tradesLength: uniswapTrades.length,
          uniswapHighestBidPrice:
            uniswapTrades
              .filter((trade) => !trade.isTakenBidSide)
              .map(({ price }) => price)
              .sort((a, b) => Number(b) - Number(a))[0] ?? '-',
          oraclePrice: binance.price('WETH/USDC').toString(),
          onchainPrice: onchainOracle.price('WETH/USDC').toString(),
          uniswapLowestAskPrice:
            uniswapTrades
              .filter((trade) => trade.isTakenBidSide)
              .map(({ price }) => price)
              .sort((a, b) => Number(a) - Number(b))[0] ?? '-',
          uniswapBidVolume: uniswapTrades.reduce(
            (acc, trade) =>
              acc + (!trade.isTakenBidSide ? trade.baseVolume : 0),
            0,
          ),
          uniswapAskVolume: uniswapTrades.reduce(
            (acc, trade) => acc + (trade.isTakenBidSide ? trade.baseVolume : 0),
            0,
          ),
          uniswapVolume: uniswapTrades.reduce(
            (acc, trade) => acc + trade.baseVolume,
            0,
          ),
          cloberBidVolume: cloberTrades.reduce(
            (acc, trade) =>
              acc + (!trade.isTakenBidSide ? trade.baseVolume : 0),
            0,
          ),
          cloberAskVolume: cloberTrades.reduce(
            (acc, trade) => acc + (trade.isTakenBidSide ? trade.baseVolume : 0),
            0,
          ),
          cloberVolume: cloberTrades.reduce(
            (acc, trade) => acc + trade.baseVolume,
            0,
          ),
          cloberHighestBidPrice:
            clober.highestBid('WETH/USDC').toFixed(4) ?? '-',
          cloberLowestAskPrice: clober.lowestAsk('WETH/USDC').toFixed(4) ?? '-',
        },
        false,
      )

      startBlock = latestBlock + 1n
      await new Promise((resolve) => setTimeout(resolve, 2 * 1000))
    }
  }
}

main()

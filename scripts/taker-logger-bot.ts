import fs from 'fs'

import _ from 'lodash'
import * as YAML from 'yaml'
import { base } from 'viem/chains'
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
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
import BigNumber from '../utils/bignumber.ts'
import { logger } from '../utils/logger.ts'

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

const ARBITRAGE_CONTRACT = '0xD4aD5Ed9E1436904624b6dB8B1BE31f36317C636'

const BATCH_SIZE = 20n

const abs = (n: bigint) => (n < 0n ? -n : n)

const publicClient = createPublicClient({
  chain: base,
  transport: process.env.BASE_RPC_URL ? http(process.env.BASE_RPC_URL) : http(),
})

type Trade = {
  price: number
  baseVolume: number
  isTakenBidSide: boolean
}

const fetchHashesFromOdosSwapEvent = async (
  fromBlock: bigint,
  toBlock: bigint,
) => {
  if (fromBlock > toBlock) {
    return []
  }
  const logs = await publicClient.getLogs({
    address: '0x19cEeAd7105607Cd444F5ad10dd51356436095a1', // odos router contract
    event: parseAbiItem(
      'event Swap(address sender, uint256 inputAmount, address inputToken, uint256 amountOut, address outputToken, int256 slippage, uint32 referralCode)',
    ),
    fromBlock,
    toBlock,
  })
  return logs.map((log) => log.transactionHash)
}

const fetchUniswapTradesFromHashes = async (
  hashes: `0x${string}`[],
): Promise<Trade[]> => {
  const trades = (
    await Promise.all(
      hashes.map((hash) => publicClient.getTransactionReceipt({ hash })),
    )
  )
    .filter((r) => r.status === 'success')
    .map((r) =>
      parseEventLogs({
        abi: parseAbi([
          'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
        ]),
        logs: r.logs,
      }),
    )
    .flat()
    .filter((log) =>
      WHITELIST_DEX[CHAIN_IDS.BASE]['WETH/USDC']
        .map((dex) => getAddress(dex.address))
        .includes(getAddress(log.address)),
    )
  return trades.map((log) => {
    const amount0 = BigInt(log.args.amount0) // weth
    const price = new BigNumber(log.args.sqrtPriceX96.toString())
      .div(new BigNumber(2).pow(96))
      .pow(2)
      .times(
        new BigNumber(10).pow(BASE_CURRENCY.decimals - QUOTE_CURRENCY.decimals),
      )
      .toNumber()
    return {
      isTakenBidSide: amount0 > 0n,
      baseVolume: Number(formatUnits(abs(amount0), BASE_CURRENCY.decimals)),
      price,
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
      user: ARBITRAGE_CONTRACT,
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
    _.mapValues(config.markets, (m) => m.clober),
  )
  const market = await getMarket({
    chainId: base.id,
    token0: BASE_CURRENCY.address,
    token1: QUOTE_CURRENCY.address,
    options: {
      rpcUrl: process.env.BASE_RPC_URL ?? '',
    },
  })

  let startBlock = (await publicClient.getBlockNumber()) - BATCH_SIZE

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const [latestBlock] = await Promise.all([
      publicClient.getBlockNumber(),
      onchainOracle.update(),
      binance.update(),
      clober.update(),
    ])
    const hashes = await fetchHashesFromOdosSwapEvent(startBlock, latestBlock)
    const uniswapTrades = await fetchUniswapTradesFromHashes(hashes)
    const cloberTrades = await fetchTradesFromClober(
      market,
      startBlock,
      latestBlock,
    )

    console.log(
      `Fetched ${uniswapTrades.length} vs ${cloberTrades.length} trades from block ${startBlock} to ${latestBlock}`,
    )

    if (uniswapTrades.length + cloberTrades.length > 0) {
      await logger(
        chalk.green,
        'Swap Event',
        {
          startBlock: Number(startBlock),
          latestBlock: Number(latestBlock),
          hashesLength: hashes.length,
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

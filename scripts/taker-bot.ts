import fs from 'fs'

import _ from 'lodash'
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  isAddressEqual,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  parseUnits,
  zeroAddress,
} from 'viem'
import { arbitrumSepolia, base } from 'viem/chains'
import {
  approveERC20,
  marketOrder,
  getExpectedInput,
  type Currency,
  CHAIN_IDS,
} from '@clober/v2-sdk'
import { privateKeyToAccount } from 'viem/accounts'
import * as YAML from 'yaml'
import chalk from 'chalk'

import BigNumber from '../utils/bignumber.ts'
import { WHITELISTED_CURRENCIES } from '../constants/currency.ts'
import { waitTransaction } from '../utils/transaction.ts'
import { logger } from '../utils/logger.ts'
import { WHITELIST_DEX } from '../constants/dex.ts'
import { Binance } from '../model/oracle/binance.ts'
import { type Config } from '../model/config.ts'
import { Clober } from '../model/exchange/clober.ts'
import { OnChain } from '../model/oracle/onchain.ts'

const BASE_CURRENCY = {
  address: '0xF2e615A933825De4B39b497f6e6991418Fb31b78',
  name: 'Wrapped Ether',
  symbol: 'WETH',
  decimals: 18,
} as Currency
const QUOTE_CURRENCY = {
  address: '0x00BFD44e79FB7f6dd5887A9426c8EF85A0CD23e0',
  name: 'USD Coin',
  symbol: 'USDC',
  decimals: 6,
} as Currency

const BATCH_SIZE = 20n

const abs = (n: bigint) => (n < 0n ? -n : n)

const mainnetPublicClient = createPublicClient({
  chain: base,
  transport: process.env.BASE_RPC_URL ? http(process.env.BASE_RPC_URL) : http(),
})

// testnet
const account = privateKeyToAccount(
  process.env.TAKER_PRIVATE_KEY as `0x${string}`,
)
const testnetPublicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
})
const testnetWalletClient = createWalletClient({
  account,
  chain: arbitrumSepolia,
  transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
})

const sendSlackMessage = async (message: {}) => {
  if (!process.env.SLACK_TAKER_WEBHOOK) {
    return
  }
  await fetch(process.env.SLACK_TAKER_WEBHOOK as string, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: '```\n' + YAML.stringify(message) + '```',
    }),
  })
}

const fetchHashesFromSwapEvent = async (fromBlock: bigint, toBlock: bigint) => {
  if (fromBlock > toBlock) {
    return []
  }
  const logs = await mainnetPublicClient.getLogs({
    address: '0x19cEeAd7105607Cd444F5ad10dd51356436095a1', // odos router contract
    event: parseAbiItem(
      'event Swap(address sender, uint256 inputAmount, address inputToken, uint256 amountOut, address outputToken, int256 slippage, uint32 referralCode)',
    ),
    fromBlock,
    toBlock,
  })
  return logs.map((log) => log.transactionHash)
}

const fetchTradeFromHashes = async (
  hashes: `0x${string}`[],
): Promise<
  {
    type: 'bid' | 'ask'
    baseAmount: bigint
    quoteAmount: bigint
    poolAddress: `0x${string}`
    blockNumber: bigint
    price: string
  }[]
> => {
  const trades = (
    await Promise.all(
      hashes.map((hash) => mainnetPublicClient.getTransactionReceipt({ hash })),
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
    const amount1 = BigInt(log.args.amount1) // usdc
    return {
      type: amount0 > 0n ? 'ask' : 'bid',
      baseAmount: abs(amount0),
      quoteAmount: abs(amount1),
      poolAddress: log.address,
      blockNumber: BigInt(log.blockNumber),
      price: new BigNumber(log.args.sqrtPriceX96.toString())
        .div(new BigNumber(2).pow(96))
        .pow(2)
        .times(
          new BigNumber(10).pow(
            BASE_CURRENCY.decimals - QUOTE_CURRENCY.decimals,
          ),
        )
        .toFixed(),
    }
  })
}

;(async () => {
  const config = YAML.parse(fs.readFileSync('config.yaml', 'utf8')) as Config
  const onchainOracle = new OnChain(
    base.id,
    _.mapValues(config.oracles, (m) => m.onchain as any),
  )
  const binance = new Binance(
    _.mapValues(config.oracles, (m) => m.binance as any),
  )
  const clober = new Clober(
    arbitrumSepolia.id,
    _.mapValues(config.markets, (m) => m.clober),
  )
  await sendSlackMessage({
    message: 'Taker bot started',
    account: account.address,
  })

  // 1. approve all tokens
  for (const { address } of WHITELISTED_CURRENCIES[arbitrumSepolia.id].filter(
    (currency) => !isAddressEqual(currency.address, zeroAddress),
  )) {
    const hash = await approveERC20({
      chainId: arbitrumSepolia.id,
      walletClient: testnetWalletClient,
      token: address,
    })
    await waitTransaction(
      'Approve',
      {
        token: address,
      },
      testnetPublicClient,
      hash,
    )
  }

  let startBlock = (await mainnetPublicClient.getBlockNumber()) - BATCH_SIZE

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const [latestBlock] = await Promise.all([
      mainnetPublicClient.getBlockNumber(),
      onchainOracle.update(),
      binance.update(),
      clober.update(),
    ])
    const hashes = await fetchHashesFromSwapEvent(startBlock, latestBlock)
    const trades = await fetchTradeFromHashes(hashes)
    const uniswapVolume = trades.reduce(
      (acc, trade) => acc + trade.baseAmount,
      0n,
    )
    const uniswapBidVolume = trades.reduce(
      (acc, trade) => acc + (trade.type === 'bid' ? trade.baseAmount : 0n),
      0n,
    )
    const uniswapAskVolume = trades.reduce(
      (acc, trade) => acc + (trade.type === 'ask' ? trade.baseAmount : 0n),
      0n,
    )

    console.log(
      `Fetched ${trades.length} trades from block ${startBlock} to ${latestBlock}`,
    )
    let numberOfMarketOrders = 0
    let cloberBidVolume = 0n
    let cloberAskVolume = 0n
    let cloberVolume = 0n
    const cloberTakenTrades = []
    if (trades.length > 0) {
      for (const trade of trades) {
        const isBid = trade.type === 'bid'
        const actualAmountOut = isBid ? trade.baseAmount : trade.quoteAmount
        const { spentAmount: maxAmountIn } = await getExpectedInput({
          chainId: arbitrumSepolia.id,
          inputToken: isBid ? QUOTE_CURRENCY.address : BASE_CURRENCY.address,
          outputToken: isBid ? BASE_CURRENCY.address : QUOTE_CURRENCY.address,
          amountOut: isBid
            ? formatUnits(trade.baseAmount, BASE_CURRENCY.decimals)
            : formatUnits(trade.quoteAmount, QUOTE_CURRENCY.decimals),
          options: process.env.RPC_URL
            ? {
                rpcUrl: process.env.RPC_URL,
                useSubgraph: false,
              }
            : {},
        })
        let amountIn = isBid
          ? formatUnits(trade.quoteAmount, QUOTE_CURRENCY.decimals)
          : formatUnits(trade.baseAmount, BASE_CURRENCY.decimals)
        amountIn = Math.min(Number(amountIn), Number(maxAmountIn)).toString()
        const {
          transaction,
          result: { taken, spent },
        } = await marketOrder({
          chainId: arbitrumSepolia.id,
          userAddress: account.address,
          inputToken: isBid ? QUOTE_CURRENCY.address : BASE_CURRENCY.address,
          outputToken: isBid ? BASE_CURRENCY.address : QUOTE_CURRENCY.address,
          amountIn,
          options: process.env.RPC_URL
            ? {
                rpcUrl: process.env.RPC_URL,
                useSubgraph: false,
              }
            : {},
        })
        const expectedAmountOut = parseUnits(
          taken.amount,
          taken.currency.decimals,
        )
        const uniswapPrice = new BigNumber(trade.price)
        const cloberPrice = isBid
          ? new BigNumber(spent.amount).div(taken.amount)
          : new BigNumber(taken.amount).div(spent.amount)
        const success =
          (isBid && cloberPrice.lt(uniswapPrice)) ||
          (!isBid && cloberPrice.gt(uniswapPrice))

        console.log(
          `[${success ? 'Succeed' : 'Failed'}][Trade] market ${trade.type} ${amountIn} ${spent.currency.symbol}`,
        )
        console.log(`  Uniswap Price: ${uniswapPrice.toFixed(4)}`)
        console.log(`  Clober Price: ${cloberPrice.toFixed(4)}`)

        if (success) {
          cloberTakenTrades.push(trade)
          numberOfMarketOrders += 1
          cloberBidVolume += expectedAmountOut
          cloberAskVolume += parseUnits(amountIn, spent.currency.decimals)
          cloberVolume += isBid
            ? expectedAmountOut
            : parseUnits(amountIn, spent.currency.decimals)
          const hash = await testnetWalletClient.sendTransaction({
            data: transaction.data,
            to: transaction.to,
            value: transaction.value,
            gas: transaction.gas,
          })
          await waitTransaction(
            'Trade',
            {
              type: isBid ? 'bid' : 'ask',
              amount: isBid
                ? `${formatUnits(trade.quoteAmount, QUOTE_CURRENCY.decimals)} ${QUOTE_CURRENCY.symbol}`
                : `${formatUnits(trade.baseAmount, BASE_CURRENCY.decimals)} ${BASE_CURRENCY.symbol}`,
            },
            testnetPublicClient,
            hash,
          )
          await sendSlackMessage({
            message: `[Trade] ${trade.type} with ${amountIn}`,
            actualAmountOut: `${formatUnits(actualAmountOut, taken.currency.decimals)} ${taken.currency.symbol}`,
            expectedAmountOut: `${formatUnits(expectedAmountOut, taken.currency.decimals)} ${taken.currency.symbol}`,
            hash,
          })
        }
      }
    }

    logger(chalk.green, 'Swap Event', {
      startBlock: Number(startBlock),
      latestBlock: Number(latestBlock),
      hashesLength: hashes.length,
      tradesLength: trades.length,
      uniswapHighestBidPrice:
        trades
          .filter((trade) => trade.type === 'ask')
          .map((trade) =>
            new BigNumber(
              formatUnits(abs(trade.quoteAmount), QUOTE_CURRENCY.decimals),
            )
              .div(formatUnits(abs(trade.baseAmount), BASE_CURRENCY.decimals))
              .toFixed(4),
          )
          .sort((a, b) => Number(b) - Number(a))[0] ?? '-',
      oraclePrice: binance.price('WETH/USDC').toString(),
      onchainPrice: onchainOracle.price('WETH/USDC').toString(),
      uniswapLowestAskPrice:
        trades
          .filter((trade) => trade.type === 'bid')
          .map((trade) =>
            new BigNumber(
              formatUnits(abs(trade.quoteAmount), QUOTE_CURRENCY.decimals),
            )
              .div(formatUnits(abs(trade.baseAmount), BASE_CURRENCY.decimals))
              .toFixed(4),
          )
          .sort((a, b) => Number(a) - Number(b))[0] ?? '-',
      uniswapBidVolume: formatUnits(uniswapBidVolume, BASE_CURRENCY.decimals),
      uniswapAskVolume: formatUnits(uniswapAskVolume, BASE_CURRENCY.decimals),
      uniswapVolume: formatUnits(uniswapVolume, BASE_CURRENCY.decimals),
      cloberBidVolume: formatUnits(cloberBidVolume, BASE_CURRENCY.decimals),
      cloberAskVolume: formatUnits(cloberAskVolume, BASE_CURRENCY.decimals),
      cloberVolume: formatUnits(cloberVolume, BASE_CURRENCY.decimals),
      cloberHighestBidPrice: clober.highestBid('WETH/USDC').toFixed(4) ?? '-',
      cloberLowestAskPrice: clober.lowestAsk('WETH/USDC').toFixed(4) ?? '-',
      askTradesLength: trades.filter((trade) => trade.type === 'ask').length,
      bidTradesLength: trades.filter((trade) => trade.type === 'bid').length,
      numberOfMarketOrders,
    })

    startBlock = latestBlock + 1n
    await new Promise((resolve) => setTimeout(resolve, 2 * 1000))
  }
})()

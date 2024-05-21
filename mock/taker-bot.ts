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
import { approveERC20, marketOrder, type Currency } from '@clober/v2-sdk'
import { privateKeyToAccount } from 'viem/accounts'
import * as YAML from 'yaml'
import chalk from 'chalk'

import { WHITELISTED_CURRENCIES } from '../constants/currency.ts'
import { waitTransaction } from '../utils/transaction.ts'
import { logger } from '../utils/logger.ts'

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

const WETH_USDC_POOLS = [
  '0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59',
  '0xd0b53D9277642d899DF5C87A3966A349A798F224',
]
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
      WETH_USDC_POOLS.map((pool) => getAddress(pool)).includes(
        getAddress(log.address),
      ),
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
    }
  })
}

;(async () => {
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
    const latestBlock = await mainnetPublicClient.getBlockNumber()
    const hashes = await fetchHashesFromSwapEvent(startBlock, latestBlock)
    const trades = await fetchTradeFromHashes(hashes)

    console.log(
      `Fetched ${trades.length} trades from block ${startBlock} to ${latestBlock}`,
    )
    let numberOfMarketOrders = 0
    if (trades.length > 0) {
      for (const trade of trades) {
        const isBid = trade.type === 'bid'
        const actualAmountOut = isBid ? trade.baseAmount : trade.quoteAmount
        const amountIn = isBid
          ? formatUnits(trade.quoteAmount, QUOTE_CURRENCY.decimals)
          : formatUnits(trade.baseAmount, BASE_CURRENCY.decimals)
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
              }
            : {},
        })
        const expectedAmountOut = parseUnits(
          taken.amount,
          taken.currency.decimals,
        )

        if (actualAmountOut < expectedAmountOut) {
          numberOfMarketOrders += 1
          console.log(
            `[Trade] ${trade.type} ${amountIn} ${spent.currency.symbol}`,
          )
          console.log(
            `  Actual amount out: ${formatUnits(actualAmountOut, taken.currency.decimals)} ${taken.currency.symbol}`,
          )
          console.log(
            `  Expected amount out: ${formatUnits(expectedAmountOut, taken.currency.decimals)} ${taken.currency.symbol}`,
          )
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
      askTradesLength: trades.filter((trade) => trade.type === 'ask').length,
      bidTradesLength: trades.filter((trade) => trade.type === 'bid').length,
      numberOfMarketOrders,
    })

    startBlock = latestBlock + 1n
    await new Promise((resolve) => setTimeout(resolve, 2 * 1000))
  }
})()

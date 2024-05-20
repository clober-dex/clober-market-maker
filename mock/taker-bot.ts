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
  zeroAddress,
} from 'viem'
import { arbitrumSepolia, base } from 'viem/chains'
import { approveERC20, marketOrder, type Currency } from '@clober/v2-sdk'
import { privateKeyToAccount } from 'viem/accounts'

import { WHITELISTED_CURRENCIES } from '../constants/currency.ts'
import { waitTransaction } from '../utils/transaction.ts'

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
const BATCH_SIZE = 1000n

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

const fetchHashesFromSwapEvent = async (fromBlock: bigint, toBlock: bigint) => {
  if (fromBlock > toBlock) {
    return []
  }
  const logs = await mainnetPublicClient.getLogs({
    address: '0x19cEeAd7105607Cd444F5ad10dd51356436095a1',
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
    if (trades.length > 0) {
      for (const trade of trades) {
        const isBid = trade.type === 'bid'
        const hash = await marketOrder({
          chainId: arbitrumSepolia.id,
          userAddress: account.address,
          inputToken: isBid ? QUOTE_CURRENCY.address : BASE_CURRENCY.address,
          outputToken: isBid ? BASE_CURRENCY.address : QUOTE_CURRENCY.address,
          amountIn: isBid
            ? formatUnits(trade.quoteAmount, QUOTE_CURRENCY.decimals)
            : formatUnits(trade.baseAmount, BASE_CURRENCY.decimals),
          options: process.env.RPC_URL
            ? {
                rpcUrl: process.env.RPC_URL,
              }
            : {},
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
      }
    }

    startBlock = latestBlock + 1n
    await new Promise((resolve) => setTimeout(resolve, 10 * 1000))
  }
})()

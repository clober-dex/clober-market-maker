import fs from 'fs'

import _ from 'lodash'
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  isAddressEqual,
  parseUnits,
  zeroAddress,
} from 'viem'
import { arbitrumSepolia, base } from 'viem/chains'
import {
  approveERC20,
  CHAIN_IDS,
  type Currency,
  getExpectedInput,
  marketOrder,
} from '@clober/v2-sdk'
import { privateKeyToAccount } from 'viem/accounts'
import * as YAML from 'yaml'
import chalk from 'chalk'

import BigNumber from '../../utils/bignumber.ts'
import { WHITELISTED_CURRENCIES } from '../../constants/currency.ts'
import { waitTransaction } from '../../utils/transaction.ts'
import { logger } from '../../utils/logger.ts'
import { WHITELIST_DEX } from '../../constants/dex.ts'
import { Binance } from '../../model/oracle/binance.ts'
import { type Config } from '../../model/config.ts'
import { Clober } from '../../model/exchange/clober.ts'
import { OnChain } from '../../model/oracle/onchain.ts'
import { TakenTrade } from '../../model/taken-trade.ts'

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

const fetchTradeFromHashes = async (
  fromBlock: bigint,
  toBlock: bigint,
): Promise<
  {
    type: 'bid' | 'ask'
    baseAmount: bigint
    quoteAmount: bigint
    blockNumber: bigint
    price: string
  }[]
> => {
  const whitelistDexes = WHITELIST_DEX[CHAIN_IDS.BASE]['WETH/USDC']
  const logs = await mainnetPublicClient.getLogs({
    address: whitelistDexes.map((dex) => getAddress(dex.address)),
    events: whitelistDexes.map((dex) => dex.swapEvent),
    fromBlock,
    toBlock,
  })

  const trades = whitelistDexes
    .reduce((acc, dex) => acc.concat(dex.extract(logs)), [] as TakenTrade[])
    .sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : Number(a.blockNumber) - Number(b.blockNumber),
    )
  return trades.map((takenTrade) => {
    return {
      type: takenTrade.isTakingBidSide ? 'ask' : 'bid',
      baseAmount: BigInt(
        takenTrade.isTakingBidSide ? takenTrade.amountIn : takenTrade.amountOut,
      ),
      quoteAmount: BigInt(
        takenTrade.isTakingBidSide ? takenTrade.amountOut : takenTrade.amountIn,
      ),
      blockNumber: BigInt(takenTrade.blockNumber),
      price: takenTrade.price,
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
    const trades = await fetchTradeFromHashes(startBlock, latestBlock)
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
            trade.type === 'ask' ? 'Clober Sell Event' : 'Clober Buy Event',
            {
              price: cloberPrice,
              volume: formatUnits(expectedAmountOut, BASE_CURRENCY.decimals),
            },
            testnetPublicClient,
            hash,
            false,
          )
          await sendSlackMessage({
            message: `[Trade] market ${trade.type} with ${amountIn} ${spent.currency.symbol}`,
            actualAmountOut: `${formatUnits(actualAmountOut, taken.currency.decimals)} ${taken.currency.symbol}`,
            expectedAmountOut: `${formatUnits(expectedAmountOut, taken.currency.decimals)} ${taken.currency.symbol}`,
            uniswapPrice: uniswapPrice.toFixed(4),
            cloberPrice: cloberPrice.toFixed(4),
            hash,
          })
        } else {
          if (trade.type === 'ask') {
            logger(
              chalk.redBright,
              'UniSwap Sell Event',
              {
                price: trade.price,
                volume: formatUnits(trade.baseAmount, BASE_CURRENCY.decimals),
              },
              false,
            )
          } else if (trade.type === 'bid') {
            logger(
              chalk.greenBright,
              'UniSwap Buy Event',
              {
                price: trade.price,
                volume: formatUnits(trade.baseAmount, BASE_CURRENCY.decimals),
              },
              false,
            )
          }
        }
      }
    }

    logger(
      chalk.green,
      'Swap Event',
      {
        startBlock: Number(startBlock),
        latestBlock: Number(latestBlock),
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
      },
      false,
    )

    startBlock = latestBlock + 1n
    await new Promise((resolve) => setTimeout(resolve, 2 * 1000))
  }
})()

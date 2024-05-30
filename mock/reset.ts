import fs from 'fs'
import path from 'path'

import {
  type Currency,
  claimOrders,
  cancelOrders,
  getOpenOrders,
} from '@clober/v2-sdk'
import { privateKeyToAccount } from 'viem/accounts'
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseUnits,
  type WalletClient,
} from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import * as yaml from 'yaml'

import { ERC20_PERMIT_ABI } from '../abis/@openzeppelin/erc20-permit-abi.ts'
import { type Config } from '../model/config.ts'

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

const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
})

const balanceOf = async (token: `0x${string}`, account: `0x${string}`) => {
  return publicClient.readContract({
    address: token,
    abi: ERC20_PERMIT_ABI,
    functionName: 'balanceOf',
    args: [account],
  })
}

const transfer = async (
  walletClient: WalletClient,
  currency: Currency,
  recipient: `0x${string}`,
  amount: bigint,
) => {
  const { request } = await publicClient.simulateContract({
    account: walletClient.account,
    address: currency.address,
    abi: ERC20_PERMIT_ABI,
    functionName: 'transfer',
    args: [recipient, amount],
  })
  const hash = await walletClient.writeContract(request)
  await publicClient.waitForTransactionReceipt({
    hash,
  })
  console.log(
    `transfer ${formatUnits(amount, currency.decimals)} ${currency.symbol} to ${recipient}`,
  )
}

const main = async () => {
  const maker = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`)
  const taker = privateKeyToAccount(
    process.env.TAKER_PRIVATE_KEY as `0x${string}`,
  )
  const makerWalletClient = createWalletClient({
    account: maker,
    chain: arbitrumSepolia,
    transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
  })
  const takerWalletClient = createWalletClient({
    account: taker,
    chain: arbitrumSepolia,
    transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
  })

  const openOrders = await getOpenOrders({
    chainId: arbitrumSepolia.id,
    userAddress: maker.address,
  })
  const orderIdsToClaim: string[] = openOrders
    .filter((order) => Number(order.claimable.value) > 0)
    .map((order) => order.id)
  if (orderIdsToClaim.length > 0) {
    const { transaction } = await claimOrders({
      chainId: arbitrumSepolia.id,
      userAddress: maker.address,
      ids: orderIdsToClaim,
    })
    const hash = await makerWalletClient.sendTransaction({
      data: transaction.data,
      to: transaction.to,
      value: transaction.value,
      gas: transaction.gas,
    })
    await publicClient.waitForTransactionReceipt({
      hash,
    })
  }

  const orderIdsToCancel: string[] = openOrders
    .filter((order) => order.amount.value !== order.filled.value)
    .map((order) => order.id)
  if (orderIdsToCancel.length > 0) {
    const { transaction } = await cancelOrders({
      chainId: arbitrumSepolia.id,
      userAddress: maker.address,
      ids: orderIdsToCancel,
    })
    const hash = await makerWalletClient.sendTransaction({
      data: transaction.data,
      to: transaction.to,
      value: transaction.value,
      gas: transaction.gas,
    })
    await publicClient.waitForTransactionReceipt({
      hash,
    })
  }

  const usdcBalance = await balanceOf(QUOTE_CURRENCY.address, maker.address)
  const wethBalance = await balanceOf(BASE_CURRENCY.address, maker.address)
  console.log(
    `USDC balance: ${formatUnits(usdcBalance, QUOTE_CURRENCY.decimals)}`,
    `WETH balance: ${formatUnits(wethBalance, BASE_CURRENCY.decimals)}`,
  )

  if (usdcBalance > 0n) {
    await transfer(
      makerWalletClient,
      QUOTE_CURRENCY,
      taker.address,
      usdcBalance,
    )
  }
  if (wethBalance > 0n) {
    await transfer(makerWalletClient, BASE_CURRENCY, taker.address, wethBalance)
  }

  const afterUsdcBalance = await balanceOf(
    QUOTE_CURRENCY.address,
    maker.address,
  )
  const afterWethBalance = await balanceOf(BASE_CURRENCY.address, maker.address)
  console.log(
    'Maker balances after reset:  ',
    `USDC balance: ${formatUnits(afterUsdcBalance, QUOTE_CURRENCY.decimals)}`,
    `WETH balance: ${formatUnits(afterWethBalance, BASE_CURRENCY.decimals)}`,
  )

  const config = yaml.parse(
    fs.readFileSync(path.join(__dirname, '../config.yaml'), 'utf8'),
  ) as Config
  const startQuoteAmount = config.markets!['WETH/USDC'].params.startQuoteAmount
  const startBaseAmount = config.markets!['WETH/USDC'].params.startBaseAmount

  if (afterWethBalance === 0n && afterUsdcBalance === 0n) {
    await transfer(
      takerWalletClient,
      QUOTE_CURRENCY,
      maker.address,
      parseUnits(startQuoteAmount.toString(), QUOTE_CURRENCY.decimals),
    )
    await transfer(
      takerWalletClient,
      BASE_CURRENCY,
      maker.address,
      parseUnits(startBaseAmount.toString(), BASE_CURRENCY.decimals),
    )
  }
  console.log(
    'Reset balances successfully',
    `WETH: ${await balanceOf(BASE_CURRENCY.address, maker.address)}`,
    `USDC: ${await balanceOf(QUOTE_CURRENCY.address, maker.address)}`,
  )
}

main()

import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, createWalletClient, http } from 'viem'
import {
  cancelOrders,
  CHAIN_IDS,
  claimOrders,
  getOpenOrders,
} from '@clober/v2-sdk'
import { arbitrumSepolia } from 'viem/chains'

import { getPrivateKey } from './utils/wallet.ts'
import { CHAIN_MAP } from './constants/chain.ts'

const main = async () => {
  const chainId = Number(process.env.CHAIN_ID) as CHAIN_IDS
  const account = privateKeyToAccount(getPrivateKey() as `0x${string}`)
  const [publicClient, walletClient] = [
    createPublicClient({
      chain: CHAIN_MAP[chainId],
      transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
    }),
    createWalletClient({
      account,
      chain: CHAIN_MAP[chainId],
      transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
    }),
  ]

  const openOrders = await getOpenOrders({
    chainId: arbitrumSepolia.id,
    userAddress: walletClient.account!.address,
  })
  const orderIdsToClaim: string[] = openOrders
    .filter((order) => Number(order.claimable.value) > 0)
    .map((order) => order.id)
  if (orderIdsToClaim.length > 0) {
    const { transaction } = await claimOrders({
      chainId: arbitrumSepolia.id,
      userAddress: walletClient.account!.address,
      ids: orderIdsToClaim,
    })
    const hash = await walletClient.sendTransaction({
      data: transaction.data,
      to: transaction.to,
      value: transaction.value,
      gas: transaction.gas,
    })
    await publicClient.waitForTransactionReceipt({
      hash,
    })
    console.log('Transaction hash for claiming orders:', hash)
  }

  const orderIdsToCancel: string[] = openOrders
    .filter((order) => order.amount.value !== order.filled.value)
    .map((order) => order.id)
  if (orderIdsToCancel.length > 0) {
    const { transaction } = await cancelOrders({
      chainId: arbitrumSepolia.id,
      userAddress: walletClient.account!.address,
      ids: orderIdsToCancel,
    })
    const hash = await walletClient.sendTransaction({
      data: transaction.data,
      to: transaction.to,
      value: transaction.value,
      gas: transaction.gas,
    })
    await publicClient.waitForTransactionReceipt({
      hash,
    })
    console.log('Transaction hash for cancelling orders:', hash)
  }
}

main()

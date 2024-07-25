import { isAddressEqual, type PublicClient } from 'viem'
import { BOOK_MANAGER_ABI } from '@clober/v2-sdk/dist/types/abis/core/book-manager-abi'
import { CHAIN_IDS, getContractAddresses } from '@clober/v2-sdk'

import BigNumber from './bignumber.ts'

export const calculateOrderSize = ({
  totalBase,
  totalQuote,
  oraclePrice,
  entropy,
  minEntropy,
  balancePercentage,
  minBalancePercentage,
}: {
  totalBase: BigNumber
  totalQuote: BigNumber
  oraclePrice: BigNumber
  entropy: BigNumber
  minEntropy: BigNumber
  balancePercentage: number
  minBalancePercentage: number
}): {
  askOrderSizeInBase: BigNumber
  bidOrderSizeInQuote: BigNumber
} => {
  const [askOrderSizeInBase, bidOrderSizeInBase] = [
    totalBase.times(balancePercentage / 100),
    totalQuote.times(balancePercentage / 100).div(oraclePrice),
  ]
  const [minimumAskOrderSizeInBase, minimumBidOrderSizeInBase] = [
    totalBase.times(minBalancePercentage / 100),
    totalQuote.times(minBalancePercentage / 100).div(oraclePrice),
  ]
  const orderSizeInBase = BigNumber.min(askOrderSizeInBase, bidOrderSizeInBase)
  const cuttedEntropy = BigNumber.max(entropy, minEntropy)

  return {
    askOrderSizeInBase: BigNumber.max(
      orderSizeInBase,
      minimumAskOrderSizeInBase,
    ).times(cuttedEntropy),
    bidOrderSizeInQuote: BigNumber.max(
      orderSizeInBase,
      minimumBidOrderSizeInBase,
    )
      .times(oraclePrice)
      .times(cuttedEntropy),
  }
}

export const filterValidOrders = async ({
  chainId,
  orderIds,
  userAddress,
  publicClient,
}: {
  chainId: CHAIN_IDS
  orderIds: string[]
  userAddress: `0x${string}`
  publicClient: PublicClient
}): Promise<string[]> => {
  const result = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      ...orderIds.map((orderId) => ({
        address: getContractAddresses({ chainId }).BookManager,
        abi: BOOK_MANAGER_ABI,
        functionName: 'ownerOf',
        args: [orderId],
      })),
    ],
  })
  return result
    .map((r, index) => {
      return {
        orderId: orderIds[index],
        owner: r.result as `0x${string}` | undefined,
      }
    })
    .filter(({ owner }) => owner && isAddressEqual(owner, userAddress))
    .map(({ orderId }) => orderId.toString())
}

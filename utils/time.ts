import type { CHAIN_IDS } from '@clober/v2-sdk'

import { CHAIN_MAP } from '../constants/chain.ts'

const currentTimestampInSeconds = (): number =>
  Math.floor(new Date().getTime() / 1000)

export const getDeadlineTimestampInSeconds = (): bigint => {
  return BigInt(Math.floor(currentTimestampInSeconds() + 60 * 60))
}

export const convertTimestampToBlockNumber = async (
  chainId: CHAIN_IDS,
  timestamp: number,
): Promise<bigint> => {
  const response = await fetch(
    `https://coins.llama.fi/block/${CHAIN_MAP[chainId].name.toLowerCase()}/${timestamp}`,
  )
  const { height } = (await response.json()) as {
    height: number
    timestamp: number
  }
  return BigInt(height)
}

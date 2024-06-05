import type { CHAIN_IDS } from '@clober/v2-sdk'

import { CHAIN_MAP } from '../constants/chain.ts'

const currentTimestampInSeconds = (): number =>
  Math.floor(new Date().getTime() / 1000)

export const getDeadlineTimestampInSeconds = (): bigint => {
  return BigInt(Math.floor(currentTimestampInSeconds() + 60 * 60))
}

const cache: {
  [chainId: string]: {
    [timestamp: number]: bigint
  }
} = {}

export const convertTimestampToBlockNumber = async (
  chainId: CHAIN_IDS,
  timestamp: number,
): Promise<bigint> => {
  if (cache[chainId] && cache[chainId][timestamp]) {
    return cache[chainId][timestamp]
  }
  const response = await fetch(
    `https://coins.llama.fi/block/${CHAIN_MAP[chainId].name.toLowerCase()}/${timestamp}`,
  )
  const { height } = (await response.json()) as {
    height: number
    timestamp: number
  }
  cache[chainId] = {
    ...cache[chainId],
    [timestamp]: BigInt(height),
  }
  return BigInt(height)
}

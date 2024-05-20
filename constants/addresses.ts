import { getAddress } from 'viem'

import { CHAIN_IDS } from './chain'

export const CONTROLLER_ADDRESS: {
  [chain in CHAIN_IDS]: `0x${string}`
} = {
  [CHAIN_IDS.ARBITRUM_SEPOLIA]: getAddress(
    '0x91101543D3Bd3e919dAd034Bf978ef9d87290993',
  ),
}

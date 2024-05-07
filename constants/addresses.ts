import { getAddress } from 'viem'

import { CHAIN_IDS } from './chain'

export const CONTROLLER_ADDRESS: {
  [chain in CHAIN_IDS]: `0x${string}`
} = {
  [CHAIN_IDS.ARBITRUM_SEPOLIA]: getAddress(
    '0x3e15fee68C06A0Cd3aF5430A665a9dd502C8544e',
  ),
}

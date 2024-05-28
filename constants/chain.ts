import { arbitrumSepolia, base, type Chain } from 'viem/chains'
import { CHAIN_IDS } from '@clober/v2-sdk'

export const CHAIN_MAP: {
  [chain in CHAIN_IDS]: Chain
} = {
  [CHAIN_IDS.ARBITRUM_SEPOLIA]: arbitrumSepolia,
  [CHAIN_IDS.BASE]: base,
}

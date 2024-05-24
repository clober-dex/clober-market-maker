import { CHAIN_IDS } from '@clober/v2-sdk'

export const CHAINLINK_CONTRACT_ADDRESS: {
  [chain in CHAIN_IDS]: {
    [market: string]: `0x${string}`
  }
} = {
  [CHAIN_IDS.BASE]: {
    'WETH/USDC': '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  },
}

import { CHAIN_IDS } from '@clober/v2-sdk'

import type { Dex } from '../model/dex'
import { UniSwapV3 } from '../model/dex/uniswap-v3.ts'

export const WHITELIST_DEX: {
  [chain in CHAIN_IDS]: {
    [market: string]: Dex[]
  }
} = {
  [CHAIN_IDS.BASE]: {
    'WETH/USDC': [
      new UniSwapV3(
        '0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59',
        {
          address: '0x4200000000000000000000000000000000000006',
          name: 'Wrapped Ether',
          symbol: 'WETH',
          decimals: 18,
        },
        {
          address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
        },
      ),
      new UniSwapV3(
        '0xd0b53D9277642d899DF5C87A3966A349A798F224',
        {
          address: '0x4200000000000000000000000000000000000006',
          name: 'Wrapped Ether',
          symbol: 'WETH',
          decimals: 18,
        },
        {
          address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
        },
      ),
      new UniSwapV3(
        '0xb4CB800910B228ED3d0834cF79D697127BBB00e5',
        {
          address: '0x4200000000000000000000000000000000000006',
          name: 'Wrapped Ether',
          symbol: 'WETH',
          decimals: 18,
        },
        {
          address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
        },
      ),
      new UniSwapV3(
        '0xcDAC0d6c6C59727a65F871236188350531885C43',
        {
          address: '0x4200000000000000000000000000000000000006',
          name: 'Wrapped Ether',
          symbol: 'WETH',
          decimals: 18,
        },
        {
          address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
        },
      ),
      new UniSwapV3(
        '0x72AB388E2E2F6FaceF59E3C3FA2C4E29011c2D38',
        {
          address: '0x4200000000000000000000000000000000000006',
          name: 'Wrapped Ether',
          symbol: 'WETH',
          decimals: 18,
        },
        {
          address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
        },
      ),
      new UniSwapV3(
        '0x24e5610B71385Fe47d0A63297D56FaEF9B07D5C7',
        {
          address: '0x4200000000000000000000000000000000000006',
          name: 'Wrapped Ether',
          symbol: 'WETH',
          decimals: 18,
        },
        {
          address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
        },
      ),
      new UniSwapV3(
        '0xB78daA6D74fE0E23e5C95446CfaDbaDc63205CFc',
        {
          address: '0x4200000000000000000000000000000000000006',
          name: 'Wrapped Ether',
          symbol: 'WETH',
          decimals: 18,
        },
        {
          address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
        },
      ),
      new UniSwapV3(
        '0xB775272E537cc670C65DC852908aD47015244EaF',
        {
          address: '0x4200000000000000000000000000000000000006',
          name: 'Wrapped Ether',
          symbol: 'WETH',
          decimals: 18,
        },
        {
          address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
        },
      ),
    ],
  },
}

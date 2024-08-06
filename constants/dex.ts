import { CHAIN_IDS } from '@clober/v2-sdk'

import type { Dex } from '../model/dex'
import { UniSwapV3 } from '../model/dex/uniswap-v3.ts'
import { PancakeswapV3 } from '../model/dex/pancakeswap-v3.ts'
import { Pool } from '../model/dex/pool.ts'

/*
[BASE & WETH/USDC]

'0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59': v3 -> CLPool(same spec with uniswap v3)
'0xd0b53D9277642d899DF5C87A3966A349A798F224': v3 -> uniswap v3
'0xb4CB800910B228ED3d0834cF79D697127BBB00e5': v3 -> uniswap v3
'0x24e5610B71385Fe47d0A63297D56FaEF9B07D5C7': v3 -> uniswap v3
'0x57713F7716e0b0F65ec116912F834E49805480d2': v3 -> uniswap v3
'0x6c561B446416E1A00E8E93E221854d6eA4171372': v3 -> uniswap v3

'0xB775272E537cc670C65DC852908aD47015244EaF': v3 -> pancake v3
'0x72AB388E2E2F6FaceF59E3C3FA2C4E29011c2D38': v3 -> pancake v3

'0xcDAC0d6c6C59727a65F871236188350531885C43': v2 -> pool
 */
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
        true,
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
        true,
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
        true,
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
        true,
      ),
      new UniSwapV3(
        '0x57713F7716e0b0F65ec116912F834E49805480d2',
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
        true,
      ),
      new UniSwapV3(
        '0x6c561B446416E1A00E8E93E221854d6eA4171372',
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
        true,
      ),
      new PancakeswapV3(
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
        true,
      ),
      new PancakeswapV3(
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
        true,
      ),
      new Pool(
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
        true,
      ),
    ],
  },
}

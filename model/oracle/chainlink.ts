import { CHAIN_IDS } from '@clober/v2-sdk'
import { createPublicClient, http, type PublicClient } from 'viem'
import chalk from 'chalk'

import { CHAIN_MAP } from '../../constants/chain.ts'
import { CHAINLINK_CONTRACT_ADDRESS } from '../../constants/chainlink.ts'
import { logger } from '../../utils/logger.ts'
import BigNumber from '../../utils/bignumber.ts'
import type { Market } from '../market.ts'

import type { Oracle } from './index.ts'

const _abi = [
  {
    inputs: [],
    name: 'latestAnswer',
    outputs: [
      {
        internalType: 'int256',
        name: '',
        type: 'int256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
]

export class ChainLink implements Oracle {
  markets: { [p: string]: Market }
  prices: { [p: string]: BigNumber } = {}

  chainId: CHAIN_IDS
  publicClient: PublicClient

  constructor(chainId: CHAIN_IDS, markets: { [id: string]: Market }) {
    this.chainId = chainId
    this.publicClient = createPublicClient({
      chain: CHAIN_MAP[chainId],
      transport: process.env.ORACLE_RPC_URL
        ? http(process.env.ORACLE_RPC_URL)
        : process.env.RPC_URL
          ? http(process.env.RPC_URL)
          : http(),
    })
    this.markets = markets
  }

  price(id: string): BigNumber {
    return this.prices[id]
  }

  async update() {
    const fetchQueue: Promise<void>[] = []
    const start = performance.now()
    for (const [id] of Object.entries(this.markets)) {
      fetchQueue.push(
        this.publicClient
          .readContract({
            address: CHAINLINK_CONTRACT_ADDRESS[this.chainId][id],
            abi: _abi,
            functionName: 'latestAnswer',
          })
          .then((price) => {
            this.prices[id] = new BigNumber((price as bigint).toString()).div(
              10 ** 8,
            )
          }),
      )
    }

    await Promise.all(fetchQueue)
    const end = performance.now()

    await logger(chalk.yellow, 'ChainLink updated', {
      second: ((end - start) / 1000).toFixed(2),
      markets: Object.keys(this.markets),
      prices: Object.entries(this.markets).map(([id]) => ({
        id,
        price: this.price(id).toString(),
      })),
    })
  }
}

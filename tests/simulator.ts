import fs from 'fs'

import _ from 'lodash'
import { CHAIN_IDS } from '@clober/v2-sdk'
import { arbitrumSepolia } from 'viem/chains'
import * as yaml from 'yaml'

import { DexSimulator } from '../model/dex-simulator.ts'
import { type Market } from '../model/market.ts'
import type { Config, Params } from '../model/config.ts'
import { type TakenTrade } from '../model/taken-trade.ts'

class MockDexSimulator extends DexSimulator {
  constructor(
    chainId: CHAIN_IDS,
    markets: { [id: string]: Market },
    params: { [id: string]: Params },
  ) {
    super(chainId, markets, params)
  }

  updateTrades(trades: { [id: string]: TakenTrade[] } = {}) {
    this.trades = trades
  }
}

const main = async () => {
  const config = yaml.parse(fs.readFileSync('config.yaml', 'utf8')) as Config
  const trades = JSON.parse(fs.readFileSync('tests/trades.json', 'utf8'))
  const mockDexSimulator = new MockDexSimulator(
    arbitrumSepolia.id,
    _.mapValues(config.markets, (m) => m.clober),
    _.mapValues(config.markets, (m) => m.params),
  )

  mockDexSimulator.updateTrades(trades)
  console.log(`number of trades: ${Object.keys(trades['WETH/USDC']).length}`)
  const { askSpread, bidSpread } = mockDexSimulator.findSpread(
    'WETH/USDC',
    0n,
    2n ** 256n - 1n,
    3805.89145,
    3805.89145,
  )
  console.log(`ask spread: ${askSpread}`, `bid spread: ${bidSpread}`)
}

main()

import * as fs from 'fs'
import * as path from 'path'

import * as yaml from 'yaml'
import { CHAIN_IDS } from '@clober/v2-sdk'
import type { WalletClient } from 'viem'
import chalk from 'chalk'

import { logger } from '../utils/logger.ts'

import { Binance } from './binance.ts'
import { Clober } from './clober.ts'
import type { Config } from './config.ts'

export class MarketMaker {
  initialized = false
  config: Config
  walletClient: WalletClient
  binance: Binance
  clober: Clober

  constructor(
    chainId: CHAIN_IDS,
    walletClient: WalletClient,
    configPath?: string,
  ) {
    configPath = configPath ?? path.join(__dirname, '../config.yaml')
    this.config = yaml.parse(fs.readFileSync(configPath, 'utf8')) as Config
    this.walletClient = walletClient
    this.binance = new Binance(
      Object.fromEntries(
        Object.entries(this.config.markets).map(([id, market]) => [
          id,
          {
            symbol: market.binance.symbol,
          },
        ]),
      ),
    )
    this.clober = new Clober(chainId, walletClient, this.config)

    logger(chalk.green, 'MarketMaker initialized', {
      chainId,
      account: walletClient.account?.address,
      configPath,
      rpcUrl: walletClient.transport.url,
    })
  }

  async init() {
    try {
      await Promise.all([this.clober.init()])
      this.initialized = true
    } catch (e) {
      console.error('Error in init', e)
    }
  }

  async run() {
    if (!this.initialized) {
      throw new Error('MarketMaker is not initialized')
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await Promise.all([this.binance.update(), this.clober.update()])
      } catch (e) {
        console.error('Error in update', e)
      }

      await this.sleep(this.config.fetchIntervalMilliSeconds)
    }
  }

  async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

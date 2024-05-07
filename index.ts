import type { CHAIN_IDS } from '@clober/v2-sdk'
import { privateKeyToAccount } from 'viem/accounts'
import { createWalletClient, http } from 'viem'
import * as dotenv from 'dotenv'

dotenv.config()

import { CloberMarketMaker } from './model/clober-market-maker.ts'
import { CHAIN_MAP } from './constants/chain.ts'
;(async () => {
  // const chainId = Number(process.env.CHAIN_ID) as CHAIN_IDS
  // const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`)
  // const walletClient = createWalletClient({
  //   account,
  //   chain: CHAIN_MAP[chainId],
  //   transport: process.env.RPC_URL ? http(process.env.RPC_URL) : http(),
  // })

  const mm = new CloberMarketMaker(process.env.CONFIG)
  await mm.init()
  await mm.run()
})()

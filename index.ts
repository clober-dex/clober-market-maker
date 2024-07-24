import * as dotenv from 'dotenv'

dotenv.config()

import { CloberMarketMaker } from './model/clober-market-maker.ts'
import { getPrivateKey } from './utils/wallet.ts'
;(async () => {
  const privateKey = await getPrivateKey()
  const mm = new CloberMarketMaker(privateKey, process.env.CONFIG)
  await mm.init()
  await mm.run()
})()

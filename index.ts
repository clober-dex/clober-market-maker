import * as dotenv from 'dotenv'

dotenv.config()

import { CloberMarketMaker } from './model/clober-market-maker.ts'
;(async () => {
  const mm = new CloberMarketMaker(process.env.CONFIG)
  await mm.init()
  await mm.run()
})()

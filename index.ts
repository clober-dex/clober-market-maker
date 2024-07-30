import * as dotenv from 'dotenv'

dotenv.config()

import { CloberMarketMaker } from './model/clober-market-maker.ts'
import { getPrivateKey } from './utils/wallet.ts'
import { slackClient } from './utils/logger.ts'
;(async () => {
  const privateKey = await getPrivateKey()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (slackClient) {
      await slackClient.error({
        message: 'Try to start Clober Market Maker',
      })
    }
    const mm = new CloberMarketMaker(privateKey, process.env.CONFIG)
    await mm.init()
    await mm.run()
  }
})()

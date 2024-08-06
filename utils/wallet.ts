import fs from 'fs'
import readline from 'readline'

import * as keythereum from 'keythereum'

import { slackClient } from './logger.ts'

function ask(query: string, hidden = false) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  }) as any
  if (hidden) {
    let t = true
    rl._writeToOutput = (a: string) => {
      if (t) {
        rl.output.write(a)
        t = false
      }
    }
  }
  return new Promise((resolve) =>
    rl.question(query, (ans: string) => {
      if (hidden) {
        rl.output.write('\n\r')
      }
      rl.close()
      resolve(ans)
    }),
  )
}

export const getPrivateKey = async (): Promise<`0x${string}`> => {
  if (slackClient) {
    await slackClient.log({ message: 'Waiting for password' })
  }
  const password = await ask('Password: ', true)
  const keyObject = JSON.parse(fs.readFileSync('./key.json').toString())
  return `0x${keythereum.recover(password as string, keyObject).toString('hex')}`
}

import fs from 'fs'

import * as keythereum from 'keythereum'

export const getPrivateKey = (): `0x${string}` => {
  const password = process.env.PASSWORD || ''
  const keyObject = JSON.parse(fs.readFileSync('./key.json').toString())
  return `0x${keythereum.recover(password, keyObject).toString('hex')}`
}

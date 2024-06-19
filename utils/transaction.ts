import { type PublicClient } from 'viem'
import chalk from 'chalk'

import { logger } from './logger.ts'
import { applyPercent } from './bigint.ts'

export const waitTransaction = async (
  message: string,
  value: any,
  publicClient: PublicClient,
  hash: `0x${string}` | undefined,
  sendMessageToSlack = true,
) => {
  if (hash) {
    await publicClient.waitForTransactionReceipt({
      hash,
    })
    await logger(
      chalk.green,
      `Success ${message}`,
      {
        ...value,
        hash,
      },
      sendMessageToSlack,
    )
  } else {
    await logger(
      chalk.red,
      `Skip ${message}`,
      {
        ...value,
        hash: '',
      },
      sendMessageToSlack,
    )
  }
}

export const getGasPrice = async (
  publicClient: PublicClient,
  gasMultiplier: number = 1.1,
): Promise<bigint> => {
  const gasPrice = await publicClient.getGasPrice()
  return applyPercent(gasPrice, gasMultiplier * 100)
}

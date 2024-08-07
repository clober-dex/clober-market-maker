import { Queue } from 'async-await-queue'
import type { AbiEvent, PublicClient } from 'viem'

import { min } from './bigint.ts'

export const getLogs = async (
  publicClient: PublicClient,
  startBlock: bigint,
  endBlock: bigint,
  address: `0x${string}`[],
  events: AbiEvent[],
  batchSize: bigint = 2000n,
) => {
  const queue = new Queue(10, 1000)

  const p = []
  const allLogs: any[] = []
  for (let i = startBlock; i < endBlock; i += batchSize) {
    /* Each iteration is an anonymous async function */
    p.push(
      (async () => {
        const me = Symbol()
        await queue.wait(me, 0)
        try {
          const fromBlock = BigInt(i === startBlock ? i : i + 1n)
          const toBlock = BigInt(min(i + batchSize, endBlock))
          const logs = await publicClient.getLogs({
            address,
            events,
            fromBlock,
            toBlock,
          })
          allLogs.push(...logs)
        } catch (e) {
          console.error(`Error in block ${i}: ${e}`)
        } finally {
          queue.end(me)
        }
      })(),
    )
  }

  await Promise.all(p)

  return allLogs
}

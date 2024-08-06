import {
  type AbiEvent,
  formatUnits,
  getAddress,
  isAddressEqual,
  parseAbiItem,
  parseEventLogs,
} from 'viem'
import type { Currency } from '@clober/v2-sdk'

import type { TakenTrade } from '../taken-trade.ts'
import BigNumber from '../../utils/bignumber'
import { abs } from '../../utils/bigint.ts'

import type { Dex } from './index.ts'

export class PancakeswapV3 implements Dex {
  address: `0x${string}`
  swapEvent: AbiEvent
  currency0: Currency
  currency1: Currency
  isCurrency0Base: boolean

  constructor(
    address: `0x${string}`,
    currency0: Currency,
    currency1: Currency,
    isCurrency0Base: boolean,
  ) {
    this.address = getAddress(address)
    this.swapEvent = parseAbiItem(
      'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)',
    )
    this.currency0 = currency0
    this.currency1 = currency1
    this.isCurrency0Base = isCurrency0Base
  }

  extract(logs: any[]): TakenTrade[] {
    const filterLogs = logs.filter((log: any) =>
      isAddressEqual(log.address, this.address),
    )
    const parseLogs: any[] = parseEventLogs({
      abi: [this.swapEvent],
      logs: filterLogs,
    })
    return parseLogs.map((log) => {
      const blockNumber = Number(log.blockNumber)
      const logIndex = Number(log.logIndex)
      const amount0 = BigInt(log.args.amount0)
      const amount1 = BigInt(log.args.amount1)
      const price = BigNumber(
        formatUnits(abs(amount1), this.currency1.decimals),
      ).div(formatUnits(abs(amount0), this.currency0.decimals))
      return {
        logIndex,
        isTakingBidSide: this.isCurrency0Base ? amount0 > 0n : amount1 > 0n,
        amountIn:
          amount0 > 0n
            ? formatUnits(abs(amount0), this.currency0.decimals)
            : formatUnits(abs(amount1), this.currency1.decimals),
        amountOut:
          amount0 > 0n
            ? formatUnits(abs(amount1), this.currency1.decimals)
            : formatUnits(abs(amount0), this.currency0.decimals),
        price: (this.isCurrency0Base
          ? price
          : BigNumber(1).div(price)
        ).toFixed(),
        pool: this.address,
        blockNumber: blockNumber,
        currency0: this.currency0,
        currency1: this.currency1,
      }
    })
  }
}

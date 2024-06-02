import {
  formatUnits,
  getAddress,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
} from 'viem'
import type { Currency } from '@clober/v2-sdk'

import type { TakenTrade } from '../taken-trade.ts'
import BigNumber from '../../utils/bignumber'
import { abs } from '../../utils/bigint.ts'

import type { Dex } from './index.ts'

export class UniSwapV3 implements Dex {
  address: `0x${string}`
  currency0: Currency // baseCurrency
  currency1: Currency

  constructor(
    address: `0x${string}`,
    currency0: Currency,
    currency1: Currency,
  ) {
    this.address = getAddress(address)
    this.currency0 = currency0
    this.currency1 = currency1
  }

  extract(logs: any[]): TakenTrade[] {
    const filterLogs = logs.filter((log: any) =>
      isAddressEqual(log.address, this.address),
    )
    const parseLogs = parseEventLogs({
      abi: parseAbi([
        'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
      ]),
      logs: filterLogs,
    })
    return parseLogs.map(
      ({ blockNumber, logIndex, args: { sqrtPriceX96, amount0, amount1 } }) => {
        return {
          logIndex,
          isTakingBidSide: amount0 > 0n,
          amountIn:
            amount0 > 0n
              ? formatUnits(abs(amount0), this.currency0.decimals)
              : formatUnits(abs(amount1), this.currency1.decimals),
          amountOut:
            amount0 > 0n
              ? formatUnits(abs(amount1), this.currency1.decimals)
              : formatUnits(abs(amount0), this.currency0.decimals),
          price: new BigNumber(sqrtPriceX96.toString())
            .div(new BigNumber(2).pow(96))
            .pow(2)
            .times(
              new BigNumber(10).pow(
                this.currency0.decimals - this.currency1.decimals,
              ),
            )
            .toFixed(),
          pool: this.address,
          blockNumber: Number(blockNumber),
          currency0: this.currency0,
          currency1: this.currency1,
        }
      },
    )
  }
}

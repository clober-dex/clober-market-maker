export const abs = (n: bigint) => (n < 0n ? -n : n)

export const applyPercent = (
  amount: bigint,
  percent: number,
  decimal: number = 6,
): bigint => {
  return (
    (amount * BigInt(Math.floor(percent * 10 ** decimal))) /
    BigInt(100 * 10 ** decimal)
  )
}

export const max = (a: bigint, b: bigint): bigint => (a > b ? a : b)

export const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)

export const median = (values: bigint[]): bigint | undefined => {
  if (values.length === 0) {
    return undefined
  }
  const sorted = values.sort((a, b) => Number(a - b))
  const half = Math.floor(sorted.length / 2)
  return sorted[half]
}

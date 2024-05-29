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

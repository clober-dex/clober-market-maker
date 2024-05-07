export type Config = {
  fetchIntervalMilliSeconds: number
  gasMultiplier: number
  markets: {
    [id: string]: {
      binance: {
        symbol: string
      }
      clober: {
        quote: string
        base: string
      }
      params: {
        defaultBaseBalance: number
        deltaLimit: number
        minSpread: number
        maxSpread: number
        orderGap: number
        orderNum: number
        orderSize: number
        minOrderSize: number
      }
    }
  }
}

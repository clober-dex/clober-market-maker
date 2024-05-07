import type { ChalkInstance } from 'chalk'

export const logger = (color: ChalkInstance, message: string, value: any) => {
  try {
    console.log(
      color(
        `[${new Date().toISOString().replace('T', ' ').replace('Z', '')}]`,
        message,
        JSON.stringify(value),
      ),
    )
  } catch (e) {
    console.error('Error in logger', e)
  }
}

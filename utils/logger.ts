import type { ChalkInstance } from 'chalk'

export const logger = (color: ChalkInstance, message: string, value: any) => {
  try {
    console.log(color(message, JSON.stringify(value)))
  } catch (e) {
    console.error('Error in logger', e)
  }
}

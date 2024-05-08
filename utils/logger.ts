import type { ChalkInstance } from 'chalk'

import { SlackClient } from './slack.ts'

export const slackClient =
  process.env.SLACK_INFO_WEBHOOK && process.env.SLACK_ERROR_WEBHOOK
    ? new SlackClient(
        process.env.SLACK_INFO_WEBHOOK,
        process.env.SLACK_ERROR_WEBHOOK,
      )
    : undefined

export const logger = async (
  color: ChalkInstance,
  message: string,
  value: any,
) => {
  try {
    console.log(
      color(
        `[${new Date().toISOString().replace('T', ' ').replace('Z', '')}]`,
        message,
        JSON.stringify(value),
      ),
    )

    if (slackClient) {
      await slackClient.log({
        message,
        ...value,
      })
    }
  } catch (e) {
    console.error('Error in logger', e)
  }
}

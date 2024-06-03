import type { ChalkInstance } from 'chalk'
import { createLogger, format, Logger, transports } from 'winston'
import LokiTransport from 'winston-loki'
import type { CHAIN_IDS } from '@clober/v2-sdk'

import { CHAIN_MAP } from '../constants/chain.ts'

import { SlackClient } from './slack.ts'

export const slackClient =
  process.env.SLACK_INFO_WEBHOOK && process.env.SLACK_ERROR_WEBHOOK
    ? new SlackClient(
        process.env.SLACK_INFO_WEBHOOK,
        process.env.SLACK_ERROR_WEBHOOK,
      )
    : undefined

let lokiLogger: Logger | undefined = undefined

const initializeLokiLogger = () => {
  if (lokiLogger) {
    return
  }
  if (
    !process.env.DASHBOARD_PASSWORD ||
    !process.env.DASHBOARD_URL ||
    !process.env.CHAIN_ID
  ) {
    return
  }
  const chain = CHAIN_MAP[Number(process.env.CHAIN_ID) as CHAIN_IDS]

  lokiLogger = createLogger({
    transports: [
      new LokiTransport({
        host: process.env.DASHBOARD_URL,
        labels: { app: `clober-mm-${chain.name}` },
        basicAuth: `admin:${process.env.DASHBOARD_PASSWORD}`,
        json: true,
        level: 'debug',
        format: format.json(),
        replaceTimestamp: true,
        clearOnError: false,
        onConnectionError: (err) => console.error(err),
      }),
      new transports.Console({
        format: format.combine(format.simple(), format.colorize()),
      }),
    ],
  })
}

const getLokiLogger = () => {
  initializeLokiLogger()
  return lokiLogger
}

export const logger = async (
  color: ChalkInstance,
  message: string,
  value: any,
) => {
  const lokiLogger = getLokiLogger()
  try {
    console.log(
      color(
        `[${new Date().toISOString().replace('T', ' ').replace('Z', '')}]`,
        message,
        JSON.stringify(value),
      ),
    )

    if (lokiLogger) {
      lokiLogger.debug({
        message,
        ...value,
      })
    }

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

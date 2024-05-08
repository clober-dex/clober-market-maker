import * as YAML from 'yaml'

export class SlackClient {
  infoChannelUrl: string
  errorChannelUrl: string
  constructor(infoChannel: string, errorChannel: string) {
    this.infoChannelUrl = infoChannel
    this.errorChannelUrl = errorChannel
  }

  private async sendMessage(type: 'info' | 'error', message: string) {
    const url = type === 'info' ? this.infoChannelUrl : this.errorChannelUrl
    if (url.length === 0) {
      return
    }

    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: '```\n' + message + '```',
      }),
    })
  }

  public async log(message: {}) {
    await this.sendMessage('info', YAML.stringify(message))
  }

  public async error(message: {}) {
    await this.sendMessage('error', YAML.stringify(message))
  }
}

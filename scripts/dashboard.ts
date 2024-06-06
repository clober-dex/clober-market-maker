import fs from 'fs'

const getUIDs = async (url: string) => {
  const response = await fetch(`${url}/api/search`)
  const data = (await response.json()) as {
    uid: string
  }[]
  return data.map((d) => d.uid)
}

const main = async () => {
  const url = process.env.DASHBOARD_URL || ''
  const uids = await getUIDs(url)
  for (const uid of uids) {
    const response = await fetch(`${url}/api/dashboards/uid/${uid}`)
    const { dashboard } = (await response.json()) as {
      dashboard: any & {
        title: string
      }
    }
    fs.writeFileSync(
      `dashboards/${dashboard.title}.json`,
      JSON.stringify(dashboard, null, 2),
    )
  }
}

main()

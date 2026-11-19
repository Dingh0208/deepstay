export type ReleaseNotes = { version: string; changes: string[] }

export const parseReleaseNotes = (changelog: string): ReleaseNotes[] => {
  const releases: ReleaseNotes[] = []
  for (const line of changelog.split(/\r?\n/)) {
    const heading = /^## (\d+\.\d+\.\d+)$/.exec(line)
    if (heading) {
      releases.push({ version: heading[1], changes: [] })
      continue
    }
    const item = /^- (.+)$/.exec(line)
    if (item && releases.length) {
      releases[releases.length - 1].changes.push(item[1].replace(/`([^`]+)`/g, '$1'))
    }
  }
  return releases
}

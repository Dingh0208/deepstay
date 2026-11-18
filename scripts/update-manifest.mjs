import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const apkName = `deepstay-${version}.apk`
const baseUrl = process.argv[2]
if (!baseUrl || !baseUrl.endsWith('/') || new URL(baseUrl).protocol !== 'https:') {
  throw new Error('Pass the public HTTPS update directory ending in /, such as https://downloads.example.com/deepstay/')
}
const apk = readFileSync(path.join(root, 'release', apkName))
const manifest = {
  version,
  apkUrl: new URL(apkName, baseUrl).href,
  sha256: createHash('sha256').update(apk).digest('hex'),
}
mkdirSync(path.join(root, 'release'), { recursive: true })
writeFileSync(path.join(root, 'release', 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Upload ${apkName} first, then latest.json to ${baseUrl}`)

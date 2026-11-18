import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const directory = new URL('../tests/', import.meta.url)
const files = (await readdir(directory)).filter((name) => name.endsWith('-regression.mjs')).sort()
for (const name of files) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(name, directory))], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(`Passed ${files.length} regression suites`)

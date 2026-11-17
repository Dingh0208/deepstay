import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, ['scripts/build.mjs'])
run(process.execPath, ['node_modules/@capacitor/cli/bin/capacitor', 'sync', 'android'])

if (process.argv[2] === 'release') {
  const android = path.join(root, 'android')
  if (process.platform === 'win32') {
    run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'gradlew.bat --no-daemon assembleRelease'], android)
  } else {
    run('sh', ['gradlew', '--no-daemon', 'assembleRelease'], android)
  }
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const output = path.join(root, 'release', `deepstay-${version}.apk`)
  mkdirSync(path.dirname(output), { recursive: true })
  copyFileSync(path.join(android, 'app/build/outputs/apk/release/app-release.apk'), output)
  console.log(`Signed APK: ${output}`)
}

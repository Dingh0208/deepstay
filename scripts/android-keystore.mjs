import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const directory = path.join(os.homedir(), '.deepstay', 'signing')
const keystore = path.join(directory, 'deepstay-release.jks')
const properties = path.join(directory, 'signing.properties')
if (existsSync(keystore) || existsSync(properties)) {
  if (!existsSync(keystore) || !existsSync(properties)) throw new Error('Signing files are incomplete. Restore the existing signing backup; do not generate a replacement key.')
  console.log(`Existing signing key retained: ${keystore}`)
  process.exit(0)
}
mkdirSync(directory, { recursive: true, mode: 0o700 })
if (process.platform === 'win32') {
  const identity = spawnSync('whoami', [], { encoding: 'utf8' }).stdout.trim()
  const acl = spawnSync('icacls', [directory, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { stdio: 'ignore' })
  if (acl.status !== 0) throw new Error('Unable to protect signing directory')
}
const password = randomBytes(32).toString('hex')
const keytool = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : 'keytool'
const result = spawnSync(keytool, [
  '-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', 'deepstay',
  '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
  '-dname', 'CN=deepstay, O=deepstay, C=CN',
  '-storepass:env', 'DEEPSTAY_NEW_KEY_PASSWORD', '-keypass:env', 'DEEPSTAY_NEW_KEY_PASSWORD',
], { env: { ...process.env, DEEPSTAY_NEW_KEY_PASSWORD: password }, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
writeFileSync(properties, `storeFile=${keystore.replaceAll('\\', '/')}\nstorePassword=${password}\nkeyAlias=deepstay\nkeyPassword=${password}\n`, { mode: 0o600 })
console.log(`Signing key created: ${keystore}`)
console.log('Back up this private directory. Future updates must use the same key.')

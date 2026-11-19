import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const fixture = await mkdtemp(path.join(tmpdir(), 'deepstay-update-manifest-'))
try {
  await mkdir(path.join(fixture, 'scripts'))
  await mkdir(path.join(fixture, 'release'))
  await copyFile(new URL('../scripts/update-manifest.mjs', import.meta.url), path.join(fixture, 'scripts/update-manifest.mjs'))
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ version: '0.1.8' }))
  const apkPath = path.join(fixture, 'release/deepstay-0.1.8.apk')
  const manifestPath = path.join(fixture, 'release/latest.json')
  const generate = (base = 'https://downloads.example.test/updates/') => spawnSync(
    process.execPath, [path.join(fixture, 'scripts/update-manifest.mjs'), base], { encoding: 'utf8' }
  )
  const urls = []
  for (const content of [Buffer.from('first signed APK fixture'), Buffer.from('a different APK with the same version')]) {
    await writeFile(apkPath, content)
    const result = generate()
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const digest = createHash('sha256').update(content).digest('hex')
    assert.deepEqual(manifest, {
      version: '0.1.8',
      apkUrl: `https://downloads.example.test/updates/deepstay-0.1.8-${digest}.apk`,
      sha256: digest,
    })
    assert.deepEqual(await readFile(apkPath), content, 'The local/GitHub APK keeps its original name and bytes')
    urls.push(manifest.apkUrl)
  }
  assert.notEqual(urls[0], urls[1], 'Different APKs for the same version cannot share a resumable destination or cache key')
  const previous = await readFile(manifestPath, 'utf8')
  assert.notEqual(generate('http://downloads.example.test/updates/').status, 0)
  assert.notEqual(generate('https://downloads.example.test/updates').status, 0)
  assert.equal(await readFile(manifestPath, 'utf8'), previous, 'Invalid destinations leave the previous manifest intact')
  console.log('Passed update manifest content-addressed URL and local artifact regression')
} finally {
  await rm(fixture, { recursive: true, force: true })
}

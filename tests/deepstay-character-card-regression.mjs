import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { deflateSync } from 'node:zlib'
import { zipSync } from 'fflate'

const moduleURL = new URL('../src/services/characterCards.ts', import.meta.url)
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === moduleURL.href) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
    }
    return nextLoad(url, context)
  },
})
const { importCharacterCard, exportCharacterCard } = await import(moduleURL)
globalThis.fetch = () => { throw new Error('Character cards must not use the network') }
const file = (content, name = 'character.json') => new File([content], name)
const jsonFile = (value) => file(JSON.stringify(value))
const utf8 = (text) => new TextEncoder().encode(text)
const card = {
  name: '林晚', nickname: '阿晚', description: '{{char}}记得和{{user}}一起看海的约定。',
  personality: '温柔，保留{{unknown}}宏。', scenario: '海边', first_mes: '{{CHAR}}：{{USER}}，你回来啦。',
  mes_example: '{{user}}：晚安\n{{char}}：好梦。', system_prompt: '保持人物语气。',
  post_history_instructions: '尊重既有约定。', creator_notes: 'PRIVATE CREATOR NOTES',
  alternate_greetings: ['另一个开场'], character_book: { entries: [] }, extensions: { script: 'must not run' },
}
const v3 = { spec: 'chara_card_v3', spec_version: '3.0', data: card }
const imported = await importCharacterCard(jsonFile(v3))
assert.equal(imported.name, '林晚')
assert.equal(imported.greeting, '阿晚：用户，你回来啦。')
assert.deepEqual(imported.alternateGreetings, ['另一个开场'])
for (const content of ['阿晚记得和用户', '温柔', '海边', '对话示例', '保持人物语气', '角色补充约定', '{{unknown}}']) {
  assert.ok(imported.prompt.includes(content), content)
}
assert.ok(!imported.prompt.includes('PRIVATE CREATOR NOTES'))
assert.ok(!imported.prompt.includes('must not run'))
assert.deepEqual(imported.warnings, ['text-only'])
for (const value of [card, { spec: 'chara_card_v2', data: card }]) {
  assert.deepEqual(await importCharacterCard(jsonFile(value)), imported)
}
const fallback = await importCharacterCard(jsonFile({ ...card, nickname: '', first_mes: '', alternate_greetings: ['', ' {{char}}等{{user}}。 '] }))
assert.equal(fallback.greeting, '')
assert.deepEqual(fallback.alternateGreetings, ['', '林晚等用户。'])
const onePass = await importCharacterCard(jsonFile({ name: '名字', nickname: '{{user}}', description: '{{char}}保留未知{{other}}。' }))
assert.ok(onePass.prompt.includes('{{user}}保留未知{{other}}。'), 'Imported macro replacement must not evaluate its replacement text again')
const native = JSON.parse(exportCharacterCard({ ...imported, id: 'private-id', updatedAt: 123 }))
assert.deepEqual(Object.keys(native).sort(), ['alternateGreetings', 'format', 'greeting', 'name', 'prompt', 'version'])
assert.equal(native.format, 'deepstay-character')
assert.equal(native.version, 1)
assert.deepEqual(await importCharacterCard(jsonFile(native)), { name: imported.name, prompt: imported.prompt, greeting: imported.greeting, alternateGreetings: imported.alternateGreetings, warnings: [] })
const oldNative = { format: 'deepstay-character', version: 1, name: '旧人物', prompt: '旧设定', greeting: '' }
assert.deepEqual(await importCharacterCard(jsonFile(oldNative)), { name: '旧人物', prompt: '旧设定', greeting: '', warnings: [] })
assert.equal(Object.hasOwn(JSON.parse(exportCharacterCard(oldNative)), 'alternateGreetings'), false)
const many = { ...card, first_mes: '', alternate_greetings: ['', '{{char}}为{{user}}留了一盏灯。', '第三个开场'] }
const manyImported = await importCharacterCard(jsonFile(many))
assert.deepEqual(manyImported.alternateGreetings, ['', '阿晚为用户留了一盏灯。', '第三个开场'])
assert.deepEqual(await importCharacterCard(jsonFile(JSON.parse(exportCharacterCard(manyImported)))), { ...manyImported, warnings: [] })

const crc32 = (bytes) => {
  let crc = -1
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ -1) >>> 0
}
const chunk = (type, body) => {
  const bytes = Buffer.alloc(body.length + 12)
  bytes.writeUInt32BE(body.length)
  bytes.write(type, 4)
  bytes.set(body, 8)
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4)
  return bytes
}
const metadata = (key, value) => chunk('tEXt', Buffer.from(`${key}\0${Buffer.from(value).toString('base64')}`))
const png = (...metadataChunks) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr.set([8, 6], 8)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...metadataChunks,
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0)),
  ])
}
const v3PNG = png(metadata('chara', JSON.stringify({ ...card, name: '旧卡' })), metadata('ccv3', JSON.stringify(v3)))
assert.deepEqual(await importCharacterCard(file(v3PNG, 'card.png')), imported)
assert.deepEqual(await importCharacterCard(file(png(metadata('chara', JSON.stringify(card))), 'card.png')), imported)
await assert.rejects(importCharacterCard(file(png(metadata('chara', JSON.stringify(card)), metadata('ccv3', 'broken')), 'card.png')))
await assert.rejects(importCharacterCard(file(png(), 'ordinary-image.png')))
await assert.rejects(importCharacterCard(file(png(chunk('tEXt', Buffer.from('ccv3\0!!!!'))), 'bad-base64.png')))
await assert.rejects(importCharacterCard(file(v3PNG.subarray(0, v3PNG.length - 4), 'truncated.png')))
const corruptLength = Buffer.from(v3PNG)
corruptLength.writeUInt32BE(0xffffffff, 33)
await assert.rejects(importCharacterCard(file(corruptLength, 'invalid-length.png')))

const charx = zipSync({ 'card.json': utf8(JSON.stringify(v3)), '../ignored-asset.js': utf8('must not run'), 'assets/portrait.bin': new Uint8Array(3 * 1024 * 1024) })
assert.deepEqual(await importCharacterCard(file(charx, 'card.charx')), imported)
assert.deepEqual(await importCharacterCard(file(png(metadata('ccv3', JSON.stringify({ spec: 'chara_card_v3', data: many }))), 'many.png')), manyImported)
assert.deepEqual(await importCharacterCard(file(zipSync({ 'card.json': utf8(JSON.stringify({ spec: 'chara_card_v3', data: many })) }), 'many.charx')), manyImported)
const ignoredUnsupportedAsset = Buffer.from(zipSync({ 'card.json': utf8(JSON.stringify(v3)), 'ignored.bin': new Uint8Array(1024) }))
for (let offset = 0; offset + 46 < ignoredUnsupportedAsset.length; offset++) {
  if (ignoredUnsupportedAsset.readUInt32LE(offset) === 0x02014b50 && ignoredUnsupportedAsset.subarray(offset + 46, offset + 57).toString() === 'ignored.bin') {
    ignoredUnsupportedAsset.writeUInt16LE(99, offset + 10)
  }
}
assert.deepEqual(await importCharacterCard(file(ignoredUnsupportedAsset, 'unsupported-asset.charx')), imported, 'Unrelated ZIP assets must never be decompressed')
const duplicateCard = Buffer.from(zipSync({ 'card.json': utf8(JSON.stringify(v3)), 'copy.json': utf8(JSON.stringify(v3)) }))
for (let offset = duplicateCard.indexOf('copy.json'); offset >= 0; offset = duplicateCard.indexOf('copy.json')) {
  duplicateCard.write('card.json', offset)
}
await assert.rejects(importCharacterCard(file(duplicateCard, 'duplicate-root.charx')))
await assert.rejects(importCharacterCard(file(zipSync({ 'folder/card.json': utf8(JSON.stringify(v3)) }), 'missing-root.charx')))
await assert.rejects(importCharacterCard(file(zipSync({ 'card.json': new Uint8Array(200 * 1024 + 1).fill(32) }), 'oversized-json.charx')))
await assert.rejects(importCharacterCard(file(charx.subarray(0, charx.length - 20), 'corrupt.charx')))
await assert.rejects(importCharacterCard(file(png(metadata('ccv3', ' '.repeat(200 * 1024 + 1))), 'oversized-metadata.png')))
await assert.rejects(importCharacterCard(file(new Uint8Array(20 * 1024 * 1024 + 1), 'oversized.png')))
await assert.rejects(importCharacterCard(file(new Uint8Array(200 * 1024 + 1).fill(32))))
for (const invalid of [
  [], null, { spec: 'unknown', data: card }, { spec: 'chara_card_v3', data: [] },
  { ...card, name: '' }, { ...card, name: '名'.repeat(101) }, { ...card, description: 42 },
  { ...card, description: '设'.repeat(20_001) }, { ...card, first_mes: '开'.repeat(10_001) },
  { ...card, alternate_greetings: [null] }, { ...card, alternate_greetings: null },
  { ...card, alternate_greetings: ['x'.repeat(10_001)] }, { ...card, alternate_greetings: Array(100).fill('') },
  { ...card, first_mes: '', alternate_greetings: Array(11).fill('x'.repeat(10_000)) },
  { ...oldNative, alternateGreetings: 'bad' }, { ...oldNative, alternateGreetings: [false] },
  { format: 'deepstay-character', version: 2, ...imported },
  { name: '世界书', entries: [] }, { format: 'other-app', name: '角色', prompt: '内容' },
]) await assert.rejects(importCharacterCard(jsonFile(invalid)))
await assert.rejects(importCharacterCard(file('not json')))
await assert.rejects(importCharacterCard(file(new Uint8Array([255, 254, 255]))))
assert.throws(() => exportCharacterCard({ name: '', prompt: '设定', greeting: '' }))
assert.throws(() => exportCharacterCard({ ...oldNative, alternateGreetings: ['x'.repeat(10_001)] }))
assert.throws(() => exportCharacterCard({ name: '大卡', prompt: '中'.repeat(20_000), greeting: '', alternateGreetings: Array(9).fill('中'.repeat(10_000)) }), /Invalid or oversized/)
hooks.deregister()
console.log('Passed character card regression: JSON/PNG/CHARX, macro expansion, text-only boundaries, roundtrip and size/corruption checks')

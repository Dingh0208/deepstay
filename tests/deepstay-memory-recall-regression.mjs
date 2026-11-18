import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
    }
    return nextLoad(url, context)
  },
})

const { recallMemory, estimateMemoryTokens } = await import(new URL('services/chat/memoryRecall.ts', sourceRoot))
const { getVisibleMessages } = await import(new URL('services/chat/branches.ts', sourceRoot))
const user = (id, content, extra = {}) => ({ id, role: 'user', content, files: [], createdAt: Date.UTC(2026, 10, 1), ...extra })
const assistant = (id, text, extra = {}) => ({ id, role: 'assistant', prefix: false, model: null, status: 'done', stopReason: 'end_turn', createdAt: Date.UTC(2026, 10, 1, 0, 1), blocks: [{ type: 'text', text }], ...extra })
const round = (id, content, reply = '我听见了。') => [user(`u-${id}`, content), assistant(`a-${id}`, reply)]
const signal = () => new AbortController().signal
const ask = async (question, history, extra = {}) => recallMemory({ sessionId: 'chat-a', history, question: user('question', question), recent: [], records: [], signal: signal(), ...extra })
const checks = []

try {
  const original = [
    ...round('origin', '我们的暗号是月光邮局。2026-11-05，阿青约定去看海。', '如果下雨就推迟；这是未来的计划，不是已经去过。'),
    ...Array.from({ length: 120 }, (_, index) => round(`filler-${index}`, `今天分享第${index}次日常。`)).flat(),
  ]
  const snapshot = JSON.stringify(original)
  const recalled = await ask('阿青在2026-11-05约定的看海计划是什么？暗号“月光邮局”是什么？', original)
  assert.ok(recalled.includes('我们的暗号是月光邮局'))
  assert.ok(recalled.includes('2026-11-05'))
  assert.ok(recalled.includes('如果下雨就推迟'))
  assert.ok(recalled.includes('不是已经去过'))
  assert.ok(recalled.includes('user · 2026-11-01T00:00:00.000Z · u-origin'))
  assert.ok(recalled.includes('assistant · 2026-11-01T00:01:00.000Z · a-origin'))
  assert.ok(!recalled.includes('第119次日常'))
  assert.equal(JSON.stringify(original), snapshot)
  assert.ok(estimateMemoryTokens(recalled) <= 3_000)
  checks.push('Retrieves a distant dated event and exact nickname/passphrase with the original user/assistant roles, preserving nearby conditions and negation without changing history')

  const branch = {
    id: 'chat-a', rootMessageId: 'root-u', title: '', createdAt: 1, updatedAt: 1,
    messages: [
      user('root-u', '我们谈谈周五的安排。', { parentId: null, selectedChildId: 'root-a' }),
      assistant('root-a', '周五去看海。', { parentId: 'root-u', selectedChildId: 'branch-a-u' }),
      user('branch-a-u', '更正安排：周五在月光邮局见面。', { parentId: 'root-a', selectedChildId: 'branch-a-a' }),
      assistant('branch-a-a', '月光邮局见。', { parentId: 'branch-a-u' }),
      user('branch-b-u', '分支乙的暗号是星舰船长。', { parentId: 'root-a', selectedChildId: 'branch-b-a' }),
      assistant('branch-b-a', '星舰船长收到。', { parentId: 'branch-b-u' }),
    ],
  }
  const otherChatRecord = { id: 'wrong-session', sessionId: 'chat-b', key: '月光邮局', text: '别的会话', sources: [{ messageId: 'root-u', start: 0, end: 4, fingerprint: 'unused' }] }
  const hiddenBranchRecord = { id: 'wrong-path', sessionId: 'chat-a', key: '月光邮局', text: '另一个分支', sources: [{ messageId: 'branch-b-u', start: 0, end: 4, fingerprint: 'unused' }] }
  const visible = getVisibleMessages(branch)
  const selected = await ask('月光邮局约定是什么？', visible, { records: [otherChatRecord, hiddenBranchRecord] })
  assert.ok(selected.includes('月光邮局'))
  assert.ok(!selected.includes('星舰船长'))
  assert.ok(!selected.includes('别的会话'))
  assert.ok(!selected.includes('另一个分支'))
  assert.equal(await ask('星舰船长', visible, { records: [hiddenBranchRecord] }), '')
  checks.push('Only recalls supplied current-branch history and rejects record hints from other sessions or sources absent from that path')

  assert.equal(await ask('你还记得吗？', original), '')
  assert.equal(await ask('Do you remember?', original), '')
  assert.equal(await ask('不存在的独特暗号白矮星号', round('quiet', '今天普通问候。')), '')
  const recent = round('recent', '阿青和月光邮局。')
  const withRecent = await ask('月光邮局是什么？', [...original, ...recent], { recent })
  assert.ok(!withRecent.includes('u-recent'))
  checks.push('Empty recall intent or absent evidence returns no invented material, and recent complete messages are not repeated as recalled history')

  const unrelatedRecent = round('recent-only', '最近在讨论月光邮局的旅行。')
  assert.equal(await ask('紫色玫瑰的线索是什么？', [...original, ...unrelatedRecent], { recent: unrelatedRecent }), '',
    'Recent context may rank a match, but must not invent a match for an unrelated current question')
  const repeatedPreference = `${'我的颜色偏好是红色。'.repeat(120)}更正：我的颜色偏好现在是蓝色。`
  const correctedPreference = await ask('我的颜色偏好是什么？', round('repeated-preference', repeatedPreference))
  assert.ok(correctedPreference.includes('更正：我的颜色偏好现在是蓝色'),
    'A repeated early phrase must not hide a later correction within the same scan chunk')
  checks.push('Recent supplementation cannot alone trigger unrelated recall, and repeated early mentions do not hide a later correction in the same long message')

  const longText = `${'日常散步。'.repeat(16_000)}\n特别约定：秘密代号叫青色鲸鱼，周六再见。\n${'普通闲聊。'.repeat(16_000)}`
  const large = await ask('秘密代号“青色鲸鱼”约定是什么？', round('large', longText))
  assert.ok(large.includes('青色鲸鱼'))
  assert.ok(large.includes('[前文省略]'))
  assert.ok(large.includes('[后文省略]'))
  assert.ok(large.length < 4_000)
  assert.ok(estimateMemoryTokens(large) <= 3_000)
  const acrossChunk = `${'x'.repeat(32_766)}月光邮局是在桥边。${'y'.repeat(32_768)}`
  assert.ok((await ask('月光邮局在哪里？', round('boundary', acrossChunk))).includes('月光邮局是在桥边'))
  const mixedCase = `${'İ'.repeat(1_000)}月光邮局在桥边。${'x'.repeat(1_000)}`
  assert.ok((await ask('月光邮局在哪里？', round('unicode-offset', mixedCase))).includes('月光邮局在桥边'),
    'Case folding must map a hit back to its original UTF-16 source position')
  checks.push('Scans oversized single-message text in bounded overlapping chunks, finds middle and chunk-boundary evidence, and returns only marked excerpts within the token budget')

  const noHidden = [
    ...round('hidden', '你好', '普通回复'),
    user('hidden-u', '询问隐藏线索'),
    assistant('hidden-a', '普通正文', { blocks: [{ type: 'thinking', thinking: '秘密暗号黑洞列车' }, { type: 'text', text: '普通正文' }] }),
    user('refused-u', '秘密暗号黑洞列车'),
    assistant('refused-a', '拒绝内容', { stopReason: 'refusal' }),
    user('template-u', '秘密暗号黑洞列车'),
    assistant('template-a', '错误', { blocks: [{ type: 'text', text: '秘密暗号黑洞列车', isTemplate: true }] }),
  ]
  assert.equal(await ask('秘密暗号“黑洞列车”', noHidden), '')
  const inline = await ask('月光邮局图片是什么意思？', round('inline', `月光邮局图片：data:image/png;base64,${'A'.repeat(2_000)}。之后去公园。`))
  assert.ok(inline.includes('[省略内联数据]'))
  assert.ok(!inline.includes('base64'))
  assert.ok(!inline.includes('A'.repeat(256)))
  checks.push('Ignores hidden thinking, refused/template rounds, attachment bytes and long inline encoded payloads while retaining visible textual evidence')

  const aliasHistory = round('alias', '约定地点叫晴川大桥，代称是我们讨论过的那个地方。')
  const aliasRecord = { id: 'alias', sessionId: 'chat-a', key: '月光邮局旅行计划', text: '周五看海的集合地点', sources: [{ messageId: 'u-alias', start: 0, end: 13, fingerprint: 'validated-by-caller' }] }
  const alias = await ask('月光邮局旅行计划的集合地点？', aliasHistory, { records: [aliasRecord] })
  assert.ok(alias.includes('晴川大桥'))
  assert.ok(!alias.includes('validated-by-caller'))
  checks.push('Uses already-validated fact labels as bounded lexical hints, but injects the referenced original text rather than model-authored fact prose')

  const many = Array.from({ length: 40 }, (_, index) => round(`match-${index}`, `月光邮局第${index}个事件。${'条件与背景。'.repeat(80)}`)).flat()
  const bounded = await ask('月光邮局事件', many)
  assert.ok(estimateMemoryTokens(bounded) <= 3_000)
  assert.ok((bounded.match(/\[user ·/g) ?? []).length <= 6)
  assert.ok(bounded.includes('第39个事件'), 'Equal relevance must retain newer evidence rather than filling every slot with old mentions')
  const preAborted = new AbortController()
  preAborted.abort()
  await assert.rejects(() => ask('月光邮局', original, { signal: preAborted.signal }), { name: 'AbortError' })
  const controller = new AbortController()
  const cancellation = ask('月光邮局', round('abort', '普通内容。'.repeat(250_000)), { signal: controller.signal })
  setTimeout(() => controller.abort(), 0)
  await assert.rejects(() => cancellation, { name: 'AbortError' })
  checks.push('Caps evidence windows and aggregate estimated tokens, handles pre-cancellation and yields during a long scan so Stop interrupts before completion')

  console.log(JSON.stringify({ passed: true, runtime: process.version, checks, scope: 'Actual pure recall module with synthetic current-branch messages and source hints; no database, network, model calls or private history.' }, null, 2))
} finally {
  hooks.deregister()
}

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      specifier.endsWith('.js') &&
      context.parentURL?.startsWith(root.href)
    ) {
      const file = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(file))) return { url: file.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(root.href) && url.endsWith('.ts'))
      return {
        format: 'module',
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }),
        shortCircuit: true,
      }
    return nextLoad(url, context)
  },
})

try {
  const {
    MEMORY_VERSION,
    memoryText,
    memoryFingerprint,
    parseMemoryExtraction,
    filterMemoryRecords,
    isMemorySourceValid,
  } = await import(new URL('services/chat/memoryRecords.ts', root))
  const user = (id, content, createdAt = 1) => ({ id, role: 'user', content, createdAt, files: [] })
  const assistant = (id, content) => ({
    id,
    role: 'assistant',
    createdAt: 2,
    model: 'test',
    status: 'done',
    stopReason: 'end_turn',
    prefix: false,
    blocks: [
      { type: 'thinking', thinking: 'Do not remember hidden thinking' },
      { type: 'text', text: content },
    ],
  })
  const slice = async (message, start = 0, end = memoryText(message).length) => ({
    message,
    fingerprint: await memoryFingerprint(message),
    start,
    end,
  })
  const path = (slices) => new Map(slices.map((item) => [item.message.id, item]))
  const extraction = (records, summary = '用户提供颜色偏好。') =>
    JSON.stringify({ summary, records })
  const preference = (messageId, quote, overrides = {}) => ({
    kind: 'preference',
    actor: 'user',
    realm: 'self_report',
    key: 'favorite_color',
    text: quote,
    sources: [{ messageId, quote }],
    ...overrides,
  })
  const red = await slice(user('shared-red', '我的颜色偏好是红色。'))
  const blue = await slice(user('branch-a-blue', '更正一下，现在更喜欢蓝色。', 3))
  const green = await slice(user('branch-a-green', '再次更正，我现在喜欢绿色。', 4))
  const branchB = await slice(user('branch-b', '我们聊一点别的吧。', 3))
  const old = parseMemoryExtraction(extraction([preference('shared-red', '颜色偏好是红色')]), {
    sessionId: 'chat-a',
    segmentId: 'shared-segment',
    sources: [red],
    knownRecords: [],
    now: 10,
  })
  assert.equal(old.records[0].id, `chat-a:${MEMORY_VERSION}:shared-segment:0`)
  assert.equal(old.records[0].sources[0].start, 2)
  assert.equal(old.records[0].sources[0].end, 9)
  const correction = parseMemoryExtraction(
    extraction([
      preference('branch-a-blue', '现在更喜欢蓝色', {
        kind: 'correction',
        supersedes: [old.records[0].id],
      }),
    ]),
    {
      sessionId: 'chat-a',
      segmentId: 'blue-segment',
      sources: [blue],
      knownRecords: old.records,
      sourceOrder: new Map([
        ['shared-red', 0],
        ['branch-a-blue', 1],
      ]),
      now: 11,
    }
  )
  const all = [...old.records, ...correction.records]
  assert.deepEqual(
    filterMemoryRecords(all, 'chat-a', path([red, blue])).map((r) => r.text),
    ['现在更喜欢蓝色']
  )
  assert.deepEqual(
    filterMemoryRecords(all, 'chat-a', path([red, branchB])).map((r) => r.text),
    ['颜色偏好是红色']
  )
  assert.deepEqual(filterMemoryRecords(all, 'different-chat', path([red, blue])), [])
  assert.deepEqual(
    filterMemoryRecords(
      [{ ...old.records[0], extractorVersion: MEMORY_VERSION - 1 }],
      'chat-a',
      path([red, blue])
    ),
    [],
    'Older extraction rules must be rebuilt rather than reused'
  )
  assert.equal(all.length, 2)
  const edited = await slice(user('shared-red', '我的颜色偏好是紫色。'))
  assert.equal(filterMemoryRecords(old.records, 'chat-a', path([edited])).length, 0)
  const shortened = { ...red, message: user('shared-red', '红色'), fingerprint: red.fingerprint }
  assert.equal(isMemorySourceValid(old.records[0].sources[0], path([shortened])), false)

  const correctedAgain = parseMemoryExtraction(
    extraction([
      preference('branch-a-green', '现在喜欢绿色', {
        kind: 'correction',
        supersedes: [correction.records[0].id],
      }),
    ]),
    {
      sessionId: 'chat-a',
      segmentId: 'green-segment',
      sources: [green],
      knownRecords: all,
      sourceOrder: new Map([
        ['shared-red', 0],
        ['branch-a-blue', 1],
        ['branch-a-green', 2],
      ]),
    }
  )
  assert.deepEqual(
    filterMemoryRecords(
      [...all, ...correctedAgain.records],
      'chat-a',
      path([red, blue, green])
    ).map((r) => r.text),
    ['现在喜欢绿色']
  )

  for (const records of [
    [preference('shared-red', '用户从未说过这个')],
    [preference('nonexistent', '颜色偏好是红色')],
    [preference('shared-red', '颜色偏好是红色', { kind: 'invented' })],
    [preference('shared-red', '颜色偏好是红色', { supersedes: [old.records[0].id] })],
  ])
    assert.throws(() =>
      parseMemoryExtraction(extraction(records), {
        sessionId: 'chat-a',
        segmentId: 'invalid',
        sources: [red],
        knownRecords: all,
      })
    )
  assert.throws(() =>
    parseMemoryExtraction('{"summary":"truncated"', {
      sessionId: 'chat-a',
      segmentId: 'invalid',
      sources: [red],
      knownRecords: [],
    })
  )
  assert.throws(() =>
    parseMemoryExtraction(extraction(Array(25).fill(preference('shared-red', '红色'))), {
      sessionId: 'chat-a',
      segmentId: 'invalid',
      sources: [red],
      knownRecords: [],
    })
  )
  const ambiguous = await slice(user('repeated', '红色，以及红色。'))
  assert.throws(() =>
    parseMemoryExtraction(extraction([preference('repeated', '红色')]), {
      sessionId: 'chat-a',
      segmentId: 'invalid',
      sources: [ambiguous],
      knownRecords: [],
    })
  )
  const restricted = await slice(user('restricted', '不能引用范围之外的内容。'), 0, 2)
  assert.throws(() =>
    parseMemoryExtraction(extraction([preference('restricted', '范围之外')]), {
      sessionId: 'chat-a',
      segmentId: 'invalid',
      sources: [restricted],
      knownRecords: [],
    })
  )

  const assistantSource = await slice(assistant('assistant-claim', '你喜欢蓝色，我替你决定了。'))
  assert.equal(memoryText(assistantSource.message), '你喜欢蓝色，我替你决定了。')
  assert.throws(() =>
    parseMemoryExtraction(extraction([preference('assistant-claim', '你喜欢蓝色')]), {
      sessionId: 'chat-a',
      segmentId: 'invalid',
      sources: [assistantSource],
      knownRecords: [],
    })
  )
  assert.throws(() =>
    parseMemoryExtraction(
      extraction([preference('assistant-claim', '你喜欢蓝色', { actor: 'assistant' })]),
      {
        sessionId: 'chat-a',
        segmentId: 'invalid',
        sources: [assistantSource],
        knownRecords: [],
      }
    )
  )
  const promise = parseMemoryExtraction(
    extraction([
      preference('assistant-claim', '我替你决定了', {
        kind: 'promise',
        actor: 'assistant',
        realm: 'roleplay',
      }),
    ]),
    { sessionId: 'chat-a', segmentId: 'promise', sources: [assistantSource], knownRecords: [] }
  )
  assert.equal(promise.records[0].actor, 'assistant')
  assert.equal(promise.records[0].realm, 'roleplay')
  for (const [kind, originalText, correctedText, finalText] of [
    [
      'setting',
      '角色设定中我的名字是小蓝。',
      '更正角色设定，你以后叫小红。',
      '再次更正角色设定，你叫小绿。',
    ],
    [
      'promise',
      '在故事里我答应周五陪你看海。',
      '更正故事约定，改成周六陪我看海。',
      '再次更正故事约定，改成周日看海。',
    ],
  ]) {
    const originalSource = await slice(assistant(`assistant-${kind}`, originalText))
    const correctedSource = await slice(user(`user-${kind}-correction`, correctedText, 3))
    const finalSource = await slice(user(`user-${kind}-final`, finalText, 4))
    const original = parseMemoryExtraction(
      extraction([
        preference(originalSource.message.id, originalText, {
          kind,
          actor: 'assistant',
          realm: 'roleplay',
          key: kind,
        }),
      ]),
      { sessionId: 'chat-a', segmentId: kind, sources: [originalSource], knownRecords: [] }
    )
    const correctionRow = preference(correctedSource.message.id, correctedText, {
      kind: 'correction',
      realm: 'roleplay',
      key: kind,
      supersedes: [original.records[0].id],
    })
    const sourceOrder = new Map([
      [originalSource.message.id, 0],
      [correctedSource.message.id, 1],
      [finalSource.message.id, 2],
    ])
    const correctionOptions = {
      sessionId: 'chat-a',
      segmentId: `${kind}-correction`,
      sources: [correctedSource],
      knownRecords: original.records,
      sourceOrder,
    }
    const corrected = parseMemoryExtraction(extraction([correctionRow]), correctionOptions)
    const records = [...original.records, ...corrected.records]
    assert.deepEqual(
      filterMemoryRecords(records, 'chat-a', path([originalSource, correctedSource])).map(
        (record) => record.text
      ),
      [correctedText]
    )
    assert.deepEqual(
      filterMemoryRecords(records, 'chat-a', path([originalSource, branchB])).map(
        (record) => record.text
      ),
      [originalText]
    )
    const final = parseMemoryExtraction(
      extraction([
        preference(finalSource.message.id, finalText, {
          kind: 'correction',
          realm: 'roleplay',
          key: kind,
          supersedes: [corrected.records[0].id],
        }),
      ]),
      {
        sessionId: 'chat-a',
        segmentId: `${kind}-final`,
        sources: [finalSource],
        knownRecords: records,
        sourceOrder,
      }
    )
    assert.deepEqual(
      filterMemoryRecords(
        [...records, ...final.records],
        'chat-a',
        path([originalSource, correctedSource, finalSource])
      ).map((record) => record.text),
      [finalText]
    )
    // User corrections may replace assistant claims in the same realm, never turn a story into reality.
    assert.throws(() =>
      parseMemoryExtraction(
        extraction([{ ...correctionRow, realm: 'self_report' }]),
        correctionOptions
      )
    )
    assert.throws(() =>
      parseMemoryExtraction(
        extraction([{ ...correctionRow, actor: 'assistant' }]),
        correctionOptions
      )
    )
    assert.throws(() =>
      parseMemoryExtraction(extraction([correctionRow]), {
        ...correctionOptions,
        sources: [originalSource],
      })
    )
    assert.throws(() =>
      parseMemoryExtraction(extraction([correctionRow]), {
        ...correctionOptions,
        sourceOrder: new Map([[correctedSource.message.id, 0]]),
      })
    )
  }
  assert.equal(memoryText({ ...assistantSource.message, status: 'streaming' }), '')
  assert.equal(memoryText({ ...assistantSource.message, stopReason: 'refusal' }), '')
  assert.equal(
    memoryText({
      ...assistantSource.message,
      blocks: [{ type: 'text', text: '错误模板', isTemplate: true }],
    }),
    ''
  )

  // A quoted historical fact cannot supersede a newer fact or a different profile/realm.
  const invalidCorrection = extraction([
    preference('shared-red', '红色', {
      kind: 'correction',
      supersedes: [correction.records[0].id],
    }),
  ])
  assert.throws(() =>
    parseMemoryExtraction(invalidCorrection, {
      sessionId: 'chat-a',
      segmentId: 'backwards',
      sources: [red],
      knownRecords: all,
      sourceOrder: new Map([
        ['shared-red', 0],
        ['branch-a-blue', 1],
      ]),
    })
  )
  assert.throws(() =>
    parseMemoryExtraction(
      extraction([
        preference('branch-a-blue', '蓝色', {
          kind: 'correction',
          realm: 'roleplay',
          supersedes: [old.records[0].id],
        }),
      ]),
      {
        sessionId: 'chat-a',
        segmentId: 'realm',
        sources: [blue],
        knownRecords: all,
        sourceOrder: new Map([
          ['shared-red', 0],
          ['branch-a-blue', 1],
        ]),
      }
    )
  )

  const emojiSource = await slice(user('emoji', '记住我的暗号是🌊。'))
  const emoji = parseMemoryExtraction(extraction([preference('emoji', '暗号是🌊')]), {
    sessionId: 'chat-a',
    segmentId: 'emoji',
    sources: [emojiSource],
    knownRecords: [],
  })
  assert.equal(
    memoryText(emojiSource.message).slice(
      emoji.records[0].sources[0].start,
      emoji.records[0].sources[0].end
    ),
    '暗号是🌊'
  )
  assert.deepEqual(
    parseMemoryExtraction(
      extraction([preference('emoji', '暗号是🌊'), preference('emoji', '暗号是🌊')]),
      {
        sessionId: 'chat-a',
        segmentId: 'emoji',
        sources: [emojiSource],
        knownRecords: [],
      }
    ).records.length,
    1
  )

  const greeting = await slice(user('unrelated-user', '你好。'))
  assert.throws(
    () =>
      parseMemoryExtraction(
        extraction([
          preference('assistant-claim', '你喜欢蓝色', {
            sources: [
              { messageId: 'assistant-claim', quote: '你喜欢蓝色' },
              { messageId: 'unrelated-user', quote: '你好' },
            ],
          }),
        ]),
        {
          sessionId: 'chat-a',
          segmentId: 'mixed-actor',
          sources: [assistantSource, greeting],
          knownRecords: [],
        }
      ),
    'An unrelated user quote must not turn an assistant assertion into a user preference'
  )

  const longMessage = user(
    'long-user-message',
    '我喜欢红色。' + '普通日常。'.repeat(700) + '更正一下，我现在喜欢蓝色。'
  )
  const earlySlice = await slice(longMessage, 0, 6)
  const lateSlice = await slice(longMessage, 3000, longMessage.content.length)
  const sameMessageOld = parseMemoryExtraction(
    extraction([preference(longMessage.id, '我喜欢红色')]),
    {
      sessionId: 'chat-a',
      segmentId: 'early-slice',
      sources: [earlySlice],
      knownRecords: [],
    }
  )
  const sameMessageCorrection = parseMemoryExtraction(
    extraction([
      preference(longMessage.id, '我现在喜欢蓝色', {
        kind: 'correction',
        supersedes: [sameMessageOld.records[0].id],
      }),
    ]),
    {
      sessionId: 'chat-a',
      segmentId: 'late-slice',
      sources: [lateSlice],
      knownRecords: sameMessageOld.records,
      sourceOrder: new Map([[longMessage.id, 0]]),
    }
  )
  assert.deepEqual(
    filterMemoryRecords(
      [...sameMessageOld.records, ...sameMessageCorrection.records],
      'chat-a',
      path([await slice(longMessage)])
    ).map((record) => record.text),
    ['我现在喜欢蓝色']
  )

  const sameBatch = parseMemoryExtraction(
    extraction([
      preference('shared-red', '颜色偏好是红色'),
      preference('branch-a-blue', '现在更喜欢蓝色', { kind: 'correction', supersedes: ['@0'] }),
    ]),
    {
      sessionId: 'chat-a',
      segmentId: 'same-batch',
      sources: [red, blue],
      knownRecords: [],
    }
  )
  assert.deepEqual(sameBatch.records[1].supersedes, [sameBatch.records[0].id])
  assert.deepEqual(
    filterMemoryRecords(sameBatch.records, 'chat-a', path([red, blue])).map(
      (record) => record.text
    ),
    ['现在更喜欢蓝色']
  )

  for (const reference of ['@0', '@1', '@2', '@-1', '@01']) {
    assert.throws(
      () =>
        parseMemoryExtraction(
          extraction([
            preference('branch-a-blue', '现在更喜欢蓝色', {
              kind: 'correction',
              supersedes: [reference],
            }),
          ]),
          {
            sessionId: 'chat-a',
            segmentId: 'invalid-local-reference',
            sources: [red, blue],
            knownRecords: [],
          }
        ),
      `Self, future or malformed references must be rejected: ${reference}`
    )
  }
  const duplicateRows = parseMemoryExtraction(
    extraction([
      preference('shared-red', '颜色偏好是红色'),
      preference('shared-red', '颜色偏好是红色'),
      preference('branch-a-blue', '现在更喜欢蓝色', { kind: 'correction', supersedes: ['@1'] }),
    ]),
    {
      sessionId: 'chat-a',
      segmentId: 'duplicate-local-reference',
      sources: [red, blue],
      knownRecords: [],
    }
  )
  assert.equal(duplicateRows.records.length, 2)
  assert.deepEqual(duplicateRows.records[1].supersedes, [duplicateRows.records[0].id])
  assert.throws(() =>
    parseMemoryExtraction(
      extraction([
        preference('shared-red', '颜色偏好是红色'),
        preference('branch-a-blue', '现在更喜欢蓝色', {
          kind: 'correction',
          realm: 'roleplay',
          supersedes: ['@0'],
        }),
      ]),
      {
        sessionId: 'chat-a',
        segmentId: 'local-realm-change',
        sources: [red, blue],
        knownRecords: [],
      }
    )
  )

  assert.deepEqual(
    filterMemoryRecords(
      [...all, ...correctedAgain.records],
      'chat-a',
      path([red, branchB, green])
    ).map((record) => record.text),
    ['颜色偏好是红色'],
    'A correction whose intermediate dependency is absent must not revive a partial correction chain'
  )
  const changedBlue = await slice(user('branch-a-blue', '这句蓝色是另一个意思。', 3))
  assert.deepEqual(
    filterMemoryRecords(
      [...all, ...correctedAgain.records],
      'chat-a',
      path([red, changedBlue, green])
    ).map((record) => record.text),
    ['颜色偏好是红色']
  )
  const mixedPersisted = {
    ...old.records[0],
    sources: [
      {
        messageId: assistantSource.message.id,
        fingerprint: assistantSource.fingerprint,
        start: 0,
        end: 5,
      },
      { messageId: greeting.message.id, fingerprint: greeting.fingerprint, start: 0, end: 2 },
    ],
  }
  assert.deepEqual(
    filterMemoryRecords([mixedPersisted], 'chat-a', path([assistantSource, greeting])),
    [],
    'Previously stored mixed-speaker user preferences must be excluded as well'
  )
  const emojiAt = memoryText(emojiSource.message).indexOf('🌊')
  assert.equal(
    isMemorySourceValid(
      { ...emoji.records[0].sources[0], start: emojiAt, end: emojiAt + 1 },
      path([emojiSource])
    ),
    false
  )
  assert.throws(() =>
    parseMemoryExtraction(extraction([preference('emoji', '\ud83c')]), {
      sessionId: 'chat-a',
      segmentId: 'half-surrogate',
      sources: [emojiSource],
      knownRecords: [],
    })
  )

  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          'Branch-local corrections retain the shared ancestor preference on the untouched branch; changed sources and another session never contribute memories',
          'Exact unique source quotes determine UTF-16 offsets, preserve emoji and reject invented, repeated or out-of-slice evidence',
          'Model JSON is bounded and validated; assistant assertions cannot become user preferences, transient/hidden/refused/template text cannot support memories',
          'Corrections require an earlier known record in the same session and realm; chained corrections remain path-local and records are immutable',
          'A user can correct earlier assistant roleplay settings and promises; cross-speaker correction chains keep their branch and realm boundaries',
          'User preferences require only user evidence; a later slice of one huge message and later rows of one extraction can correct earlier records without self or forward references',
          'Edited or missing dependencies invalidate dependent corrections; exact evidence offsets cannot split an emoji surrogate pair',
        ],
        scope:
          'Actual pure TypeScript memory modules with synthetic dialogue; no real keys, model calls, user history or browser data.',
      },
      null,
      2
    )
  )
} finally {
  hooks.deregister()
}

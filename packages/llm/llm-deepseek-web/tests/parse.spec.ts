import { describe, expect, it } from 'vitest'
import { parseToolCall, splitReply } from '../src/parse.ts'

const TOOLS = new Set(['bash', 'read', 'ls', 'glob', 'a', 'b', 'x'])

/**
 * 调用的名字序列。断言行为而不是 `raw` 的字节形式:`raw` 是内部载体,解析成功时
 * 携带规范化后的 JSON(含修复结果),失败时保留原文交给适配器退回可见文本。
 */
const callNames = (text: string, tools = TOOLS): string[] =>
  splitReply(text, tools).filter(e => e.kind === 'tool-call').map(e => parseToolCall(e.raw)?.name ?? '?')

describe('splitReply', () => {
  it('passes plain text through unchanged', () => {
    expect(splitReply('你好，世界', TOOLS)).toEqual([{ kind: 'text', text: '你好，世界' }])
  })

  it('splits a marked call out of its surrounding text', () => {
    const events = splitReply('前文<tool_call>{"name":"ls"}</tool_call>后文', TOOLS)
    expect(events.map(e => e.kind)).toEqual(['text', 'tool-call', 'text'])
    expect(events[0]).toEqual({ kind: 'text', text: '前文' })
    expect(events[2]).toEqual({ kind: 'text', text: '后文' })
    const call = events[1]
    expect(call?.kind === 'tool-call' ? parseToolCall(call.raw)?.name : undefined).toBe('ls')
  })

  it('accepts an open tag carrying attributes', () => {
    // 模型常写成 <tool_call name="read">;严格匹配裸标签会让整段调用退化成正文。
    expect(callNames('<tool_call name="read">{"name":"read"}</tool_call>')).toEqual(['read'])
  })

  it('emits several calls in one reply', () => {
    expect(callNames('<tool_call>{"name":"a"}</tool_call><tool_call>{"name":"b"}</tool_call>')).toEqual(['a', 'b'])
  })

  it('recovers a call the model emitted without any marker', () => {
    expect(splitReply('先看看。\n{"name":"bash","arguments":{"command":"ls"}}', TOOLS)).toEqual([
      { kind: 'text', text: '先看看。\n' },
      { kind: 'tool-call', raw: '{"name":"bash","arguments":{"command":"ls"}}' },
    ])
  })

  it('leaves JSON that names no offered tool as text', () => {
    const reply = '配置长这样：{"name":"deepseek","arguments":{}}'
    expect(splitReply(reply, TOOLS)).toEqual([{ kind: 'text', text: reply }])
  })

  it('does not unbalance on braces inside argument strings', () => {
    const raw = '{"name":"bash","arguments":{"command":"echo \'{\'"}}'
    expect(splitReply(raw, TOOLS)).toEqual([{ kind: 'tool-call', raw }])
  })

  it('treats a truncated call as a call rather than dropping the tail', () => {
    // 回复被截断时开标签后的内容仍是调用体,而且现在会被修复后认出来。
    expect(callNames('<tool_call>{"name":"ls"')).toEqual(['ls'])
  })

  it('keeps a lone angle bracket as text', () => {
    expect(splitReply('1 < 2', TOOLS)).toEqual([{ kind: 'text', text: '1 < 2' }])
  })

  it('parses a marked call whose body is a rendered code block', () => {
    // 实测形态:模型写了开标签,代码块渲染后反引号没了,闭标签也没出现。
    const reply = '我先看看。\n<tool_call>\n\njson\n复制\n下载\n{"name": "glob", "arguments": {"pattern": "*.ts"}}'
    expect(splitReply(reply, TOOLS).map(e => e.kind)).toEqual(['text', 'tool-call'])
    expect(splitReply(reply, TOOLS)[0]).toEqual({ kind: 'text', text: '我先看看。\n' })
    expect(callNames(reply)).toEqual(['glob'])
  })

  it('recovers the narrated form the web model actually emits', () => {
    // 站点自己的系统提示词压过输入框里的协议,模型改用这种写法宣告调用。
    const reply = '先看看结构。\n[调用 read] {"file_path": "/a/b.ts"}'
    expect(splitReply(reply, TOOLS)).toEqual([
      { kind: 'text', text: '先看看结构。\n' },
      { kind: 'tool-call', raw: '{"name":"read","arguments":{"file_path":"/a/b.ts"}}' },
    ])
  })

  it('recovers several narrated calls in one reply', () => {
    const reply = [
      '我来分析。',
      '[调用 read] {"file_path": "package.json"}',
      '[调用 bash] {"command": "ls"}',
    ].join('\n')
    expect(splitReply(reply, TOOLS).filter(event => event.kind === 'tool-call')).toHaveLength(2)
  })

  it('leaves a narrated name that is not an offered tool as text', () => {
    const reply = '[调用 deploy] {"target": "prod"}'
    expect(splitReply(reply, TOOLS)).toEqual([{ kind: 'text', text: reply }])
  })

  it('recovers every call from the reply that stalled the loop', () => {
    // 回归:这份回复曾一个调用都没解析出来,agent-loop 因此把该回合判成完成。
    const reply = [
      '先看看源码结构和实现细节。',
      '{"name": "bash", "arguments": {"command": "find src -name \'*.ts\'"}}',
      '<tool_call name="read">',
      '{"file_path": "README.md"}',
      '</tool_call>',
    ].join('\n')
    expect(splitReply(reply, TOOLS).filter(event => event.kind === 'tool-call')).toHaveLength(2)
  })
})

describe('parseToolCall', () => {
  it('extracts name and re-serializes arguments', () => {
    expect(parseToolCall('{"name":"read","arguments":{"path":"a.ts"}}')).toEqual({
      name: 'read',
      arguments: '{"path":"a.ts"}',
    })
  })

  it('defaults missing arguments to an empty object', () => {
    expect(parseToolCall('{"name":"list"}')).toEqual({ name: 'list', arguments: '{}' })
  })

  it('tolerates a fenced code block around the payload', () => {
    expect(parseToolCall('```json\n{"name":"read","arguments":{}}\n```')).toEqual({
      name: 'read',
      arguments: '{}',
    })
  })

  it('skips the debris a rendered code block leaves around the payload', () => {
    // 代码块渲染后反引号消失,留下语言标签和「复制/下载」按钮文字。
    expect(parseToolCall('json\n复制\n下载\n{"name":"glob","arguments":{"pattern":"*.ts"}}')).toEqual({
      name: 'glob',
      arguments: '{"pattern":"*.ts"}',
    })
  })

  it('rejects unusable payloads', () => {
    expect(parseToolCall('not json')).toBeNull()
    expect(parseToolCall('{"arguments":{}}')).toBeNull()
    expect(parseToolCall('"just a string"')).toBeNull()
  })
})

describe('fenced payloads', () => {
  const known = new Set(['edit', 'read'])
  const callOf = (raw: string): { name: string; arguments: Record<string, unknown> } =>
    JSON.parse(raw) as { name: string; arguments: Record<string, unknown> }
  // 真实故障的最小复现:模型在长 arguments 之后漏掉最外层的 `}`,而值里本身
  // 带花括号与转义引号(它在传 JS 代码)。修复前全局括号计数会越过这个块继续
  // 数下一个块,depth 永不归零,两个调用一起退化成可见文本 —— agent-loop 看到
  // 0 个 tool-call block 就把回合判成完成,任务静默停在半路。
  const missingBrace = [
    '先说明一下改动。',
    '',
    '```json',
    '{"name":"edit","arguments":{"file_path":"/a.js","old_string":"function f() {\\n  return \\"x\\";\\n}","new_string":"function f() {\\n  return \\"y\\";\\n}"}',
    '```',
    '',
    '接着第二处。',
    '',
    '```json',
    '{"name":"read","arguments":{"file_path":"/b.js"}}',
    '```',
  ].join('\n')

  it('repairs a payload missing its final brace', () => {
    const calls = splitReply(missingBrace, known).filter(e => e.kind === 'tool-call')
    expect(calls).toHaveLength(2)
    expect(callOf(calls[0]!.raw)).toMatchObject({
      name: 'edit',
      arguments: { file_path: '/a.js', old_string: 'function f() {\n  return "x";\n}' },
    })
  })

  it('keeps a later block usable when an earlier one is broken', () => {
    // 承重点:块之间必须互不影响。
    const calls = splitReply(missingBrace, known).filter(e => e.kind === 'tool-call')
    expect(callOf(calls[1]!.raw)).toMatchObject({ name: 'read', arguments: { file_path: '/b.js' } })
  })

  it('leaves an ordinary json code block as text', () => {
    const prose = '返回值形如：\n\n```json\n{"total": 3, "items": []}\n```'
    expect(splitReply(prose, known).every(e => e.kind === 'text')).toBe(true)
  })

  it('rejects a repaired payload naming an unknown tool', () => {
    const unknown = '```json\n{"name":"apply_patch","arguments":{"path":"/a"}\n```'
    expect(splitReply(unknown, known).every(e => e.kind === 'text')).toBe(true)
  })

  it('recovers a truncated payload rather than dropping the turn', () => {
    // 截断的字符串也救:参数会不完整,于是工具执行时报错、模型据此重试 ——
    // 比静默把回合判成完成好。这一条是换用 jsonrepair 之后才成立的。
    const truncated = '```json\n{"name":"edit","arguments":{"file_path":"/a.js","old_string":"未闭合'
    const calls = splitReply(truncated, known).filter(e => e.kind === 'tool-call')
    expect(calls).toHaveLength(1)
    expect(callOf(calls[0]!.raw).name).toBe('edit')
  })

  it('recovers the single-quote and trailing-comma spelling', () => {
    const sloppy = "```json\n{'name':'read','arguments':{'file_path':'/b.js',},}\n```"
    const calls = splitReply(sloppy, known).filter(e => e.kind === 'tool-call')
    expect(calls).toHaveLength(1)
    expect(callOf(calls[0]!.raw)).toMatchObject({ name: 'read', arguments: { file_path: '/b.js' } })
  })

  it('still refuses prose that merely mentions a call', () => {
    // jsonrepair 对无从修复的输入抛错,闸门仍然只认「可解析 + 有 name + 已知工具」。
    expect(splitReply('比如 {name: "edit"} 这种写法', known).every(e => e.kind === 'text')).toBe(true)
  })
})

describe('unclosed marker boundary', () => {
  const known = new Set(['bash', 'edit', 'todo_write'])
  // 真实故障:模型一轮里发了 5 个调用,第一个带 `<tool_call>` 却漏了 `</tool_call>`。
  // 旧行为把「剩下全是调用体」,于是后面 4 个调用连同它们的围栏一起被吞进第一个
  // 调用的躯体 —— 只执行了第一个,任务随即停在半路。缺闭合标记不等于回复被截断。
  const unclosed = [
    '继续修改。',
    '',
    '<tool_call>',
    '```json',
    '{"name":"bash","arguments":{"command":"pnpm run compile"}}',
    '```',
    '',
    '```json',
    '{"name":"edit","arguments":{"file_path":"/a.js","old_string":"x","new_string":"y"}}',
    '```',
    '',
    '```json',
    '{"name":"todo_write","arguments":{"todos":[]}}',
    '```',
  ].join('\n')

  it('keeps every later call when the closing tag is missing', () => {
    expect(callNames(unclosed, known)).toEqual(['bash', 'edit', 'todo_write'])
  })

  it('still treats a genuinely truncated body as one call', () => {
    // 连围栏结束都没有才是真截断,那时「剩下全是调用体」仍然正确。
    expect(callNames('<tool_call>\n```json\n{"name":"edit","arguments":{"file_path":"/a.js"', known)).toEqual(['edit'])
  })
})

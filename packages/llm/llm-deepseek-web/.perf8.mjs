// 调试脚本：多轮时延测量。需要先 pnpm run build（lib/ 是构建产物），
// 并有一个开着 9222 调试端口、已登录 chat.deepseek.com 的浏览器。
// 包目录内无法按包名解析自身，故直接引用构建产物。
import { DsWebAdapter, WebSession } from './lib/index.js'
const session = new WebSession({ endpoint: 'http://127.0.0.1:9222', idleTimeoutMs: 120000 })
const adapter = new DsWebAdapter({ session, useAttachment: () => false })
const msg = (id, role, text) => ({ id, role, content: [{ type: 'text', text }], source: { kind: 'user' } })
const sid = 'perf8-' + Date.now()
async function turn(label, messages) {
  const t0 = Date.now(); let firstAt = 0, out = ''
  for await (const c of adapter.stream({ provider: 'deepseek-web', model: 'deepseek-web', sessionId: sid, system: '你是助手，回答尽量简短。', messages })) {
    if (c.type === 'text-delta') { if (!firstAt) firstAt = Date.now(); out += c.text }
  }
  console.log(`[${label}] 首字 ${((firstAt-t0)/1000).toFixed(1)}s | 总计 ${((Date.now()-t0)/1000).toFixed(1)}s | ${JSON.stringify(out.slice(0,30))}`)
  return out
}
const a1 = await turn('第1轮', [msg('m1','user','记住数字 88。只回复"记住了"')])
await turn('第2轮', [msg('m1','user','记住数字 88。只回复"记住了"'), msg('a1','assistant',a1), msg('m2','user','刚才的数字？只回数字')])

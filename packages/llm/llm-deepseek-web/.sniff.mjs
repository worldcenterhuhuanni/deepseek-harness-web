// 调试脚本：探查页面结构。需要先 pnpm run build（lib/ 是构建产物），
// 并有一个开着 9222 调试端口、已登录 chat.deepseek.com 的浏览器。
// 包目录内无法按包名解析自身，故直接引用构建产物。
import { CdpConnection, listTargets, PAGE_AGENT } from './lib/index.js'
const endpoint = 'http://127.0.0.1:9222'
const tg = (await listTargets(endpoint)).find(x => x.type === 'page' && x.url.startsWith('https://chat.deepseek.com'))
const cdp = await CdpConnection.open(tg.webSocketDebuggerUrl)

// 在页面里挂一个 fetch/XHR 探针,记录所有出站请求的 url/method/头部键名
await cdp.evaluate(`(() => {
  if (window.__sniff) return true;
  window.__sniff = [];
  const of = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const hdrs = {};
      const h = (init && init.headers) || (input && input.headers);
      if (h) { if (h.forEach) h.forEach((v,k)=>{hdrs[k]=k.toLowerCase().includes('auth')||k.toLowerCase().includes('cookie')?'<redacted>':v}); else Object.keys(h).forEach(k=>{hdrs[k]=String(h[k]).slice(0,40)}); }
      let body = (init && init.body) || null;
      if (typeof body === 'string' && body.length > 600) body = body.slice(0, 600) + '…';
      window.__sniff.push({ url, method, hdrs, body });
    } catch (e) {}
    return of.apply(this, arguments);
  };
  return true;
})()`)
console.log('探针已挂载，发送一条消息…')

await cdp.evaluate(PAGE_AGENT)
await cdp.evaluate('window.__dshWeb.focusInput()')
await cdp.send('Input.insertText', { text: '只回复：ok' })
await cdp.evaluate('window.__dshWeb.waitSendable(5000)')
for (const type of ['keyDown','keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 })
await new Promise(r => setTimeout(r, 6000))

const sniff = await cdp.evaluate('window.__sniff')
for (const s of sniff.filter(x => /chat|completion|message|session/i.test(x.url))) {
  console.log('---')
  console.log('URL   :', s.url)
  console.log('METHOD:', s.method)
  console.log('HDRS  :', JSON.stringify(s.hdrs))
  console.log('BODY  :', s.body)
}
console.log('=== 其他请求 URL ===')
console.log(sniff.map(s => s.method + ' ' + s.url).slice(0, 20).join('\n'))
cdp.close()

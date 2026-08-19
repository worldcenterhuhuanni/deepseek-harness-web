/**
 * The script injected into chat.deepseek.com.
 *
 * Every selector here comes from a content script that has been driving this
 * page in production, not from guesswork — the site ships obfuscated class
 * names, so the fallback chains matter more than any single selector.
 *
 * Evaluated before each operation and idempotent, because a navigation wipes
 * whatever the previous evaluation defined.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/page-agent
 */

/** Snapshot of the page as the driver sees it between polls. */
export interface PageSnapshot {
  loggedIn: boolean
  hasInput: boolean
  /** Composer text matched an upload/parse failure hint. */
  failed: string
  /**
   * A failure hint found OUTSIDE the composer, when none was found inside it.
   *
   * Never a failure verdict: the transcript is page text too, so a task that
   * merely discusses 「解析失败」 would match forever. Reported only when the
   * attach wait times out, where it is the sole clue that the site put a real
   * notice somewhere this scope does not reach.
   */
  failedElsewhere: string
  /** An attachment is still uploading or parsing. */
  busy: boolean
}

/**
 * Installs `window.__dshWeb`. Safe to evaluate repeatedly.
 */
export const PAGE_AGENT = String.raw`
(() => {
  const INPUT_SELECTORS = [
    'textarea[placeholder*="Message DeepSeek"]',
    'textarea[placeholder*="给 DeepSeek"]',
    'textarea[placeholder*="DeepSeek"]',
    'textarea[placeholder*="发送"]',
    'textarea[name="search"]',
    '#chat-input',
    'textarea',
  ];
  const SEND_SELECTORS = [
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'button[type="submit"]',
    'div[role="button"][aria-label*="发送"]',
    'div[role="button"][aria-label*="Send"]',
  ];
  // 回复内容不从 DOM 读:那需要盯站点的混淆 class,而且拿到的是渲染结果。
  // 这里只留输入、发送、登录/忙碌状态所需的选择器 —— 都是语义化属性。
  const LOGIN_HINT = /登录|sign in|log in|驗證|验证码/i;
  const FAIL_HINT = /解析失败|未能发送|发送失败|upload failed|parse failed/i;
  const BUSY_HINT = /解析中|上传中|处理中|Uploading|Parsing|Loading/i;

  function findInput() {
    for (const s of INPUT_SELECTORS) {
      const el = document.querySelector(s);
      if (el instanceof HTMLTextAreaElement) return el;
    }
    return null;
  }

  /** 输入框往上数几层,把搜索范围收在输入区内,避免误点侧边栏的控件。 */
  function composerBox() {
    const input = findInput();
    if (!input) return null;
    let box = input;
    for (let i = 0; i < 6 && box.parentElement; i++) box = box.parentElement;
    return box;
  }

  function findSendButton() {
    // 站点已无 <button>,发送键是输入区里那个没有 aria-label 的 primary 图标按钮。
    // ds-button--primary 是语义 class,比条目上那些混淆 class 稳。
    const box = composerBox();
    if (box) {
      const primary = Array.from(box.querySelectorAll('[role="button"]'))
        .filter((el) => /ds-button--primary/.test(String(el.className || '')))
        .filter((el) => el.getBoundingClientRect().width > 0);
      if (primary.length) return primary[primary.length - 1];
    }
    for (const s of SEND_SELECTORS) {
      const el = document.querySelector(s);
      if (el instanceof HTMLElement && !el.disabled) return el;
    }
    const root = box || document.body;
    const buttons = Array.from(root.querySelectorAll('button, div[role="button"]'));
    const byLabel = buttons.find((b) => {
      const t = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
      return /发送|Send|提交/i.test(t) && !b.disabled;
    });
    return byLabel || null;
  }

  function isLoggedIn() {
    if (findInput()) return true;
    const body = (document.body && document.body.innerText ? document.body.innerText.slice(0, 2000) : '');
    if (LOGIN_HINT.test(body)) return false;
    if (document.querySelector('input[type="password"], .ds-sign-in-form__main, .ds-auth-form-wrapper')) return false;
    return Boolean(findInput());
  }

  function fileInputSelector() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const hit = inputs.find((i) => !i.disabled && (i.accept === '' || /pdf|text|md|\*/i.test(i.accept))) || inputs[0];
    if (!hit) return '';
    if (!hit.dataset.dshWeb) hit.dataset.dshWeb = '1';
    return 'input[type="file"][data-dsh-web="1"]';
  }

  function clickAttachButton() {
    const labeled = document.querySelector('button[aria-label*="Upload"], button[aria-label*="上传"], button[aria-label*="Attach"], button[aria-label*="附件"], button[aria-label*="file" i]');
    if (labeled instanceof HTMLElement) { labeled.click(); return true; }
    const hit = Array.from(document.querySelectorAll('button')).find((b) =>
      /上传|附件|Attach|Upload|文件/i.test(b.getAttribute('aria-label') || b.textContent || ''));
    if (hit instanceof HTMLElement) { hit.click(); return true; }
    return false;
  }

  /**
   * 在页面内等待条件成立。等待留在页面里,CDP 只发一次调用:
   * 既没有每次检查的往返开销,条件一成立也立刻返回,不用等下一个轮询周期。
   * 超时返回 false 而不是抛错,由调用方决定怎么退让。
   */
  function waitUntil(check, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        let ok = false;
        try { ok = Boolean(check()); } catch (e) { ok = false; }
        if (ok) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  window.__dshWeb = {
    /** 等输入框出现(页面加载完成的实际判据)。 */
    waitInput(timeoutMs) {
      return waitUntil(() => findInput(), timeoutMs);
    },

    /**
     * 等发送键从禁用变为可用:composer 的 React 状态跟上输入之后才会亮。
     *
     * 判据只能看 class。发送键是 div[role=button],el.disabled 恒为 undefined、
     * aria-disabled 恒为 null —— 拿这两个当判据等于没有判据,会立刻放行,
     * 回车打在还禁用的按钮上,消息发不出去。
     * (注意:本文件是 String.raw 模板,注释里不能出现反引号。)
     */
    waitSendable(timeoutMs) {
      return waitUntil(() => {
        const btn = findSendButton();
        if (!btn) return false;
        if (btn.disabled) return false;
        if (btn.getAttribute('aria-disabled') === 'true') return false;
        return !/ds-button--disabled/.test(String(btn.className || ''));
      }, timeoutMs);
    },

    /** 等输入框清空,这是消息确实发出去的标志。 */
    waitSubmitted(timeoutMs) {
      return waitUntil(() => {
        const el = findInput();
        return el && !el.value.trim();
      }, timeoutMs);
    },

    snapshot() {
      // 状态只在输入区里找。FAIL_HINT/BUSY_HINT 命中的是站点贴在附件卡片与输入区
      // 的提示,而 document.body.innerText 含整段对话历史 —— 一旦对话本身谈到
      // 「解析失败」「处理中」这类词,内容就会被读成状态,而且历史不会消失,于是
      // 从那一轮起每轮都失败:附件判失败(报错文本其实来自对话),或永久 busy 等到超时。
      const box = composerBox();
      const text = (box && box.innerText) || '';
      const failMatch = text.match(FAIL_HINT);
      const whole = (document.body && document.body.innerText) || '';
      const outside = failMatch ? null : whole.match(FAIL_HINT);
      return {
        loggedIn: isLoggedIn(),
        hasInput: Boolean(findInput()),
        failed: failMatch ? failMatch[0] : '',
        failedElsewhere: outside ? outside[0] : '',
        busy: BUSY_HINT.test(text),
      };
    },

    /**
     * 对齐「深度思考 / 智能搜索」开关。
     * 智能搜索默认是开的,每轮都会先联网搜一遍,首字延迟能到 30 秒以上;
     * dsh 自己带工具,这一层搜索是纯粹的浪费。用 aria-pressed 读状态,
     * 它是标准属性,比混淆 class 稳。
     */
    setModes(want) {
      const out = {};
      for (const el of document.querySelectorAll('.ds-toggle-button, [aria-pressed]')) {
        const label = (el.innerText || '').trim();
        let target = null;
        if (/深度思考|深度|Think|R1/i.test(label)) target = want.thinking;
        else if (/智能搜索|联网|Search/i.test(label)) target = want.search;
        if (target === null || target === undefined) continue;
        const on = el.getAttribute('aria-pressed') === 'true';
        if (on !== target) el.click();
        out[label] = target;
      }
      return out;
    },

    /** 聚焦输入框,后续文本与回车由 CDP 以真实输入事件送入。 */
    focusInput() {
      const el = findInput();
      if (!el) return false;
      el.focus();
      return true;
    },

    /**
     * 发送键的视口中心坐标,供 CDP 派发真实鼠标事件。
     * 站点用 React 合成事件,元素上的 el.click() 是 untrusted 的,
     * 真实按下/释放更接近用户操作,也不依赖焦点还在输入框上。
     */
    sendButtonPoint() {
      const btn = findSendButton();
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },

    /** 兜底提交:真实点击也不成时,退回元素自身的 click()。 */
    clickSend() {
      const btn = findSendButton();
      if (!btn) return false;
      btn.click();
      return true;
    },

    inputValue() {
      const el = findInput();
      return el ? el.value : '';
    },

    prepareFileInput() {
      let selector = fileInputSelector();
      if (!selector) { clickAttachButton(); selector = fileInputSelector(); }
      return selector;
    },

    notifyFileAttached() {
      const el = document.querySelector('input[type="file"][data-dsh-web="1"]');
      if (!el) return false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
  };
  return true;
})()
`

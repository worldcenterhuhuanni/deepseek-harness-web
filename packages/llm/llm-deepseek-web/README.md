# dsh-llm-deepseek-web

把**已登录的 chat.deepseek.com 网页会话**接进 dsh 的 LLM seam，不需要 API Key，也不需要装任何浏览器扩展。

插件通过 Chrome DevTools Protocol 驱动一个真实 Chrome（自己拉起，带独立 profile，不影响你日常那个）：登录态、Cookie、浏览器指纹都是真实的，没有 Playwright 那类自动化特征。网页只吐纯文本，插件把它翻成 dsh 的 `StreamChunk` 语法——包括工具调用，dsh 无法与原生 tool call 区分。

## 启用

**不需要动你正在用的 Chrome。** 插件会自己拉起一个带独立 profile 的浏览器实例，两者并存。

1. 把插件挂进 dsh profile 的**用户层**，不改仓库内任何 upstream 文件：

   ```sh
   node packages/llm/llm-deepseek-web/launcher/install-profile.mjs
   ```

   脚本幂等地写 `$DSH_HOME/profiles/web/` 两处：`package.json` 的依赖（`link:` 指向本包，交给 pnpm 管理 profile 的 `node_modules`）和 `cordis.patch.yml` 的一条 insert。用户 patch 层在所有 bundle 层之后应用（见 `packages/boot/app-boot/src/profile.ts`），所以不必修改 `packages/bundle/base/`，上游更新不会冲突。末尾可跟 profile 名，默认 `web`；`dsh web --dump-config` 能确认它出现在组合结果里。

2. 启动 dsh，在**设置 → 模型**里能看到「DeepSeek 网页（已登录）」。它没有 API 密钥字段——凭据就是你的浏览器会话。

3. 把它设为默认模型（`$DSH_HOME/settings.yaml`）：

   ```yaml
   agent-default-model:
     provider: deepseek-web
     model: deepseek-web
   ```

4. 首次发消息时插件会拉起浏览器窗口并停在 chat.deepseek.com。**在那个窗口里登录一次**，之后 profile 长期复用，不必再登。

### 为什么不复用你已经开着的 Chrome

调试端口是**启动参数**，运行中的进程无法事后开启——否则任何本地程序都能静默劫持你正在用的浏览器。而且已有实例在跑时，`--remote-debugging-port` 只会被转交给它、新进程随即退出，端口并不会打开。

所以插件用独立 `--user-data-dir` 另起一个实例，跟你的日常浏览器完全并存。想改用自己启动的浏览器，把 `autoLaunch` 关掉，再自行带调试端口启动即可。

## 组成

| 文件 | 职责 |
|------|------|
| `src/cdp.ts` | 最小 CDP 客户端：target 发现、命令收发、文件输入挂载 |
| `src/page-agent.ts` | 注入页面的脚本，选择器沿用生产环境验证过的那套 |
| `src/session.ts` | 驱动一轮问答：导航、填写、发送、轮询回复 |
| `src/render.ts` | 把 `GenerateOptions` 渲染成一份 Markdown |
| `src/parse.ts` | 把网页文本流切成可见文本与工具调用 |
| `src/adapter.ts` | `LlmAdapter` 实现 |

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `endpoint` | `http://127.0.0.1:9222` | Chrome 调试端口地址 |
| `autoLaunch` | `true` | 端口无响应时自动拉起独立实例 |
| `userDataDir` | `$DSH_HOME/deepseek-web-profile` | 自动启动使用的 profile 目录 |
| `chromePath` | 自动探测 | Chrome 可执行文件；也可用 `CHROME_PATH` 环境变量 |
| `inlineLimit` | `4000` | 超过该字符数改用 `.md` 附件发送 |
| `useAttachment` | `true` | 关掉则一律走输入框；网页端拒收 `.md` 时用它兜底 |
| `idleTimeoutMs` | `180000` | 页面多久没动静判定失败 |
| `hardTimeoutMs` | `600000` | 单轮绝对上限 |
| `deepThinking` | `false` | 网页端「深度思考」，开启会显著拉长首字延迟 |
| `webSearch` | `false` | 网页端「智能搜索」。**站点默认是开的**，开启时首字延迟实测 32.7s，关掉后 2.9s |

除 `endpoint` 外都是每次请求现读，改了下一次调用即生效。

## 设计要点

**一个 dsh 会话对应一个网页对话，续轮只发增量。** 网页会话自己记着前面的轮次，所以续问只发新增的 user 消息与工具结果；assistant 消息跳过（页面自己产出的，回灌等于重复）。

能否续用由 **message id 前缀校验**决定：同一个 dsh session、system 与工具集未变、且已发送的 id 仍是新历史的严格前缀，才继续；compaction 改写过历史就自动新开对话。这样既不必每轮重发全量，也不会让网页记忆与 dsh 的认知悄悄分叉。

**开场先关掉站点的搜索/思考开关。** 新对话会把它们恢复成站点默认，而「智能搜索」默认是开的——实测让首字延迟从 2.9s 涨到 32.7s。

**用 `Emulation.setFocusEmulationEnabled` 而不是 `Page.bringToFront`。** 这个 profile 里可能不止一个标签，非激活标签的 `document.hidden` 为 true，站点会据此降级（停动画、推迟渲染）。焦点模拟让页面自认为可见且获得焦点，但不抬窗口、不抢键盘焦点——`bringToFront` 能翻可见性，代价是每轮问答都跳一次浏览器。`setWebLifecycleState('active')` 管的是冻结/丢弃生命周期，翻不动 visibility。

**发送用元素的 `click()`，不是键鼠事件。** 实测三种提交方式只有它稳定生效。键鼠事件依赖窗口/焦点状态，而这个插件的正常形态就是在后台跑；DOM 调用不受影响。键鼠留作兜底。

**回复只读正文节点 `.ds-markdown`，不读整条气泡。** 气泡里还有站点自己的状态文字（读附件时的「正在阅读」）和底部那排操作按钮，整条 `innerText` 读会把它们当成模型输出——上游看到的回答会以「正在阅读」开头。没有正文节点就返回空，那正是「站点还在忙、回答尚未开始」。

**请求必须排队。** dsh 生成会话标题时会额外发一个 LLM 请求，它与主请求重叠。两个 `ask()` 各自 `Input.insertText` 到同一个输入框，站点收到的是两段提示词拼在一起，然后按最后读到的那条指令作答——用户拿到的「回答」就是生成出来的标题。所以每个 dsh 会话在网页侧会有 2 个对话（1 个主 + 1 个标题），第 2 轮因记录被标题请求覆盖会全量重发一次，之后恢复增量。

**「是新回复」只看一条：正文与发送前不同。** 不能拿气泡数增长当判据——提问气泡比回复气泡先出现，那一刻正文节点仍是上一轮的回复，会被当成本轮内容发出去，续轮的回答就以上一轮的回答开头。代价是「本轮回答与上一轮逐字相同」时判不出来，但新回复的正文节点从空开始逐字长，流式期间必然出现过中间态，兜底还有 idle 超时。`snapshot.count` 保留下来只为诊断，不参与判定。

**回复靠推送而不是轮询。** 页面里的 `MutationObserver` 一有变化就通过 CDP binding 把快照推回来（`Runtime.addBinding` + `Runtime.bindingCalled`），页面内合并成最多每 120ms 一次。低频轮询仅作安全网——observer 可能漏事件，而「文本静默即完成」的判定需要在无变化时也能推进。

**工具调用是文本协议。** 提示词里注入工具 JSON Schema，约定模型输出 `<tool_call>…</tool_call>`。`ToolCallSplitter` 流式切分，只扣住可能构成标记的尾部字节，正文仍可流式输出。解析失败不静默丢弃，退回成可见文本。

**长上下文走附件。** 超过 `inlineLimit` 时上下文落盘成 `.md`，用 `DOM.setFileInputFiles` 挂到页面，本轮结束即删除临时文件。

**token 用量是估算的。** 网页不报 token 数，但 dsh 的 compaction 依赖它——不报则长会话永远不触发压缩。当前按 4 字符/token 粗估。

## 一键启动

`launcher/` 把「环境自检 → 装依赖 → 按需构建 → 挂 profile → 启动 Web UI → 自动开浏览器」串成一步，双击即可运行；没装 Node 也会自动装（macOS 走 nvm，Windows 走 winget），已就绪的步骤直接跳过。

| 平台 | 双击 | 实现 |
| --- | --- | --- |
| macOS / Linux | `launcher/launchMac.command` | 同文件 |
| Windows | `launcher/launchWindow.cmd` | `launcher/launch.ps1` |

`--rebuild` / `-Rebuild` 强制重建，`--self-test` / `-SelfTest` 只跑内部版本判断用例。端口从 3080 起自动避开已占用的端口。启动的是**本仓库源码**（`pnpm dsh web`），因此改完源码重启即生效。

只走命令行、不双击时用这条，效果等同于「挂 profile + `pnpm dsh web`」，同样幂等（端口为默认 3080）：

```sh
pnpm --filter @deepseek-ai/dsh-llm-deepseek-web start
```

`~/.dsh/` 不在版本控制里，所以别人克隆本仓库后**直接** `pnpm dsh web` 是挂不上本插件的（dsh 只会生成空的 profile 骨架）：必须经由上面任一入口，让 `install-profile.mjs` 跑过一次。

从 GitHub 直接下载 `.command` 会丢掉执行位而无法双击，分发时打包成 zip（zip 保留权限位）。

## 已知限制

- **Windows 启动器未实机验证。** `launch.cmd` / `launch.ps1` 的逻辑与 macOS 版对齐，但没有在 Windows 上跑过；`launch.command` 与 `install-profile.mjs` 已端到端验证。
- **限流未实测。** 网页版是给人交互用的，一个 agent 任务几十轮全量重发是否会触发限流/验证码，尚无数据。这是本方案最大的未知。
- **单会话串行。** 一个标签页是单一物理资源，所以请求按到达顺序排队（`createGate`）。并发不会出错，但会排队等待——真要并发得先做标签池。
- **无思考流。** 已留 `thinking` 事件通道，但页面尚未区分思考内容与正文。
- **不支持图片输入。** 附件位被上下文文档占用，图片会渲染成占位符。
- **依赖页面结构。** DeepSeek 改版可能使选择器失效，届时要更新 `page-agent.ts`。
- `temperature` / `maxTokens` / `stop` 无法控制，一律忽略；不提供 `replayState`。

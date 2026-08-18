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

**回复从站点自己的 SSE 响应读，不从 DOM 读。** `POST /api/v0/chat/completion` 的响应体是 `text/event-stream`，携带针对一个 response 对象的 JSON-Patch 式帧。我们用 `Network.streamResourceContent` 订阅它，拿到的是模型的原始输出：增量纯追加、永不回改，转义完好（`\"` 保持 `\"`，而渲染后的 `innerText` 会把它折成 `"`），也不混入代码块的语言标签和「复制/下载」按钮文字。

读 DOM 曾经带来三类 bug，它们全是渲染层的产物，在这条路径上不存在：把会自我改写的快照当增量拼接、转义被 markdown 吃掉、代码块残留污染 JSON 载荷。

**只换「读」，「写」仍然走 DOM。** 请求是页面自己发的——它带着站点的 PoW 挑战（`create_pow_challenge`，`DeepSeekHashV1`，难度 144000）、cookie 和签名头，我们只读回来的字节。所以输入框仍用 `Input.insertText`、发送仍点元素，浏览器指纹与真人操作一致，也完全不碰 PoW。

**监听必须在发送之前挂上。** 回复请求在 `compose` 里就发出去了；`Network.enable` 和事件订阅放在它之后就永远等不到那个请求。

**`streamResourceContent` 返回前的 `dataReceived` 只报长度。** 那些字节由该调用的 `bufferedData` 一次补齐，所以建流前的事件直接丢弃，不能重复计入。

**失败后那条网页对话未必要丢。** 判据是提示词有没有已经进入对话（`submitted` 里程碑），不是错误类型——两者没有因果关系。提交之前失败（登录过期、附件没挂上、找不到输入框）时页面没见过这一轮，对话仍可续用；提交之后失败则页面收到了多少、产出了什么都无从确认，只能重开，否则下一轮的增量基线是错的。

**看不懂的东西要留痕。** 桥接层没有自己的 logger，所以它把诊断作为 `diagnostic` 事件报出来，由适配器路由到 `ctx.logger`。目前有两处：无法解析为 JSON 的回复帧（协议变更唯一会留下的痕迹），以及工具调用解析失败（这条路由的格式全靠模型配合，解析失败率是它唯一的健康指标——而回合会就此被判成完成）。

**完成、用量都由流自报。** `response/status` 置为 `FINISHED` 即结束，不再需要「文本连续 N 拍不变」这种启发式判据。`accumulated_token_usage` 给出会话累计值，首末之差就是本轮真实消耗——它是一个数，覆盖提示词与回复，所以 `TokenUsage` 的总和取这个真值，input/output 的拆分按字符估算比例分配。

**token 拆分是估的，总量不是。** dsh 的 compaction 触发在总量上，那才是必须准的一半。

**请求必须排队。** dsh 生成会话标题时会额外发一个 LLM 请求，它与主请求重叠。两个 `ask()` 各自 `Input.insertText` 到同一个输入框，站点收到的是两段提示词拼在一起，然后按最后读到的那条指令作答——用户拿到的「回答」就是生成出来的标题。所以每个 dsh 会话在网页侧会有 2 个对话（1 个主 + 1 个标题），第 2 轮因记录被标题请求覆盖会全量重发一次，之后恢复增量。

**工具调用是文本协议，正文流式发出、调用等整段收完再解析。** 提示词里注入工具 JSON Schema，约定模型输出 `<tool_call>…</tool_call>`。一个调用的 JSON 只有完整时才可用，而正文可以边收边发——所以流式发到 `visibleEnd` 为止：它停在第一个可能开启调用的位置（含尾部正在长成的半截标记），因为发出去的文本收不回来，而一个调用绝不能同时又作为可见文本出现。扣住的尾巴在回复收尾时交给 `splitReply`，那时若它只是普通正文（比如讨论 JSON 的一段话）就照样放行。

解析不出调用时不静默丢弃：`agent-loop` 看到 0 个 tool-call block 就会把该回合判成完成、任务停在半路，所以退回成可见文本让人看得见发生了什么。

**协议必须写进输入框，而且注意力仍不归我们。** 站点自己的系统提示词压过我们说的任何话：把格式约定只放在附件里时，模型会从附件读到工具目录（它能叫出只可能来自那里的工具名），却把格式规则当成可以转述的说明文字——实测输出过 `[调用 glob] {"pattern": …}` 这种自创写法。所以 `TOOL_CALL_PROTOCOL` 每轮都随 `companionPrompt` 进输入框，历史里的工具调用也按同一格式回放（模型会模仿它见过的写法）。即便如此也只是提高命中率，不是保证。

**因此解析器必须极度宽容。** 这不是防御式编程，是这条通路的固有条件——我们无法约束输出格式，只能识别模型实际使用的形式。目前认四种：

| 形式 | 来源 |
|---|---|
| `<tool_call>` + ```json 代码块 | 协议规定的写法 |
| `<tool_call name="read">` 带属性、或缺闭标签 | 模型漏写、回复被截断 |
| 裸 `{"name":…,"arguments":…}` | 模型完全没写标记 |
| `[调用 read] {参数}` | 站点系统提示词压过协议时的自创写法 |

后两种以本轮工具名为闸门，普通回复里的 JSON 不会被误判。载荷取的是**第一个平衡的 JSON 对象**而非整段文本：代码块渲染后反引号消失，留在 `innerText` 里的是语言标签加代码块自己的「复制/下载」按钮文字（`json\n复制\n下载\n{…}`），整段 parse 必然失败。解析失败不静默丢弃，退回成可见文本。

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

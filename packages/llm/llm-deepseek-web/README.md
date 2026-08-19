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
| `src/render.ts` | 把 `GenerateOptions` 按内容角色渲染成 `preamble` + `history` |
| `src/parse.ts` | 把网页文本流切成可见文本与工具调用 |
| `src/adapter.ts` | `LlmAdapter` 实现 |

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `endpoint` | `http://127.0.0.1:9222` | Chrome 调试端口地址 |
| `autoLaunch` | `true` | 端口无响应时自动拉起独立实例 |
| `userDataDir` | `$DSH_HOME/deepseek-web-profile` | 自动启动使用的 profile 目录 |
| `chromePath` | 自动探测 | Chrome 可执行文件；也可用 `CHROME_PATH` 环境变量 |
| `inlineLimit` | `4000` | 对话正文超过该字符数改用 `.md` 附件发送；不影响恒在输入框的 `preamble` |
| `useAttachment` | `true` | 关掉则正文也一律走输入框；网页端拒收 `.md` 时用它兜底 |
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

**状态只在输入区里判，不看整页。** 站点把附件的失败与忙碌提示贴在输入区，而 `document.body.innerText` 含整段对话历史——一旦对话本身谈到「解析失败」「处理中」「Loading」这类词，内容就会被读成状态。历史不会消失，所以那一轮之后每轮都失败：附件被判为挂载失败（而报错里引用的「站点提示」其实来自模型自己的回复），或 `busy` 永久为真直到两分钟超时。所以 `snapshot()` 的匹配范围收在 `composerBox()` 内；输入区之外的命中记进 `failedElsewhere`，只在超时报错时作为线索出现，不作判据。

**链路进度进 logger，不进 chunk 流。** 挂附件最长等两分钟，期间必须有反馈；但 chunk 流是模型输出通道，其中的内容都要能从 session log 重建，所以 `progress` 与 `diagnostic` 共用 `ctx.logger` 这一个出口。

**看不懂的东西要留痕。** 桥接层没有自己的 logger，所以它把诊断作为 `diagnostic` 事件报出来，由适配器路由到 `ctx.logger`。目前有两处：无法解析为 JSON 的回复帧（协议变更唯一会留下的痕迹），以及工具调用解析失败（这条路由的格式全靠模型配合，解析失败率是它唯一的健康指标——而回合会就此被判成完成）。

**完成、用量都由流自报。** `response/status` 置为 `FINISHED` 即结束，不再需要「文本连续 N 拍不变」这种启发式判据。`accumulated_token_usage` 给出会话累计值，首末之差就是本轮真实消耗——它是一个数，覆盖提示词与回复，所以 `TokenUsage` 的总和取这个真值，input/output 的拆分按字符估算比例分配。

**token 拆分是估的，总量不是。** dsh 的 compaction 触发在总量上，那才是必须准的一半。

**请求必须排队。** 一个标签页是一份物理资源：两个并发的 `ask()` 各自 `Input.insertText` 到同一个输入框，站点收到的是两段提示词拼在一起，然后按最后读到的那条指令作答——用户拿到的「回答」就是生成出来的标题。

**辅助请求用一次性标签页，不和主对话竞争。** dsh 生成会话标题时会额外发一个 LLM 请求。它要一次问答就走人，而主对话要一直续下去——用 `isAgentLoopRequest` 区分两者：主请求绑定自己的标签页（`mainTargetId`），辅助请求在新标签页里跑完即关，也完全不参与会话记账。

物理隔离而不是分时复用，是因为成本方向：让辅助请求导航主标签页的话，它加载的是空白新对话（快），而主请求为了回去要重载整段历史（长对话十几秒）。让轻的那一方付代价。

顺带说明为什么以前会退化：`resolveTarget` 原来每次找「第一个 DeepSeek 标签页」，所以标题请求一导航就把主对话的页面带走了；主对话记录还在，页面却已经不在那儿，下一轮只能全量重开。


**工具调用是文本协议，正文流式发出、调用等整段收完再解析。** 提示词里注入工具 JSON Schema，约定模型输出 `<tool_call>…</tool_call>`。一个调用的 JSON 只有完整时才可用，而正文可以边收边发——所以流式发到 `visibleEnd` 为止：它停在第一个可能开启调用的位置（含尾部正在长成的半截标记），因为发出去的文本收不回来，而一个调用绝不能同时又作为可见文本出现。扣住的尾巴在回复收尾时交给 `splitReply`，那时若它只是普通正文（比如讨论 JSON 的一段话）就照样放行。

解析不出调用时不静默丢弃：`agent-loop` 看到 0 个 tool-call block 就会把该回合判成完成、任务停在半路，所以退回成可见文本让人看得见发生了什么。

**协议必须写进输入框，而且注意力仍不归我们。** 站点自己的系统提示词压过我们说的任何话：把格式约定只放在附件里时，模型会从附件读到工具目录（它能叫出只可能来自那里的工具名），却把格式规则当成可以转述的说明文字——实测输出过 `[调用 glob] {"pattern": …}` 这种自创写法。所以请求按**内容角色**切分，而不是按传输方式：`preamble`（本轮提问 + 任务要求 + `TOOL_CALL_PROTOCOL`）恒定进输入框，`history`（对话正文与工具目录）才允许改走附件。历史里的工具调用也按同一格式回放（模型会模仿它见过的写法）。即便如此也只是提高命中率，不是保证。

**因此解析器必须极度宽容。** 这不是防御式编程，是这条通路的固有条件——我们无法约束输出格式，只能识别模型实际使用的形式。目前认四种：

| 形式 | 来源 |
|---|---|
| `<tool_call>` + `json` 代码块 | 协议规定的写法 |
| `<tool_call name="read">` 带属性、或缺闭标签 | 模型漏写、回复被截断 |
| 裸 `{"name":…,"arguments":…}` | 模型完全没写标记 |
| `[调用 read] {参数}` | 站点系统提示词压过协议时的自创写法 |

后两种以本轮工具名为闸门，普通回复里的 JSON 不会被误判。载荷取的是**第一个平衡的 JSON 对象**而非整段文本：代码块渲染后反引号消失，留在 `innerText` 里的是语言标签加代码块自己的「复制/下载」按钮文字（`json\n复制\n下载\n{…}`），整段 parse 必然失败。解析失败不静默丢弃，退回成可见文本。

**长上下文走附件，但只有正文。** 对话正文超过 `inlineLimit` 时落盘成 `.md`，用 `DOM.setFileInputFiles` 挂到页面，本轮结束即删除临时文件；`preamble` 不参与这个判断。尺寸只决定传输方式，决定不了模型收到哪些指令——曾经由它决定过：协议当时只挂在附件路径的伴随文本上，而增量续轮的正文短到永远够不到阈值，于是从第二轮起协议在任何路径上都到不了模型。

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

## Model Experience

### Preamble：每轮进入输入框的指令

#### What the model sees

一段固定结构的 Markdown，恒定作为输入框文本发送，与传输方式无关：当前要回答的问题（取最后一条含文本块的 user 消息，跳过工具结果载体）、下面这段任务指令、以及下面这段工具调用协议。协议要求模型把调用写成 `<tool_call>` 包裹的 `json` 代码块，载荷是 `{"name": …, "arguments": …}`，并声明 `arguments` 必须符合该工具的 JSON Schema、JSON 必须置于代码块内（否则参数里的引号会在页面渲染时损坏）、一次可连续输出多段调用；权威文本是 `src/render.ts` 的 `TOOL_CALL_PROTOCOL`，此处不逐字转录，因为它自身含 markdown 代码围栏，无法嵌入本节要求的 `markdown` 块。站点自己的系统提示词优先级高于这三者，所以它们只提高遵循率，不构成保证。

##### Task instruction, verbatim

```markdown
## 你的任务

接着上面的对话，以助手身份给出下一条回复。
提问包含多个要点时，按提问的顺序逐条回答：先给出结论，再展开说明。
需要用工具才能回答时，直接按约定的 <tool_call> 格式输出调用，不要只说明你打算做什么。
```

#### Token effect

固定开销，每轮重发：协议与任务指令合计约 200 字符，加上本轮提问的长度。开场轮与续轮的 preamble 逐字相同——这是刻意的契约，`renderIncrement` 与 `renderRequest` 的 preamble 必须相等，由 `tests/render.spec.ts` 的等价性断言把守。省掉它曾使协议从第二轮起在任何路径上都到不了模型。

#### KV Cache effect

独立行为：网页通路不暴露 KV cache，本包也不参与 dsh 侧的前缀复用。preamble 每轮重发不影响站点侧对已有对话上下文的复用，因为它作为新一轮的用户输入追加在对话末尾。

### Conversation history：对话正文与工具目录

#### What the model sees

开场轮是系统指令、工具目录（每个工具的名称、描述与参数 JSON Schema）与全部对话记录，按 `### [n] 用户/助手/系统` 分节；续轮只有自上次发送以来新增的非 assistant 消息（新的 user 提问与工具结果）。历史里的工具调用按协议规定的 `<tool_call>` + 代码块形式回放，因为模型会模仿它在对话里见过的写法。图片块渲染成占位符，本通路不支持图片输入。

#### Token effect

条件开销：超过 `inlineLimit`（默认 4000 字符）时落盘为 `.md` 附件传输，否则并入输入框文本；两种方式的内容相同。续轮只发增量，所以一次多 step 的任务不会重发前面各 step 的工具输出。站点报告会话累计 token，首末之差为本轮真实消耗，总量取该真值，input/output 的拆分按 4 字符/token 的字符比例分配。

#### KV Cache effect

依赖站点侧保留的会话上下文，不是 dsh 的前缀缓存：续轮只发增量，等价于复用站点已持有的那段对话。任何一项成立即废弃该对话并全量重开，站点侧的复用随之全部失效——dsh 会话 id 变化、system 提示词变化、工具集变化、已发送的 message id 不再是新历史的严格前缀（compaction 改写历史即属此类），以及提示词已进入对话之后本轮失败。

## Known Limitations and Deferred Work

- **Windows 启动器未实机验证。** `launchWindow.cmd` / `launch.ps1` 的逻辑与 macOS 版对齐，但没有在 Windows 上跑过；`launchMac.command` 与 `install-profile.mjs` 已端到端验证。
- **限流未实测。** 网页版是给人交互用的，一个 agent 任务几十轮全量重发是否会触发限流/验证码，尚无数据。这是本方案最大的未知。
- **单会话串行，且并发 agent 会退化。** 请求按到达顺序排队（`createGate`）。主对话现在绑定自己的标签页，所以辅助请求不再打断它；但两个并发的 agent 会话（并发 subagent）仍共用一个 `conversation` 字段，后者会顶掉前者，双方都退化成每轮新开对话——慢，但不会串话。真并发要做标签池；对话是 URL 可寻址的（`/a/chat/s/<uuid>`，导航回去能续上历史），所以这条路已经铺平，只是没走。
- **附件状态依赖提示位于输入区。** `snapshot()` 只在 `composerBox()`（输入框往上六层）内匹配失败与忙碌提示，因为整页匹配会把对话内容读成状态。若站点把提示移出该范围，真实失败会退化成两分钟超时，超时消息里带 `failedElsewhere` 作为唯一线索。
- **格式协议只是建议。** 站点自己的系统提示词压过输入框里的约定，所以调用写法靠解析器兜。解析失败以 `warn` 记进 `ctx.logger`（会话复用之类的正常诊断走 `info`，便于把失败率筛出来）——那个失败率是这条路由唯一的健康指标，因为一次失败会让回合被判成完成。
- **SSE 是站点的私有约定。** 字段名、path 语义，以及 `Network.streamResourceContent`（实验性 CDP 命令）任一变化都会让这条路径失败。失败是明确的（未知 path 不投影、建流失败抛 `TRANSPORT`），不会悄悄产出错误文本。
- **token 拆分是估的。** 站点只报一个会话累计值，覆盖提示词与回复。总量取真值，input/output 的拆分按字符比例分配。
- **不支持图片输入。** 附件位被上下文文档占用，图片会渲染成占位符。
- **写入仍依赖页面结构。** 回复已不从 DOM 读，但输入框、发送控件、登录/忙碌判定还在 `page-agent.ts`——都用语义化属性（`[role=button]`、`aria-label`），不再依赖混淆 class。
- `temperature` / `maxTokens` / `stop` 无法控制，一律忽略；不提供 `replayState`。

# dsh-session-messaging

DeepSeek Harness 本地插件：让两个互不相关的顶层会话（侧栏里的对话）可以互相发消息。DSH 自带的消息通道都要求有授权关系——`send_message` 只能在直接父子 agent 之间传递（`ctx.subagents` 的 “exact adjacency”），Agent Teams 只能在同一个 Team 的成员之间传递——所以两个普通会话之间没有路可走。本插件补上这条通道：`session_list` 查找可发送的会话，`session_send_message` 通过 `sessionController.resolveAgent`（与网页端发送 prompt 相同的路径，必要时从存储冷恢复会话）把消息 steer 或排队投递给目标会话。消息带有 DSH 内置的转发来源标记 `{ kind: 'agent-message', form: 'relay', senderSessionId }`，写入目标会话日志；网页端在目标会话里显示为用户侧气泡，气泡上方标注“来自会话「标题」”；接收方可以用同一个工具回复。`session_create` 还能直接新开一个顶层会话：走 `sessionController.create`（与网页端“新对话”相同的路径），设好侧栏标题，再用同样的转发消息开始它的第一轮。

- `lib/index.js`（Host）：
  - `session_send_message({ session_id, message, delivery? })`：`delivery: "steer"`（默认）在目标的下一步送达，运行中的会话也会立即看到；`"queue"` 等目标当前这一轮结束后再开新一轮。空闲会话立即开始新一轮，已存储（未加载）的会话会先恢复。返回投递确认（`messageId`），不返回对方的回答；回答会以新消息的形式回到发送方会话。
  - `session_list({ query?, all_workspaces?, limit? })`：按最近活跃排序列出可发送的顶层会话（id、`running`/`inactive`、标题），默认只列当前工作区，`all_workspaces: true` 列出全部工作区。自动排除自身、空白会话、子 agent 会话和已归档会话。
  - `session_create({ title, message, workspace? })`：在已注册的工作区（默认是当前会话所在工作区；`workspace` 填 `session_list` 显示的绝对路径）新开一个顶层会话，先设标题（转发消息不会触发 DSH 的自动起标题），再用 `message` 开始第一轮。新会话独立运行、看不到发起方的对话，只有在消息里要求它用 `session_send_message` 回复时才会回报。返回新会话 id。
  - 消息开头会附一行来源说明：发送方会话 id、标题（工作区不同时附上工作区路径），注明“由对方会话的 agent 撰写，不是你的用户”，并提示用 `session_send_message` 回复、不要只为确认收到而回复（防止两个会话互相客套刷屏）。来源说明以空行结尾：相邻的文本块到模型那里会直接拼接在一起。
  - 拒绝的情况：发给自己、会话不存在、目标是子 agent 会话（应由其父会话用 `send_message`）、目标已归档、超过大小上限、`crossWorkspace: false` 时跨工作区；`session_create` 还会拒绝空标题、相对路径或未注册的工作区，以及超过 `createLimit` 的次数。子 agent 会话本身看不到这三个工具（在 `agent/created` 时对其 `agent.ctx.tools.restrict({ deny })`），因为它们无法通过这条通道收到回复。
- `lib/client.js`（浏览器）：覆盖 Chat 的 `turn-trigger` 节点渲染器。本插件转发的消息画成与用户消息相同的气泡（复用 DSH 自带的 `conversation.chat.user.content`），上方标注发送方会话，正文里不显示来源说明；目标任务、定时任务、子 agent 等其他触发消息仍交给 DSH 自带的卡片。只改显示：模型收到的内容（含来源说明）不变，历史消息也按新样式显示。
- `cordis.patch.yml`：插件行与默认配置（`crossWorkspace: true`、`maxMessageBytes: 65536`、`listLimit: 20`、`createLimit: 10`）。
- `locale/*.json`、`icon.svg`：插件管理页显示的名称、描述和图标。
- `test/client.test.js`：确认浏览器端能解析 `relayContent` 写出的来源说明（两边改动不同步会在这里失败），以及非转发消息交还给 DSH 自带渲染器。
- `test/index.test.js`：用模拟的 Harness 上下文测试投递、新开会话、各种拒绝路径、列表过滤和子 agent 工具隐藏（`npm test` / `node --test test/*.test.js`）。

## 安装

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add link:$HOME/.dsh/local-plugins/dsh-session-messaging
```

移除：在 DSH「插件」页移除该 bundle，或运行：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop remove dsh-session-messaging
```

## 已知限制

- 气泡只出现在“唤醒会话”的消息上。会话正在运行时用 `steer` 送达的消息属于 DSH 的 `context` 节点，DSH 不在对话里显示它（模型能收到），本插件也没有改变这一点。
- 气泡不折叠，很长的交接消息会占很长一屏。
- 修改 `lib/client.js` 或 `package.json` 的 `dsh.client` 后，需要 `remove_bundle` 再 `install_bundle`，并刷新页面（⌘R）。
- 只在顶层会话之间通信；子 agent / Team 成员仍走 DSH 自带的 `send_message`。
- 成功只代表目标收件箱已接受消息，不代表对方已处理；与 DSH 的 Team 消息一样，没有重试、去重或“已读”回执。
- 被唤醒的会话按它自己的权限模式运行；如果它需要审批，审批请求出现在那个会话里，可能没人在看。`session_create` 新开的会话使用默认模型、默认 preset 和默认审批策略（实测为 `ask`），不继承发起会话的设置。
- `session_create` 设的标题与用户手动改名一样会被“钉住”，之后 DSH 不会再自动改标题。
- 没有频率限制：防止两个会话来回回复靠的是来源说明里的提示，而不是硬性上限。`createLimit` 只限制单个会话在一次运行内新开的数量（存在内存里，插件重载或重启后清零），不限制“A 开 B、B 再开 C”这样的链条。
- 修改 `lib/index.js` 后，单纯保存文件不会重新加载 Host 代码；在 DSH「插件」页把本 bundle 再启用一次（或调用 `plugin_manager` 的 `set_bundle`，`enabled: true`）会触发重新组合，加载磁盘上的新代码，无需重启（实测：`session_create` 由此直接上线）。

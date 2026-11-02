# dsh-session-messaging

DeepSeek Harness 本地插件：让两个互不相关的顶层会话（侧栏里的对话）可以互相发消息。DSH 自带的消息通道都要求有授权关系——`send_message` 只能在直接父子 agent 之间传递（`ctx.subagents` 的 “exact adjacency”），Agent Teams 只能在同一个 Team 的成员之间传递——所以两个普通会话之间没有路可走。本插件补上这条通道：`session_list` 查找可发送的会话，`session_send_message` 通过 `sessionController.resolveAgent`（与网页端发送 prompt 相同的路径，必要时从存储冷恢复会话）把消息 steer 或排队投递给目标会话。消息带有 DSH 内置的转发来源标记 `{ kind: 'agent-message', form: 'relay', senderSessionId }`，写入目标会话日志；网页端在目标会话里显示为“收到任务消息”，并注明来自哪个会话；接收方可以用同一个工具回复。

- `lib/index.js`（Host）：
  - `session_send_message({ session_id, message, delivery? })`：`delivery: "steer"`（默认）在目标的下一步送达，运行中的会话也会立即看到；`"queue"` 等目标当前这一轮结束后再开新一轮。空闲会话立即开始新一轮，已存储（未加载）的会话会先恢复。返回投递确认（`messageId`），不返回对方的回答；回答会以新消息的形式回到发送方会话。
  - `session_list({ query?, all_workspaces?, limit? })`：按最近活跃排序列出可发送的顶层会话（id、`running`/`inactive`、标题），默认只列当前工作区，`all_workspaces: true` 列出全部工作区。自动排除自身、空白会话、子 agent 会话和已归档会话。
  - 消息开头会附一行来源说明：发送方会话 id、标题（工作区不同时附上工作区路径），注明“由对方会话的 agent 撰写，不是你的用户”，并提示用 `session_send_message` 回复、不要只为确认收到而回复（防止两个会话互相客套刷屏）。
  - 拒绝的情况：发给自己、会话不存在、目标是子 agent 会话（应由其父会话用 `send_message`）、目标已归档、超过大小上限、`crossWorkspace: false` 时跨工作区。子 agent 会话本身看不到这两个工具（在 `agent/created` 时对其 `agent.ctx.tools.restrict({ deny })`），因为它们无法通过这条通道收到回复。
- `cordis.patch.yml`：插件行与默认配置（`crossWorkspace: true`、`maxMessageBytes: 65536`、`listLimit: 20`）。
- `locale/*.json`、`icon.svg`：插件管理页显示的名称、描述和图标。
- `test/index.test.js`：用模拟的 Harness 上下文测试投递、各种拒绝路径、列表过滤和子 agent 工具隐藏（`npm test` / `node --test test/*.test.js`）。

## 安装

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add link:$HOME/.dsh/local-plugins/dsh-session-messaging
```

移除：在 DSH「插件」页移除该 bundle，或运行：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop remove dsh-session-messaging
```

## 已知限制

- 只在顶层会话之间通信；子 agent / Team 成员仍走 DSH 自带的 `send_message`。
- 成功只代表目标收件箱已接受消息，不代表对方已处理；与 DSH 的 Team 消息一样，没有重试、去重或“已读”回执。
- 被唤醒的会话按它自己的权限模式运行；如果它需要审批，审批请求出现在那个会话里，可能没人在看。
- 没有频率限制：防止两个会话来回回复靠的是来源说明里的提示，而不是硬性上限。
- 修改 `lib/index.js` 后需重启 DeepSeek Harness 才能加载新模块：编辑已链接的文件不会热重载 Host 代码（实测：改动后发出的消息仍由旧代码生成）。

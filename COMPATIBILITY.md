# 兼容性与实测记录

本包是 [tonyzdev/dsh-session-messaging](https://github.com/tonyzdev/dsh-session-messaging) v0.3.2 的发布分支，
**代码未改动**。本文件记录它依赖的宿主接口，以及我们在哪些 DSH 版本上实际用过。

## 声明的兼容范围

```json
"engines": { "dsh": ">=0.2.0-rc.1 <0.3.0-0" }
```

## 依赖的宿主接口

插件只使用公共扩展点，没有 pin 到具体实现细节：

| 接口 | 用途 |
|---|---|
| `ctx.sessionController.list / resolveAgent / create` | 列出会话、解析目标、新建会话 |
| `ctx.agents.get / withoutInitiator` | 取 Agent、投递时排除发起者 |
| `target.steer / target.followup` | 投递消息（steer 打断 / followup 排队） |
| `ctx.sessions.get / flush` | 冷恢复与刷盘 |
| `ctx.sessionQuery.filterSessions / readTitleSnapshots` | 会话查询与标题 |
| `ctx.get('sessionTitle') / workspaceRegistry` | 标题、工作区与归档状态 |
| `ctx.tools.register / restrict` | 注册三个工具、对子代理隐藏 |

**没有**使用附件读取（`readAttachment`）、也没有依赖会话日志内部结构——这正是它和
`dsh-redo` 不同的地方：后者因为附件 API 在 0.2.2 变更而必须适配，本插件不涉及。

## 实测记录

| DSH 版本 | 结果 | 验证内容 |
|---|---|---|
| **0.2.1-rc.2** | ✅ 通过 | 三个工具出现在工具列表；`session_send_message` 投递成功（目标会话被唤醒并回信）；转发消息在前端显示为标注发送方的用户侧气泡 |
| 0.2.2-rc.1 | ⏳ 待测 | 接口面未变，风险低；等宿主升级后补测 |
| 更早（<0.2.0-rc.1） | ❌ | `engines` 不覆盖 |

> 升级宿主后请先测三件事：`session_list` 能否列出会话、`session_send_message` 是否投递并唤醒目标、
> 转发气泡是否带发送方标题。任一项异常再考虑改代码。

## 安装

1. **填包名**：`@you/dsh-session-messaging`（需要先发布到 npm）；
2. **填仓库地址**：`https://github.com/YZKZK01/dsh-session-messaging`；
3. **本地目录**：把本目录（含 `lib/`）指给插件页。

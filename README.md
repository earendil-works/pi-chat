# pi-chat

一个将 Discord、Telegram 和飞书会话连接到沙箱化 pi 会话的扩展。每个已连接的频道都会获得独立的 [Gondolin](https://github.com/earendil-works/gondolin) 微型虚拟机，并拥有持久化工作区、共享存储、记忆和技能。

## 快速开始

```bash
# 安装
pi install /path/to/pi-chat
# 或直接加载扩展
pi -e /path/to/pi-chat

# 配置账号与频道
/chat-config

# 建立连接
/chat-connect
```

### 运行要求

- 已安装 [QEMU](https://www.qemu.org/)；macOS 可运行 `brew install qemu`
- Gondolin 客体镜像；首次连接时会自动下载
- Discord Bot Token、Telegram Bot Token，或飞书应用的 App ID 与 App Secret
- 使用多频道 worker 编排功能时需要安装 `tmux`

---

## 功能

- 支持 **Discord 服务器频道**、**Telegram 私聊/群组**和**飞书私聊/群组**
- **每条连接独立的 Gondolin VM 沙箱**：工具在隔离的 Alpine Linux 微型虚拟机中运行
- **持久化工作区与共享存储**：重连或重启后仍可继续使用
- **流式预览回复**：生成过程中原地编辑预览消息
- **回复触发消息**：机器人回复会关联到触发本次任务的原消息
- **持久化记忆**：支持账号级和频道级记忆文件
- **技能系统**：自动发现智能体创建的可复用技能，并注入系统提示词
- **加密密钥交换**：通过浏览器端加密流程安全地传递凭据
- **远程控制**：可在聊天中停止任务、压缩上下文、创建新会话或查看状态
- **远程切换模型**：可在聊天中查看可用模型并切换当前会话使用的模型
- **历史记录查询**：通过 `chat_history` 搜索更早的消息
- **文件附件**：支持在聊天平台和虚拟机之间收发文件
- **宿主机目录挂载**：将额外的宿主机目录暴露到 Gondolin VM 中，可按需设置为只读或读写
- **多频道 worker**：可为全部已配置频道启动独立的 tmux/pi worker

---

## 平台配置

### Discord

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建应用和机器人
2. 在 Bot 设置中启用 **Message Content Intent**
3. 运行 `/chat-config`，依次选择 **Create account → Discord**
4. 输入 Bot Token
5. 将机器人邀请到服务器；配置流程会提供邀请地址
6. 选择服务器并配置需要连接的频道

### Telegram

1. 通过 [@BotFather](https://t.me/BotFather) 创建机器人
2. 运行 `/chat-config`，依次选择 **Create account → Telegram**
3. 输入 Bot Token
4. 按引导流程添加私聊或群组

### 飞书

1. 在[飞书开放平台](https://open.feishu.cn/app/)创建企业自建应用
2. 为应用启用机器人能力，并在目标租户中发布和安装应用
3. 授予以下功能所需的权限：
   - 发送消息
   - 获取机器人所在群聊
   - 获取群成员
   - 读取机器人需要接收的消息
   - 下载消息中的资源文件
4. 在飞书开放平台的**事件与回调**中选择长连接接收事件，并订阅 `im.message.receive_v1`
5. 运行 `/chat-config`，依次选择 **Create account → Feishu**
6. 输入应用的 App ID 和 App Secret
7. 从自动发现的群聊中选择频道，或者使用 **Add DM** / **Observe group**，通过发送消息完成会话配对

#### 飞书消息接收模式

飞书账号默认使用 **Auto** 模式：

- 只有一个已配置频道时，使用官方 WebSocket 长连接，以获得更低的消息延迟
- 配置了多个频道时，使用历史消息轮询，以便 `/chat-spawn-all` 能为每个频道运行独立 worker
- 历史消息轮询需要应用具有读取对应会话历史消息的权限

也可以在飞书账号配置菜单中强制选择：

| 模式 | 说明 |
|------|------|
| `Auto` | 单频道使用 WebSocket，多频道使用历史消息轮询 |
| `WebSocket` | 延迟更低；适合每个飞书应用仅运行一个连接客户端的场景 |
| `History polling` | 支持同一飞书应用运行多个独立频道 worker，但需要历史消息读取权限 |

不建议让同一个飞书应用的多个 worker 强制使用 WebSocket。飞书长连接采用集群投递，同一事件只会发送给其中一个已连接客户端，而不是广播给全部客户端。

---

## 命令

| 命令 | 说明 |
|------|------|
| `/chat-config` | 配置账号、频道、访问策略和密钥 |
| `/chat-connect` | 连接一个已配置频道 |
| `/chat-disconnect` | 断开当前频道 |
| `/chat-status` | 查看连接状态、模型、用量和上下文状态 |
| `/chat-list` | 列出全部已配置频道 |
| `/chat-spawn-all` | 为全部已配置频道启动独立的后台 tmux/pi worker |
| `/chat-spawn-all --restart` | 重启全部受管理的 tmux/pi worker |
| `/chat-workers` | 查看受管理 worker 的状态 |
| `/chat-open-all` | 在平铺式 tmux 面板中打开所有运行中的 worker |
| `/chat-kill-all` | 停止全部受管理的 tmux/pi worker |
| `/chat-new` | 保持聊天连接，同时创建新的 pi 会话 |

worker 每 15 秒向以下目录写入一次状态快照：

```text
~/.pi/agent/chat/worker-status/
```

编排用的 pi 智能体也可以通过 `chat_workers` 工具读取相同的状态信息。

---

## 聊天远程控制

已连接会话中的用户可以发送以下命令。命令必须以 `/` 开头，并作为一条独立消息发送；也可以在消息中提及机器人。

| 命令 | 效果 |
|------|------|
| `/stop` | 中止当前智能体任务 |
| `/status` | 查看模型、用量和上下文状态 |
| `/compact` | 触发上下文压缩 |
| `/new` | 创建新的 pi 会话 |
| `/model` | 列出可用模型 |
| `/model <provider/id\|name>` | 切换当前会话使用的模型 |

在群聊中不需要额外 @ 机器人。命令成功后，机器人会回复 `Started a new pi session.`，后续模型上下文不再包含重置前的会话消息；频道工作区、`memory.md`、技能和聊天日志不会被删除。

使用 `/model` 且不带参数时，机器人会列出当前可用的模型。使用 `/model <provider/id>` 或模型名称即可切换当前会话的活动模型；切换会通过 pi 的 `setModel()` 生效，不会重置会话上下文。模型名称需要与当前 pi 环境中已配置并可用的模型匹配。

远程控制命令仍会经过当前频道的用户、角色和机器人访问策略检查。

---

## 消息触发规则

- 私聊中的每条消息默认都会触发任务
- 群组或频道中的消息默认只有在提及机器人时才会触发任务
- 可以通过 `/chat-config` 将频道触发方式改为每条消息都触发
- 未触发任务的消息仍会写入频道日志，并可能包含在下一次触发产生的消息切片中
- 重连期间补收的历史消息只会写入日志，不会立即触发任务

---

## 存储目录

全部配置和持久化数据均保存在 `~/.pi/agent/chat/`：

```text
~/.pi/agent/chat/
├── config.json                          # 账号、频道、访问策略和密钥配置
├── cache/                               # 服务发现缓存
├── worker-status/                       # 多频道 worker 状态
└── accounts/<account>/
    ├── shared/                          # 在 VM 中挂载为 /shared
    │   ├── memory.md                    # 账号级持久化记忆
    │   └── skills/                      # 账号级技能
    └── channels/<channel>/
        ├── channel.jsonl                # 频道消息和任务事件日志
        ├── .lock                        # 运行时连接锁
        ├── workspace/                   # 在 VM 中挂载为 /workspace
        │   ├── memory.md                # 频道级持久化记忆
        │   ├── skills/                  # 频道级技能
        │   ├── incoming/                # 下载的聊天附件
        │   ├── .secrets/                # 运行时加密交换得到的密钥
        │   └── SYSTEM.md                # 环境修改记录
        └── gondolin/                    # Gondolin VM 状态
            └── session.json
```

`channel.jsonl` 是追加写入的事件流，可能包含以下记录类型：

```text
checkpoint
inbound
job_queued
outbound
job_completed
job_failed
error
```

---

## 虚拟机环境

每条连接都会启动一个 Gondolin 微型虚拟机，其中包含：

- 预装 bash 的 **Alpine Linux**
- `/workspace`：当前频道的持久化工作区
- `/shared`：当前账号下所有频道共享的目录
- `read`、`write`、`edit` 和 `bash` 工具
- 默认允许出站 HTTP/TLS 访问

智能体看到的工作目录是 `/workspace`。宿主机环境变量不会自动泄露到虚拟机。

### 挂载宿主机目录

可以通过 `/chat-config` 中的 **Mounts** 菜单，将宿主机上的其他目录挂载到当前的 Gondolin VM 中。挂载目录不会替代或覆盖 `/workspace`、`/shared`，而是以额外路径出现在虚拟机内。

配置时需要填写：

- **Host directory**：宿主机目录，可以使用 `~` 表示当前用户的 home 目录
- **Guest path**：目录在 VM 中的绝对路径；留空时默认为 `/mnt/<宿主机目录名>`
- **Mount mode**：`Read-only` 或 `Read-write`

挂载配置可以在三个层级设置：

- **全局级**：所有账号和频道使用
- **账号级**：该账号下的所有频道使用
- **频道级**：仅当前频道使用

后面的层级会覆盖前面层级中相同 guest path 的配置，因此可以先配置全局挂载，再在账号或频道级调整。不同挂载的 guest path 不能互相嵌套。

例如，在 `/chat-config` 中添加以下挂载：

```text
Host directory: ~/Documents/project
Guest path:    /mnt/project
Mount mode:    Read-only
```

配置保存并重启沙箱后，智能体即可通过 `/mnt/project` 读取宿主机目录中的文件。只读挂载上的文件不能被智能体创建、修改或删除；如需写入，请选择 `Read-write`。挂载的宿主机目录必须在启动 VM 时存在且为目录。

挂载也可以直接写入 `~/.pi/agent/chat/config.json` 的 `gondolin.mounts` 配置中：

```json
{
  "gondolin": {
    "mounts": [
      {
        "hostPath": "~/Documents/project",
        "guestPath": "/mnt/project",
        "readOnly": true
      }
    ]
  }
}
```

账号级和频道级配置使用相同的 `gondolin.mounts` 字段，分别放在账号对象和频道对象中。修改挂载配置后需要重启对应沙箱；`/chat-config` 保存挂载变更时会提示重启。

---

## 记忆

系统在每次智能体任务开始前注入两类持久化记忆：

| 文件 | VM 路径 | 作用域 |
|------|---------|--------|
| 账号记忆 | `/shared/memory.md` | 当前账号下所有频道共享 |
| 频道记忆 | `/workspace/memory.md` | 仅当前频道可见 |

当用户要求记住某项信息时，智能体会根据作用域将内容写入相应文件：

- 跨频道信息写入 `/shared/memory.md`
- 频道专属信息写入 `/workspace/memory.md`
- 不确定作用域时应先向用户确认
- 不应将频道私密信息写入共享记忆

---

## 技能

智能体可以按照 [Agent Skills 标准](https://agentskills.io)创建可复用技能：

- **账号级技能：** `/shared/skills/`
- **频道级技能：** `/workspace/skills/`

技能可以是单个 Markdown 文件，例如：

```text
skills/foo.md
```

也可以是包含 `SKILL.md` 和辅助文件的目录：

```text
skills/foo/
├── SKILL.md
└── run.sh
```

每个技能都需要包含 YAML frontmatter：

```yaml
---
name: skill-name
description: 说明此技能用途的简短描述
---
```

pi-chat 会自动发现技能，并将技能名称、描述和路径加入系统提示词。智能体在使用技能前会先读取完整技能文件。

---

## 密钥

### 配置密钥

可以通过 `/chat-config` 在三个层级配置 Gondolin HTTP Hook 密钥：

- **全局级**：所有账号共享
- **账号级**：当前账号下所有频道共享
- **频道级**：仅当前频道使用

每个密钥包含：

- 密钥值
- 允许使用该密钥的目标主机列表

Gondolin 会在虚拟机发起前往允许主机的 HTTP 请求时，将占位环境变量替换为真实密钥。智能体本身无法直接读取真实密钥值。

### 运行时加密密钥交换

对于智能体运行时需要的凭据，例如技能 API Key、OAuth 文件或其他令牌：

1. 智能体调用 `chat_request_secret`
2. pi-chat 生成临时 RSA 密钥对，并向聊天发送带有公钥的 `pi.dev/secret` 地址
3. 用户打开页面并输入密钥
4. 页面在浏览器中加密密钥，并生成加密载荷
5. 用户将加密载荷发送回聊天
6. pi-chat 使用内存中的临时私钥解密，并保存到 `/workspace/.secrets/<name>`
7. 智能体收到密钥已保存的通知

交换过程使用 RSA-OAEP、AES-256-GCM 混合加密。没有 pi-chat 内存中的临时私钥，加密载荷无法被解密。

---

## 工具

| 工具 | 说明 |
|------|------|
| `read` | 在 Gondolin VM 中读取文件 |
| `write` | 在 Gondolin VM 中创建或覆盖文件 |
| `edit` | 在 Gondolin VM 中精确修改文件 |
| `bash` | 在 Gondolin VM 中执行 `/bin/bash` 命令 |
| `chat_history` | 搜索当前频道日志中的历史消息 |
| `chat_attach` | 将文件加入下一条聊天回复的附件队列 |
| `chat_request_secret` | 请求用户通过加密交换流程提供密钥 |
| `chat_workers` | 查看受管理的多频道 worker 状态 |

远程聊天任务只能使用经过允许的工具，其他工具调用会被阻止。

---

## 开发

安装依赖：

```bash
npm install
```

运行格式和 TypeScript 检查：

```bash
npm run check
```

自动格式化：

```bash
npm run format
```

项目入口为 `index.ts`。核心实现位于 `src/`：

```text
src/
├── core/       # 配置、发现和运行时类型
├── live/       # Discord、Telegram、飞书实时适配器
├── render/     # 消息格式化、分块和预览
├── services/   # 账号验证和服务发现
└── tui/        # /chat-config 交互界面
```

---

## 致谢

pi-chat 的以下渲染逻辑参考并改编自 [Vercel Chat SDK](https://github.com/vercel/ai)（MIT）：

- `src/render/format.ts`
- `src/render/streaming-markdown.ts`
- `src/render/streaming.ts`

飞书适配使用飞书官方 Node SDK：

- `@larksuiteoapi/node-sdk`

---

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。

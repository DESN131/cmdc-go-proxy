<h1 align="center">Command Code Go 代理</h1>

<p align="center">
  让其他软件和 agent 使用 Command Code Go 模型<br>
  OpenAI Chat Completions · Responses API · Anthropic Messages · 流式输出
</p>

<p align="center">
  <strong>简体中文</strong> ·
  <a href="README.md">English</a>
</p>

---

## 快速开始

环境要求：

- Node.js 20 或更高版本
- 已安装并登录 Command Code CLI（`cmdc login`）
- 你的 Command Code 套餐包含要使用的模型

启动代理：

```powershell
npm start
```

或者直接运行：

```powershell
node cmdc-proxy.mjs
```

默认地址：`http://127.0.0.1:8787/v1`。

### 客户端配置

| 配置项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | 任意占位符，例如 `local` |
| Model | 从 `GET /v1/models` 获取的 Command Code 模型 ID |

代理会使用 `~/.commandcode/auth.json` 中已有的 Command Code 登录信息，客户端不需要真实 Key。

### OpenAI Chat Completions

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="local",
)

response = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "Say hello"}],
)

print(response.choices[0].message.content)
```

### Anthropic Messages

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:8787",
    api_key="local",
)

message = client.messages.create(
    model="deepseek/deepseek-v4-flash",
    max_tokens=200,
    messages=[{"role": "user", "content": "Say hello"}],
)

print(message.content)
```

### OpenAI Responses

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="local",
)

response = client.responses.create(
    model="deepseek/deepseek-v4-flash",
    input="Say hello",
)

print(response.output_text)
```

## 工作原理

- 读取本机 Command Code CLI 的登录信息。
- 请求 `https://api.commandcode.ai/alpha/generate`。
- 自动添加 Command Code CLI 所需的请求头。
- 将 Command Code 的逐行事件流转换为客户端协议。
- 支持流式、非流式、函数工具、Codex 自定义工具、命名空间工具、推理内容和 usage。
- 在后续轮次回放助手推理，并为同一客户端会话保持稳定的上游线程。

### Codex / Responses 工具

Codex 会把 `apply_patch` 作为自由格式的 `custom` 工具发送，并把 MCP 工具放在 `namespace` 工具中。代理会先把它们展开为普通的函数工具发给上游，再把上游返回的调用还原为 `custom_tool_call` 或带命名空间的 `function_call`。这是 Codex 通过代理编辑文件和调用 MCP 工具所必需的。

Responses 的 reasoning 项会被保留。代理用一种紧凑的本地编码写入 `encrypted_content`，以便下一轮回放相同的推理文本；其他来源的不可读 reasoning 会以空推理块回放。

### 思考指令

最新用户消息开头的 `/think` 和 `/no_think` 会在转发前移除，并转换为推理强度。流式输出开头出现的同类控制标记也会被移除，避免出现在客户端界面中。

## 端点

| 端点 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /v1/messages` | Anthropic Messages API |
| `GET /v1/models` | 当前套餐可用的模型 |
| `GET /v1/usage` | 账号、订阅、额度和用量汇总 |
| `GET /v1/usage/whoami` | 账号信息 |
| `GET /v1/usage/subscription` | 订阅套餐和计费周期 |
| `GET /v1/usage/credits` | 月度额度及当前用量窗口 |
| `GET /v1/usage/summary` | 用量总计和每日明细 |
| `GET /health` | 本地代理健康检查 |

### 用量查询

用量端点使用本机登录信息调用 Command Code 官方的账号、账单和用量服务：

```powershell
curl http://127.0.0.1:8787/v1/usage
```

聚合响应包含 `account`、`subscription`、`credits` 和 `summary`。只需要其中一部分时，可调用对应的 `/v1/usage/...` 单项端点。`/v1/usage` 和 `/v1/usage/summary` 上的查询参数（例如 `since`）会透传到上游。

## 模型 ID

请使用 `GET /v1/models` 返回的精确 ID。默认 Go 套餐的示例包括：

```text
deepseek/deepseek-v4-flash
deepseek/deepseek-v4-pro
z-ai/glm-5.3-flash
zai-org/GLM-5.3
moonshotai/Kimi-K2.7-Code
MiniMaxAI/MiniMax-M3
Qwen/Qwen3.8-Max
xai/grok-4.5
gpt-6-luna
```

模型目录会根据 `CMDC_PLAN` 过滤。

Codex 使用的模型别名（例如 `deepseek-flash`、`deepseek-v4-pro`）会自动解析为对应的 Command Code 模型 ID。

## 推理强度

Command Code 接受 `off`、`low`、`medium`、`high`、`xhigh`、`max`。代理会在转发前归一化常见客户端值：

| 客户端值 | 上游值 |
| --- | --- |
| `none`、`disabled`、空字符串、`null`、`false`、`0` | `off` |
| `minimal` | `low` |
| `auto`、`default`、未知字符串 | 省略 |

这样 Cherry Studio 等客户端在关闭推理时也能正常请求。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `CMDC_BASE_URL` | `https://api.commandcode.ai` | 上游基础地址 |
| `CMDC_AUTH_PATH` | `~/.commandcode/auth.json` | Command Code 登录文件 |
| `COMMAND_CODE_API_KEY` | 未设置 | 覆盖登录 Key |
| `CMDC_CLI_VERSION` | `1.84.0` | `x-command-code-version` |
| `CMDC_ENV` | `production` | `x-cli-environment` |
| `CMDC_WORKDIR` | 当前目录 | 发送给上游的工作目录 |
| `CMDC_PROJECT_SLUG` | 由工作目录生成 | `x-project-slug` |
| `CMDC_PLAN` | `individual-go` | 过滤 `/v1/models` |
| `CMDC_THREAD_ID` | 自动生成 | 可选的固定上游线程 UUID；无效值会被忽略 |
| `CMDC_SURFACE` | 未设置 | 可选的 `x-cli-surface` |
| `CMDC_TASTE_LEARNING` | `false` | `x-taste-learning` |
| `CMDC_PERMISSION_MODE` | `standard` | Command Code 权限模式（`standard`、`plan`、`auto-accept`；`bypass` 映射为 `auto-accept`） |
| `CMDC_MODE` | `agent` | 上游生成模式（`agent`、`learning`、`custom-agent`、`custom-agent-create`、`title-gen`、`tool-desc`、`compact`、`vision`） |
| `CMDC_ZDR` | 未设置 | 设为 `1` 时发送 `x-cmd-zdr` |

## 限制

- 只实现 Chat Completions、Responses 和 Anthropic Messages。不暴露 embeddings、图片生成、音频和原生 provider 路由。
- Responses 翻译不支持 `previous_response_id`、后台任务、托管工具和文件输入。
- 工具选择通过 system 指令表达；`tool_choice: "none"` 会直接省略工具。
- 支持函数工具、自定义工具和命名空间工具；`web_search` 等托管工具不会透传到上游。
- 推理强度会根据 Command Code 模型目录中该模型支持的值自动收敛。
- 套餐权限、额度、限流和计费由上游服务执行。
- 这是非官方兼容层，Command Code CLI API 变化时可能需要更新。

## 安全

- 默认只监听 `127.0.0.1`。
- 不要在未增加认证的情况下公开监听。
- 妥善保管 `~/.commandcode/auth.json`，不要提交或写入日志。
- 从其他软件使用订阅前，请确认并遵守 Command Code 的相关条款。

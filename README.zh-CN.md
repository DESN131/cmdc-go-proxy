<h1 align="center">Command Code Go 代理</h1>

<p align="center">
  让其他软件和 agent 使用 Command Code Go 模型<br>
  OpenAI Chat Completions · 流式输出 · 工具调用 · 推理内容
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

如果首选端口已被占用，代理会自动尝试后续端口（最多 `PORT_ATTEMPTS` 个），并在启动日志中打印实际监听地址。

每个请求日志包含时间、状态码、模型、流式模式、输入/输出/总 token、缓存与推理 token、总耗时、首 token 延迟（TTFT）、实际生成窗口，以及按该窗口计算的输出速度（tok/s）。

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

## 工作原理

- 读取本机 Command Code CLI 的登录信息。
- 请求 `https://api.commandcode.ai/alpha/generate`。
- 自动添加 Command Code CLI 所需的请求头。
- 将 Command Code 的逐行事件流转换为 OpenAI Chat Completions 的分块和完整响应。
- 支持流式、非流式、函数工具、Codex 自定义工具、命名空间工具、推理内容和 usage。
- 在后续轮次回放助手推理，并为同一客户端会话保持稳定的上游线程。收到合法的上游 `finish` 后会立即停止读取，不再等待连接关闭。上游提前 EOF 时会补发合法终止事件、记录错误并切换上游线程。
- 如果一次尝试在产生任何文本、推理或工具调用前失败，代理会切换到新线程重试一次；两次都没有有效输出时返回 `502`，不会伪装成成功的空回复。
- `CMDC_STREAM_IDLE_TIMEOUT_MS` 同时约束等待响应头读取流数据的空闲时间，避免上游卡住后请求永久挂起。
- 转发前修复不完整的工具调用历史：缺失的工具结果会补为“执行被中断”的结果，孤立的工具结果会被丢弃；连续的用户消息按原样转发，不再合并。
- 空的助手轮次默认保留为空内容，避免角色顺序和对话边界被破坏，也不额外改写提示词缓存前缀。只有在确有上游兼容需求时才设置 `CMDC_EMPTY_ASSISTANT_PLACEHOLDER=1` 使用占位文本。
- 提供上游传输层体积保护。默认超限请求会返回 `context_length_exceeded`，代理不会改写历史。

### 工具兼容性

接口支持标准 Chat Completions 函数工具，也接受部分 Codex 兼容客户端使用的 `custom` 和 `namespace` 工具描述。代理会把它们展开成普通函数工具发给上游，并以标准 `tool_calls` 分块返回；自由格式自定义工具的内容放在 `input` 字符串参数中。

上游模型输出推理内容时，代理会通过 `reasoning_content` 字段返回，兼容客户端可以在后续轮次回放。

### 思考指令

所有用户消息开头的 `/think` 和 `/no_think` 都会在转发前确定性移除；只有最新用户消息的标记会改变本次请求的推理强度。这样同一段历史在后续轮次中不会因旧标记重新出现而改变前缀。System/developer 消息不会被当作控制指令解析。流式输出开头出现的同类控制标记也会被移除，避免出现在客户端界面中。

不支持的语义级 Chat 参数会返回 `unsupported_parameter`，而不是静默忽略：`n` 必须为 `1`；`logprobs`/`top_logprobs`、`seed` 和未知的 `response_format` 类型不受支持。`response_format: json_object`/`json_schema` 与 `parallel_tool_calls: false` 会转换为尽力而为的 system 约束，因为 Command Code API 没有精确等价参数。

## 端点

| 端点 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
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
| `PORT_ATTEMPTS` | `20` | 首选端口被占用时，最多向后尝试的连续端口数 |
| `LOG_TIME_ZONE` | `Asia/Hong_Kong` | 日志时间戳使用的时区 |
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
| `CMDC_DEBUG` | 未设置 | 设为 `1` 时写入逐请求的 JSONL 诊断日志 |
| `CMDC_DEBUG_DIR` | `<工作目录>/.cmdc-debug` | 调试日志目录；设置该变量也会启用 debug 模式 |
| `CMDC_STREAM_IDLE_TIMEOUT_MS` | `120000` | 等待上游响应头或流数据的最长空闲时间；设为 `0` 可关闭 |
| `CMDC_EMPTY_ASSISTANT_PLACEHOLDER` | 未设置 | 设为 `1` 时用兼容占位文本替换空助手历史 |
| `CMDC_CONTEXT_MODE` | `error` | `error` 直接拒绝超限请求且不改写历史；`auto` 超限时移除旧图片；`passthrough` 关闭保护；`strip-images` 总是移除旧图片 |
| `CMDC_MAX_REQUEST_BYTES` | `8388608` | `auto` 和 `error` 模式使用的软阈值 |
| `CMDC_HARD_REQUEST_BYTES` | `12582912` | 硬上限；超过时返回 `context_length_exceeded` |

## 调试

启动代理前启用 debug 模式：

```powershell
$env:CMDC_DEBUG = "1"
npm start
```

每个请求会在 `.cmdc-debug/` 下生成一个 JSONL 文件，包含客户端请求、转换后的上游请求、脱敏后的请求头、上游响应状态与响应头、每条上游原始数据及其时间偏移，以及最终的 usage/错误结果。启动日志会打印 `debug log: ...` 路径。

也可以在单个请求中发送 `x-cmdc-debug: 1` 请求头，无需重启代理。Authorization 和 API Key 请求头会被脱敏，但提示词、工具输出和模型输出会原样记录；分享日志前请先检查内容。

对话压缩仍由 harness 负责。默认的 `error` 模式不改写历史，因此能保持上游提示词缓存的前缀：harness 在明确的压缩边界处理一次后，后续追加消息可以继续命中缓存。`auto` 和 `strip-images` 只是兼容性兜底；从历史中间删除图片会让第一张被改动的图片之后全部缓存失效。

## 限制

- 只实现 OpenAI Chat Completions 聊天请求。不暴露 Responses、Anthropic Messages、embeddings、图片生成、音频和原生 provider 路由；不支持的 Chat 字段会明确拒绝，不会静默降级。
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

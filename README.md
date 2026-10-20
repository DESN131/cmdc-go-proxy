<h1 align="center">Command Code Go Proxy</h1>

<p align="center">
  Use Command Code Go models from other software and agents<br>
  OpenAI Chat Completions · Responses API · Anthropic Messages · Streaming
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

---

## Quick Start

Requirements:

- Node.js 20 or newer
- Command Code CLI installed and logged in (`cmdc login`)
- A Command Code plan that includes the models you want to use

Start the proxy:

```powershell
npm start
```

Or run it directly:

```powershell
node cmdc-proxy.mjs
```

The default endpoint is `http://127.0.0.1:8787/v1`.

### Client settings

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | Any placeholder, such as `local` |
| Model | A Command Code model ID from `GET /v1/models` |

The proxy uses your existing Command Code login from `~/.commandcode/auth.json`; clients do not need the real Command Code key.

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

## How It Works

- Reads the existing Command Code CLI login.
- Sends requests to `https://api.commandcode.ai/alpha/generate`.
- Adds the Command Code CLI request headers.
- Translates Command Code's newline-delimited event stream into the client protocol.
- Supports streaming and non-streaming requests, function tools, Codex custom tools, namespaced tools, reasoning content, and usage.
- Replays assistant reasoning on later turns and keeps a stable upstream thread per client conversation.

### Codex / Responses tools

Codex sends `apply_patch` as a freeform `custom` tool and groups MCP tools in `namespace` tools. The proxy exposes both as ordinary function tools upstream, then converts the returned calls back into `custom_tool_call` / namespaced `function_call` items. This is required for Codex to edit files and use MCP tools through the proxy.

Responses reasoning items are preserved. The proxy emits `encrypted_content` in a compact local encoding so the next turn can replay the same reasoning text; opaque reasoning from other providers is replayed as an empty reasoning block.

### Thinking directives

Leading `/think` and `/no_think` directives in the latest user message are removed before forwarding and mapped to reasoning effort. The same control markers are stripped from the beginning of streamed reasoning and content, so they do not appear in the client UI.

## Endpoints

| Endpoint | Description |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /v1/messages` | Anthropic Messages API |
| `GET /v1/models` | Models available on the configured plan |
| `GET /v1/usage` | Account, plan, credits, and usage summary |
| `GET /v1/usage/whoami` | Account information |
| `GET /v1/usage/subscription` | Subscription plan and billing period |
| `GET /v1/usage/credits` | Monthly credits and current usage windows |
| `GET /v1/usage/summary` | Usage totals and daily breakdown |
| `GET /health` | Local proxy health check |

### Usage

The usage endpoints call Command Code's official `whoami`, billing, and usage services with the local login:

```powershell
curl http://127.0.0.1:8787/v1/usage
```

The aggregate response contains `account`, `subscription`, `credits`, and `summary`. Use the individual `/v1/usage/...` endpoints when only one section is needed. Query parameters on `/v1/usage` and `/v1/usage/summary`, such as `since`, are forwarded upstream.

## Model IDs

Use the exact IDs returned by `GET /v1/models`. With the default Go plan, examples include:

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

The model catalog is filtered by `CMDC_PLAN`.

Client-specific slugs used by Codex, such as `deepseek-flash` and `deepseek-v4-pro`, are resolved to the matching Command Code model IDs automatically.

## Reasoning Effort

Command Code accepts `off`, `low`, `medium`, `high`, `xhigh`, and `max`. The proxy normalizes common client values before forwarding:

| Client value | Upstream value |
| --- | --- |
| `none`, `disabled`, empty string, `null`, `false`, `0` | `off` |
| `minimal` | `low` |
| `auto`, `default`, unknown strings | omitted |

This keeps clients such as Cherry Studio working when reasoning is disabled.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Listen host |
| `CMDC_BASE_URL` | `https://api.commandcode.ai` | Upstream base URL |
| `CMDC_AUTH_PATH` | `~/.commandcode/auth.json` | Command Code login file |
| `COMMAND_CODE_API_KEY` | unset | Override the login key |
| `CMDC_CLI_VERSION` | `1.84.0` | Value for `x-command-code-version` |
| `CMDC_ENV` | `production` | Value for `x-cli-environment` |
| `CMDC_WORKDIR` | current directory | Working directory sent upstream |
| `CMDC_PROJECT_SLUG` | derived from workdir | Value for `x-project-slug` |
| `CMDC_PLAN` | `individual-go` | Filters `/v1/models` |
| `CMDC_THREAD_ID` | generated | Optional stable upstream thread UUID; invalid values are ignored |
| `CMDC_SURFACE` | unset | Optional `x-cli-surface` value |
| `CMDC_TASTE_LEARNING` | `false` | Value for `x-taste-learning` |
| `CMDC_PERMISSION_MODE` | `standard` | Command Code permission mode (`standard`, `plan`, `auto-accept`; `bypass` maps to `auto-accept`) |
| `CMDC_MODE` | `agent` | Upstream generate mode (`agent`, `learning`, `custom-agent`, `custom-agent-create`, `title-gen`, `tool-desc`, `compact`, `vision`) |
| `CMDC_ZDR` | unset | Set to `1` to send `x-cmd-zdr` |

## Limitations

- Only Chat Completions, Responses, and Anthropic Messages are implemented. Embeddings, image generation, audio, and native provider routes are not exposed.
- Responses translation does not support `previous_response_id`, background tasks, hosted tools, or file inputs.
- Tool choice is expressed with a system instruction. `tool_choice: "none"` omits tools.
- Function, custom, and namespaced tools are supported. Hosted tools such as `web_search` are not exposed upstream.
- Reasoning effort is clamped to the selected model's supported values from the Command Code catalog.
- Plan access, credits, rate limits, and billing are enforced by the upstream service.
- This is an unofficial compatibility layer. The upstream CLI API may change.

## Security

- The server binds to `127.0.0.1` by default.
- Do not expose it publicly without adding authentication.
- Keep `~/.commandcode/auth.json` private. Never commit it or paste its contents into logs.
- Review the Command Code terms before using the subscription from other software.

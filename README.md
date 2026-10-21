<h1 align="center">Command Code Go Proxy</h1>

<p align="center">
  Use Command Code Go models from other software and agents<br>
  OpenAI Chat Completions · Streaming · Tool calls · Reasoning
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

If the preferred port is occupied or unavailable due to an OS exclusion/permission error, the proxy automatically tries the next ports (up to `PORT_ATTEMPTS`) and prints the actual listening address at startup.

Each request log includes a timestamp, status, model, stream mode, input/output/total tokens, cached and reasoning tokens, total elapsed time, first-token latency (TTFT), the observed generation window, and output tokens per second measured over that window.

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

## How It Works

- Reads the existing Command Code CLI login.
- Sends requests to `https://api.commandcode.ai/alpha/generate`.
- Adds the Command Code CLI request headers.
- Translates Command Code's newline-delimited event stream into OpenAI Chat Completions chunks and responses.
- Supports streaming and non-streaming requests, function tools, Codex custom tools, namespaced tools, reasoning content, and usage.
- Replays assistant reasoning on later turns and keeps a stable upstream thread per client conversation. A valid upstream `finish` stops reading immediately instead of waiting for the connection to close. Premature EOF is terminated with a valid client event, logged as an error, and followed by an upstream-thread rotation.
- If an attempt fails before producing any text, reasoning, or tool call, the proxy retries once on a new upstream thread. If both attempts are empty, the request fails with `502` instead of returning a successful empty completion.
- Applies `CMDC_STREAM_IDLE_TIMEOUT_MS` both while waiting for response headers and while reading a stream, so a stalled upstream cannot hold a request open indefinitely.
- Repairs incomplete tool-call history before forwarding: missing tool results are filled with an interrupted-result marker and orphan results are dropped. Consecutive user messages are forwarded unchanged.
- Preserves empty assistant turns as empty content by default, so role order and conversation boundaries stay intact without rewriting the prompt-cache prefix. Set `CMDC_EMPTY_ASSISTANT_PLACEHOLDER=1` only if an upstream compatibility workaround is required.
- Enforces an upstream transport size guard. By default, oversized requests are rejected with `context_length_exceeded`; history is never rewritten.

### Tool compatibility

The endpoint accepts standard Chat Completions function tools. It also accepts `custom` and `namespace` tool descriptors used by some Codex-compatible clients, flattening them into ordinary function tools upstream and returning standard `tool_calls` chunks. Freeform custom-tool input is carried in an `input` string argument.

Assistant reasoning is returned in the `reasoning_content` field when the upstream model emits it, so compatible clients can replay it on later turns.

### Thinking directives

Leading `/think` and `/no_think` directives in user messages are removed deterministically before forwarding. Only the latest user message controls the current request's reasoning effort; older user messages are stripped too, so the same conversation prefix does not change between turns. System/developer messages are never interpreted as control directives. The same control markers are stripped from the beginning of streamed reasoning/content, so they do not appear in the client UI.

The proxy rejects unsupported semantic Chat options with `unsupported_parameter` instead of silently ignoring them. `n` must be `1`; `logprobs`/`top_logprobs`, `seed`, and unknown `response_format` types are unsupported. `response_format: json_object`/`json_schema` and `parallel_tool_calls: false` are forwarded as best-effort system constraints because the Command Code API does not expose exact equivalents.

## Endpoints

| Endpoint | Description |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
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
| `PORT_ATTEMPTS` | `200` | Try up to this many consecutive ports when the preferred port is occupied or unavailable |
| `LOG_TIME_ZONE` | `Asia/Hong_Kong` | Time zone used for log timestamps |
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
| `CMDC_DEBUG` | unset | Set to `1` to write per-request JSONL diagnostics |
| `CMDC_DEBUG_DIR` | `<workdir>/.cmdc-debug` | Debug log directory; setting this variable also enables debug mode |
| `CMDC_STREAM_IDLE_TIMEOUT_MS` | `120000` | Maximum idle time while waiting for upstream headers or stream chunks; set to `0` to disable |
| `CMDC_EMPTY_ASSISTANT_PLACEHOLDER` | unset | Set to `1` to replace empty assistant history with a compatibility placeholder |
| `CMDC_CONTEXT_MODE` | `error` | `error` rejects oversized requests without changing history; `auto` trims old images above the size limit; `passthrough` disables the guard; `strip-images` always trims |
| `CMDC_MAX_REQUEST_BYTES` | `8388608` | Soft size threshold used by `auto` and `error` modes |
| `CMDC_HARD_REQUEST_BYTES` | `12582912` | Hard limit; larger requests are rejected with `context_length_exceeded` |

## Debugging

Enable debug mode before starting the proxy:

```powershell
$env:CMDC_DEBUG = "1"
npm start
```

Each request writes one JSONL file under `.cmdc-debug/` containing the client request, the converted upstream request, redacted request headers, upstream response status and headers, every raw upstream line with its timing, and the final usage/error result. The log path is printed as `debug log: ...`.

Set the `x-cmdc-debug: 1` request header to debug a single request without restarting the proxy. Authorization and API-key headers are redacted, but prompts, tool output, and model output are stored verbatim, so review debug logs before sharing them.

Conversation compaction remains the harness's responsibility. The default `error` mode never rewrites history, so it preserves upstream prompt-cache prefixes: the harness compacts at a deliberate boundary and subsequent append-only requests can reuse the cache. `auto` and `strip-images` are compatibility escape hatches; removing images from the middle of history invalidates the cache from the first changed image onward.

## Limitations

- Only OpenAI Chat Completions chat requests are implemented. Responses, Anthropic Messages, embeddings, image generation, audio, and native provider routes are not exposed. Unsupported Chat fields are rejected explicitly rather than silently degraded.
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

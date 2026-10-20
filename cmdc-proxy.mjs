#!/usr/bin/env node
/**
 * OpenAI-compatible local proxy for Command Code Go models.
 *
 * The Command Code CLI talks to its own streaming API at /alpha/generate.
 * This proxy translates OpenAI Chat Completions requests to that API, using
 * the existing Command Code login from ~/.commandcode/auth.json.
 *
 * Start:
 *   node cmdc-proxy.mjs
 *
 * Client:
 *   base_url = http://127.0.0.1:8787/v1
 *   api_key  = anything (the proxy uses the local Command Code login)
 */

import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import zlib from "node:zlib"

const CONFIGURED_PORT = Number(process.env.PORT ?? 8787)
const PORT = Number.isInteger(CONFIGURED_PORT) && CONFIGURED_PORT >= 0 ? CONFIGURED_PORT : 8787
const CONFIGURED_ATTEMPTS = Number(process.env.PORT_ATTEMPTS ?? 20)
const PORT_ATTEMPTS = Number.isFinite(CONFIGURED_ATTEMPTS) ? Math.max(1, Math.floor(CONFIGURED_ATTEMPTS)) : 20
const HOST = process.env.HOST ?? "127.0.0.1"
const BASE_URL = (process.env.CMDC_BASE_URL ?? "https://api.commandcode.ai").replace(/\/+$/, "")
const AUTH_PATH = process.env.CMDC_AUTH_PATH ?? path.join(os.homedir(), ".commandcode", "auth.json")
const CLI_VERSION = process.env.CMDC_CLI_VERSION ?? "1.84.0"
const CLI_ENVIRONMENT = process.env.CMDC_ENV ?? "production"
const WORKDIR = process.env.CMDC_WORKDIR ?? process.cwd()
const PROJECT_SLUG = process.env.CMDC_PROJECT_SLUG ?? slug(WORKDIR)
const PLAN = process.env.CMDC_PLAN ?? "individual-go"
const TASTE_LEARNING = process.env.CMDC_TASTE_LEARNING ?? "false"
const PERMISSION_MODES = new Set(["standard", "plan", "auto-accept"])
const PERMISSION_MODE =
  process.env.CMDC_PERMISSION_MODE === "bypass"
    ? "auto-accept"
    : PERMISSION_MODES.has(process.env.CMDC_PERMISSION_MODE)
      ? process.env.CMDC_PERMISSION_MODE
      : "standard"
const MODES = new Set([
  "agent",
  "learning",
  "custom-agent",
  "custom-agent-create",
  "title-gen",
  "tool-desc",
  "compact",
  "vision",
])
const MODE = MODES.has(process.env.CMDC_MODE) ? process.env.CMDC_MODE : "agent"
const DEFAULT_THREAD_ID = isUuid(process.env.CMDC_THREAD_ID) ? process.env.CMDC_THREAD_ID : undefined
const MAX_BODY_BYTES = 64 * 1024 * 1024
const REASONING_PREFIX = "cmdc1:"

const MODEL_ALIASES = {
  "deepseek-flash": "deepseek/deepseek-v4.1-flash",
  "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
  "deepseek-v4.1-flash-fast": "deepseek/deepseek-v4.1-flash-fast",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "deepseek-v4-flash-fast": "deepseek/deepseek-v4-flash-fast",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
}

const rotatedThreadIds = new Map()

function resolveThreadId(threadId) {
  return rotatedThreadIds.get(threadId) ?? threadId
}

function rotateThreadId(threadId) {
  if (!threadId) return
  const next = crypto.randomUUID()
  rotatedThreadIds.set(threadId, next)
  logWarn(`reset upstream thread ${threadId.slice(0, 8)} -> ${next.slice(0, 8)} after incomplete stream`)
}

const LOG_TIME_ZONE = process.env.LOG_TIME_ZONE ?? "Asia/Hong_Kong"
const LOG_TIME_FORMAT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: LOG_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
})
const DEBUG_ENABLED =
  ["1", "true", "yes", "on"].includes(String(process.env.CMDC_DEBUG ?? "").trim().toLowerCase()) ||
  Boolean(process.env.CMDC_DEBUG_DIR)
const DEBUG_DIR = path.resolve(process.env.CMDC_DEBUG_DIR ?? path.join(WORKDIR, ".cmdc-debug"))
const CONTEXT_MODES = new Set(["auto", "passthrough", "strip-images", "error"])
const CONTEXT_MODE = CONTEXT_MODES.has(process.env.CMDC_CONTEXT_MODE)
  ? process.env.CMDC_CONTEXT_MODE
  : "error"
const configuredMaxBytes = Number(process.env.CMDC_MAX_REQUEST_BYTES ?? 8 * 1024 * 1024)
const MAX_REQUEST_BYTES =
  Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
    ? Math.floor(configuredMaxBytes)
    : 8 * 1024 * 1024
const configuredHardBytes = Number(process.env.CMDC_HARD_REQUEST_BYTES ?? 12 * 1024 * 1024)
const HARD_REQUEST_BYTES =
  Number.isFinite(configuredHardBytes) && configuredHardBytes > 0
    ? Math.floor(configuredHardBytes)
    : 12 * 1024 * 1024

function logTimestamp() {
  return LOG_TIME_FORMAT.format(new Date()).replace(",", ".")
}

function logLine(level, message) {
  const line = `[${logTimestamp()}] [cmdc-proxy] ${message}`
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

function logInfo(message) {
  logLine("log", message)
}

function logWarn(message) {
  logLine("warn", message)
}

function logError(message) {
  logLine("error", message)
}

function redactedHeaders(headers) {
  const result = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    result[key] = ["authorization", "x-api-key", "cookie", "set-cookie"].includes(key.toLowerCase())
      ? "[redacted]"
      : value
  }
  return result
}

function createDebugLog(protocol, request) {
  const requested =
    DEBUG_ENABLED || String(request?.headers?.["x-cmdc-debug"] ?? "").trim() === "1"
  if (!requested) return null

  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true })
    const file = path.join(
      DEBUG_DIR,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${protocol}-${randomID()}.jsonl`,
    )
    const fd = fs.openSync(file, "a")
    let sequence = 0
    let closed = false
    const write = (type, data = {}) => {
      if (closed) return
      try {
        fs.writeSync(fd, `${JSON.stringify({ ts: new Date().toISOString(), seq: sequence++, type, ...data })}\n`)
      } catch (error) {
        logError(`debug write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    write("session_start", {
      protocol,
      pid: process.pid,
      upstream: BASE_URL,
      workdir: WORKDIR,
      request: { method: request.method, url: request.url },
      headers: redactedHeaders(request.headers),
    })
    logInfo(`debug log: ${file}`)
    return {
      file,
      write,
      close() {
        if (closed) return
        closed = true
        try {
          fs.closeSync(fd)
        } catch {
          // The debug file is diagnostic; closing must not affect the proxy.
        }
      },
    }
  } catch (error) {
    logError(`could not create debug log: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function finishDebug(debug, stats, extra = {}) {
  if (!debug) return
  debug.write("result", {
    status: stats?.status ?? null,
    usage: stats?.usage ?? null,
    error: stats?.error ?? null,
    elapsedMs: stats ? Math.max(0, Date.now() - stats.startedAt) : null,
    firstOutputAt: stats?.firstOutputAt ?? null,
    lastOutputAt: stats?.lastOutputAt ?? null,
    ...extra,
  })
  debug.write("session_end")
  debug.close()
}

function requestShape(body) {
  const params = body?.params ?? {}
  const messages = Array.isArray(params.messages) ? params.messages : []
  const roles = {}
  let toolCalls = 0
  let toolResults = 0
  for (const message of messages) {
    roles[message?.role ?? "unknown"] = (roles[message?.role ?? "unknown"] ?? 0) + 1
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === "tool-call") toolCalls += 1
      if (block?.type === "tool-result") toolResults += 1
    }
  }
  return {
    messages: messages.length,
    roles,
    toolCalls,
    toolResults,
    tools: Array.isArray(params.tools) ? params.tools.length : 0,
    maxTokens: params.max_tokens ?? null,
    chars: JSON.stringify(body ?? {}).length,
  }
}

function createRequestStats(protocol, model, stream) {
  return {
    protocol,
    model: String(model ?? "unknown"),
    stream,
    startedAt: Date.now(),
    firstOutputAt: null,
    lastOutputAt: null,
    status: null,
    usage: null,
    error: null,
  }
}

function markOutput(stats) {
  if (!stats) return
  const now = Date.now()
  if (stats.firstOutputAt === null) stats.firstOutputAt = now
  stats.lastOutputAt = now
}

function usageSnapshot(usage) {
  if (!usage) return undefined
  const input = usage.inputTokens ?? usage.prompt_tokens ?? 0
  const output = usage.outputTokens ?? usage.completion_tokens ?? 0
  return {
    input,
    output,
    total: usage.totalTokens ?? usage.total_tokens ?? input + output,
    cached:
      usage.inputTokenDetails?.cacheReadTokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.cache_read_input_tokens ??
      0,
    reasoning:
      usage.outputTokenDetails?.reasoningTokens ??
      usage.completion_tokens_details?.reasoning_tokens ??
      0,
  }
}

function formatDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

function logRequest(stats) {
  const elapsedMs = Math.max(0, Date.now() - stats.startedAt)
  const usage = usageSnapshot(stats.usage)
  const tokens = usage
    ? `tokens=${usage.input}/${usage.output}/${usage.total} cached=${usage.cached} reasoning=${usage.reasoning}`
    : "tokens=unknown"
  const ttftMs = stats.firstOutputAt === null ? null : Math.max(0, stats.firstOutputAt - stats.startedAt)
  const generationMs =
    stats.firstOutputAt === null || stats.lastOutputAt === null
      ? null
      : Math.max(0, stats.lastOutputAt - stats.firstOutputAt)
  // Token speed uses the observed generation window; total latency includes queueing and TTFT.
  const speedWindowMs = generationMs !== null && generationMs > 0 ? generationMs : elapsedMs
  const speed = usage && usage.output > 0 && speedWindowMs > 0
    ? (usage.output / (speedWindowMs / 1000)).toFixed(1)
    : "0.0"
  const ttft = ttftMs === null ? "" : ` ttft=${formatDuration(ttftMs)}`
  const generation = generationMs !== null && generationMs > 0 ? ` gen=${formatDuration(generationMs)}` : ""
  const status = stats.status ? `${stats.status} ` : ""
  const errorText =
    stats.error && typeof stats.error === "object"
      ? (stats.error.message ?? JSON.stringify(stats.error))
      : stats.error
  const error = errorText ? ` error=${String(errorText).slice(0, 200)}` : ""
  logLine(
    stats.error ? "error" : "log",
    `${status}${stats.protocol} model=${stats.model} stream=${stats.stream} ${tokens} elapsed=${formatDuration(elapsedMs)}${ttft}${generation} speed=${speed}tok/s${error}`,
  )
}

const PLAN_RANK = {
  "individual-go": 1,
  "individual-go-v1": 1,
  "individual-goat": 2,
  "individual-pro": 3,
  "individual-pro-v1": 3,
  "individual-provider": 3,
  "individual-max": 4,
  "individual-ultra": 5,
  "teams-pro": 3,
}

let catalogCache
let catalogCacheAt = 0

class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

function handleRequest(request, response) {
  handle(request, response).catch((error) => {
    if (error?.name === "AbortError") return
    const status = typeof error?.status === "number" ? error.status : 500
    logError(error instanceof Error ? error.message : String(error))
    if (!response.headersSent) {
      json(response, status, {
        error: {
          type: error?.code === "context_length_exceeded" ? "invalid_request_error" : "proxy_error",
          message: error instanceof Error ? error.message : String(error),
          ...(error?.code ? { code: error.code } : {}),
        },
      })
      return
    }
    response.end()
  })
}

startServer()

function startServer(attempt = 0) {
  const port = PORT === 0 ? 0 : PORT + attempt
  const server = http.createServer(handleRequest)
  const onListenError = (error) => {
    const canRetry =
      error?.code === "EADDRINUSE" &&
      PORT !== 0 &&
      attempt + 1 < PORT_ATTEMPTS &&
      PORT + attempt + 1 <= 65535
    if (canRetry) {
      logWarn(`port ${port} is in use, trying ${PORT + attempt + 1}`)
      setImmediate(() => startServer(attempt + 1))
      return
    }
    logError(`failed to listen on ${HOST}:${port}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
  server.once("error", onListenError)
  server.listen(port, HOST, () => {
    server.off("error", onListenError)
    server.on("error", (error) => {
      logError(`server error: ${error instanceof Error ? error.message : String(error)}`)
    })
    const address = server.address()
    const actualPort = typeof address === "object" && address ? address.port : port
    logInfo(`listening on http://${HOST}:${actualPort}/v1`)
    logInfo(`upstream ${BASE_URL}`)
    logInfo(`plan ${PLAN}`)
    logInfo(`workdir ${WORKDIR}`)
    logInfo(`debug ${DEBUG_ENABLED ? DEBUG_DIR : "off"}`)
    logInfo(`context ${CONTEXT_MODE} soft=${MAX_REQUEST_BYTES} hard=${HARD_REQUEST_BYTES}`)
  })
}

async function handle(request, response) {
  setCors(response)
  if (request.method === "OPTIONS") {
    response.writeHead(204)
    response.end()
    return
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
    json(response, 200, {
      ok: true,
      upstream: BASE_URL,
      plan: PLAN,
      auth: authStatus(),
      workdir: WORKDIR,
    })
    return
  }

  if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    await proxyModels(response)
    return
  }

  if (request.method === "GET" && (url.pathname === "/v1/usage" || url.pathname === "/usage")) {
    await proxyUsage(response, url.searchParams)
    return
  }

  if (request.method === "GET" && url.pathname.startsWith("/v1/usage/")) {
    await proxyUsageDetail(response, url.pathname.slice("/v1/usage/".length), url.searchParams)
    return
  }

  if (request.method === "GET" && url.pathname.startsWith("/usage/")) {
    await proxyUsageDetail(response, url.pathname.slice("/usage/".length), url.searchParams)
    return
  }

  if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    await proxyChat(request, response)
    return
  }

  if (request.method === "POST" && url.pathname.endsWith("/messages")) {
    await proxyAnthropic(request, response)
    return
  }

  if (request.method === "POST" && url.pathname.endsWith("/responses")) {
    await proxyResponses(request, response)
    return
  }

  json(response, 404, {
    error: {
      type: "not_found",
      message: "Use /v1/chat/completions, /v1/responses, /v1/messages, /v1/models, /v1/usage or /health",
    },
  })
}

async function proxyChat(request, response) {
  const input = parseBody(await readBody(request))
  if (!input) throw new HttpError(400, "Request body must be a JSON object")
  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    throw new HttpError(400, "model is required")
  }
  if (!Array.isArray(input.messages)) {
    throw new HttpError(400, "messages must be an array")
  }

  const wantsStream = input.stream === true
  const model = await resolveModel(input.model)
  const clientThreadId = threadIdFrom(request.headers, input)
  const threadId = resolveThreadId(clientThreadId)
  const stats = createRequestStats("chat", model, wantsStream)
  const debug = createDebugLog("chat", request)
  stats.debug = debug
  if (debug) response.on("close", () => setImmediate(() => finishDebug(debug, stats)))
  const controller = new AbortController()
  response.on("close", () => controller.abort())
  const converted = openAIToCommandCode({ ...input, model })
  const headers = buildHeaders(threadId)
  const upstreamBody = buildGenerateBody(converted, threadId)
  const context = applyContextGuard(upstreamBody)
  debug?.write("client_request", { protocol: "chat", headers: redactedHeaders(request.headers), body: input })
  debug?.write("upstream_request", { threadId, headers: redactedHeaders(headers), body: upstreamBody, context })

  const upstream = await fetch(`${BASE_URL}/alpha/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
    signal: controller.signal,
  }).catch((error) => {
    debug?.write("fetch_error", { message: error instanceof Error ? error.message : String(error) })
    return { error }
  })

  if (!("error" in upstream)) {
    debug?.write("upstream_response", {
      status: upstream.status,
      headers: redactedHeaders(Object.fromEntries(upstream.headers)),
    })
  }

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      stats.error = "aborted"
      logRequest(stats)
      response.end()
      return
    }
    stats.error = upstream.error instanceof Error ? upstream.error.message : String(upstream.error)
    logRequest(stats)
    throw new HttpError(502, upstream.error instanceof Error ? upstream.error.message : String(upstream.error))
  }

  stats.status = upstream.status
  if (!upstream.ok) {
    const text = await upstream.text()
    const parsed = parseJson(text)
    const message =
      ((typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message) ??
        parsed?.message ??
        text) ||
      `Command Code request failed (${upstream.status})`
    stats.error = message
    logRequest(stats)
    json(response, upstream.status, {
      error: {
        type: parsed?.error?.type ?? "upstream_error",
        message,
        ...(parsed?.error?.code ? { code: parsed.error.code } : {}),
      },
    })
    return
  }

  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    try {
      const result = await streamOpenAI(upstream, response, {
        model,
        includeUsage: input.stream_options?.include_usage === true,
        toolRegistry: converted.toolRegistry,
        stats,
      })
      stats.usage = result?.usage
      stats.error = result?.error
      logRequest(stats)
      if (!result?.finished || result?.error) {
        logWarn(`request shape: ${JSON.stringify(requestShape(upstreamBody))}`)
        rotateThreadId(clientThreadId)
      }
    } catch (error) {
      logWarn(`request shape: ${JSON.stringify(requestShape(upstreamBody))}`)
      rotateThreadId(clientThreadId)
      stats.error = error?.name === "AbortError" ? "aborted" : error instanceof Error ? error.message : String(error)
      logRequest(stats)
      if (error?.name !== "AbortError") throw error
    }
    return
  }

  try {
    const result = await collectOpenAI(upstream, model, converted.toolRegistry, stats)
    stats.usage = result.usage
    logRequest(stats)
    json(response, 200, result)
  } catch (error) {
    logWarn(`request shape: ${JSON.stringify(requestShape(upstreamBody))}`)
    rotateThreadId(clientThreadId)
    stats.error = error instanceof Error ? error.message : String(error)
    logRequest(stats)
    throw error
  }
}

async function proxyAnthropic(request, response) {
  const input = parseBody(await readBody(request))
  if (!input) throw new HttpError(400, "Request body must be a JSON object")
  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    throw new HttpError(400, "model is required")
  }
  if (!Array.isArray(input.messages)) {
    throw new HttpError(400, "messages must be an array")
  }
  const model = await resolveModel(input.model)
  const converted = anthropicToCommandCode({ ...input, model })
  await runCommandCode(
    request,
    response,
    converted,
    "anthropic",
    model,
    input.stream === true,
    converted.toolRegistry,
    input,
  )
}

async function proxyResponses(request, response) {
  const input = parseBody(await readBody(request))
  if (!input) throw new HttpError(400, "Request body must be a JSON object")
  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    throw new HttpError(400, "model is required")
  }
  if (typeof input.input !== "string" && !Array.isArray(input.input)) {
    throw new HttpError(400, "input must be a string or an array")
  }
  const model = await resolveModel(input.model)
  const converted = responsesToCommandCode({ ...input, model })
  await runCommandCode(
    request,
    response,
    converted,
    "responses",
    model,
    input.stream === true,
    converted.toolRegistry,
    input,
  )
}

async function runCommandCode(request, response, input, protocol, model, wantsStream, toolRegistry, requestInput) {
  const clientThreadId = threadIdFrom(request.headers, requestInput)
  const threadId = resolveThreadId(clientThreadId)
  const stats = createRequestStats(protocol, model, wantsStream)
  const debug = createDebugLog(protocol, request)
  stats.debug = debug
  if (debug) response.on("close", () => setImmediate(() => finishDebug(debug, stats)))
  const controller = new AbortController()
  response.on("close", () => controller.abort())
  const headers = buildHeaders(threadId)
  const upstreamBody = buildGenerateBody(input, threadId)
  const context = applyContextGuard(upstreamBody)
  debug?.write("client_request", { protocol, headers: redactedHeaders(request.headers), body: requestInput })
  debug?.write("upstream_request", { threadId, headers: redactedHeaders(headers), body: upstreamBody, context })

  const upstream = await fetch(`${BASE_URL}/alpha/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
    signal: controller.signal,
  }).catch((error) => {
    debug?.write("fetch_error", { message: error instanceof Error ? error.message : String(error) })
    return { error }
  })

  if (!("error" in upstream)) {
    debug?.write("upstream_response", {
      status: upstream.status,
      headers: redactedHeaders(Object.fromEntries(upstream.headers)),
    })
  }

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      stats.error = "aborted"
      logRequest(stats)
      response.end()
      return
    }
    stats.error = upstream.error instanceof Error ? upstream.error.message : String(upstream.error)
    logRequest(stats)
    throw new HttpError(502, upstream.error instanceof Error ? upstream.error.message : String(upstream.error))
  }

  stats.status = upstream.status
  if (!upstream.ok) {
    const text = await upstream.text()
    const parsed = parseJson(text)
    const message =
      ((typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message) ??
        parsed?.message ??
        text) ||
      "Command Code returned an error"
    stats.error = message
    logRequest(stats)
    if (protocol === "anthropic") {
      json(response, upstream.status, { type: "error", error: { type: "proxy_error", message } })
    } else {
      json(response, upstream.status, { error: { type: "upstream_error", message } })
    }
    return
  }

  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    try {
      const result =
        protocol === "anthropic"
          ? await streamAnthropic(upstream, response, model, toolRegistry, stats)
          : await streamResponses(upstream, response, model, toolRegistry, stats)
      stats.usage = result?.usage
      stats.error = result?.error
      logRequest(stats)
      if (!result?.finished || result?.error) {
        logWarn(`request shape: ${JSON.stringify(requestShape(upstreamBody))}`)
        rotateThreadId(clientThreadId)
      }
    } catch (error) {
      logWarn(`request shape: ${JSON.stringify(requestShape(upstreamBody))}`)
      rotateThreadId(clientThreadId)
      stats.error = error?.name === "AbortError" ? "aborted" : error instanceof Error ? error.message : String(error)
      logRequest(stats)
      if (error?.name !== "AbortError") throw error
    }
    return
  }

  try {
    const result = await collectCommandCode(upstream, stats)
    if (result.error) {
      stats.error = result.error
      logRequest(stats)
      throw new HttpError(errorStatus(result.error), result.error)
    }
    stats.usage = result.usage
    logRequest(stats)
    if (protocol === "anthropic") json(response, 200, commandCodeToAnthropic(result, model, toolRegistry))
    else json(response, 200, commandCodeToResponses(result, model, toolRegistry))
  } catch (error) {
    logWarn(`request shape: ${JSON.stringify(requestShape(upstreamBody))}`)
    rotateThreadId(clientThreadId)
    if (!stats.error) {
      stats.error = error instanceof Error ? error.message : String(error)
      logRequest(stats)
    }
    throw error
  }
}

function repairToolCallHistory(messages) {
  const repaired = []
  const pending = new Map()
  const synthesized = []
  const dropped = []

  const flushPending = () => {
    for (const [id, name] of pending) {
      repaired.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName: name,
            output: { type: "text", value: "Tool execution was interrupted before a result was returned." },
          },
        ],
      })
      synthesized.push(id)
    }
    pending.clear()
  }

  for (const [messageIndex, message] of messages.entries()) {
    if (!message || typeof message !== "object") continue
    if (message.role === "assistant") {
      flushPending()
      for (const [blockIndex, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
        if (block?.type !== "tool-call") continue
        const id = block.toolCallId || `call_${messageIndex}_${blockIndex}`
        block.toolCallId = id
        pending.set(id, block.toolName || "unknown")
      }
      repaired.push(message)
      continue
    }
    if (message.role === "tool") {
      const matched = []
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type !== "tool-result" || !block.toolCallId || !pending.has(block.toolCallId)) {
          dropped.push(block?.toolCallId || "(missing id)")
          continue
        }
        pending.delete(block.toolCallId)
        matched.push(block)
      }
      if (matched.length > 0) repaired.push({ role: "tool", content: matched })
      continue
    }
    flushPending()
    repaired.push(message)
  }
  flushPending()

  if (synthesized.length > 0 || dropped.length > 0) {
    logWarn(`repaired tool history: synthesized=${synthesized.length} dropped=${dropped.length}`)
    if (DEBUG_ENABLED) {
      logInfo(`tool history detail: synthesized=[${synthesized.join(",")}] dropped=[${dropped.join(",")}]`)
    }
  }
  return repaired
}

function stripHistoricalImages(messages) {
  let lastUserIndex = -1
  for (const [index, message] of messages.entries()) {
    if (message?.role === "user") lastUserIndex = index
  }

  let removed = 0
  let removedChars = 0
  for (const [index, message] of messages.entries()) {
    if (index === lastUserIndex || !Array.isArray(message?.content)) continue
    message.content = message.content.map((block) => {
      if (block?.type !== "image") return block
      removed += 1
      removedChars += JSON.stringify(block).length
      return { type: "text", text: "[image omitted from earlier history]" }
    })
  }
  return { removed, removedChars }
}

function applyContextGuard(body) {
  const before = Buffer.byteLength(JSON.stringify(body))
  if (CONTEXT_MODE === "passthrough") return { before, after: before, removed: 0, removedChars: 0 }
  if (CONTEXT_MODE === "error" && before > MAX_REQUEST_BYTES) {
    throw new HttpError(
      400,
      `Request is ${before} bytes, above CMDC_MAX_REQUEST_BYTES (${MAX_REQUEST_BYTES}); compact the conversation and retry.`,
      "context_length_exceeded",
    )
  }

  const shouldStrip =
    CONTEXT_MODE === "strip-images" || (CONTEXT_MODE === "auto" && before > MAX_REQUEST_BYTES)
  const stripped = shouldStrip && Array.isArray(body?.params?.messages)
    ? stripHistoricalImages(body.params.messages)
    : { removed: 0, removedChars: 0 }
  const after = Buffer.byteLength(JSON.stringify(body))

  if (after > HARD_REQUEST_BYTES) {
    throw new HttpError(
      400,
      `Request is still ${after} bytes after context guard (hard limit ${HARD_REQUEST_BYTES}); compact the conversation and retry.`,
      "context_length_exceeded",
    )
  }
  if (stripped.removed > 0) {
    logWarn(
      `context guard: ${before} -> ${after} bytes, stripped ${stripped.removed} historical image(s), ~${stripped.removedChars} chars`,
    )
    logWarn("context guard: rewriting historical images can invalidate the upstream prompt cache")
  } else if (before > MAX_REQUEST_BYTES) {
    logWarn(`context guard: request is ${before} bytes and no historical images were removed`)
  }
  return { before, after, ...stripped }
}

function anthropicToCommandCode(input) {
  const system = []
  let directiveEffort
  const systemText = readThinkDirective(anthropicText(input.system), (effort) => (directiveEffort = effort))
  if (systemText) system.push({ type: "text", text: systemText })
  const messages = []
  const toolNames = new Map()
  const toolRegistry = buildToolRegistry(input.tools)
  const source = Array.isArray(input.messages) ? input.messages : []
  const lastUserIndex = lastMessageIndex(source, "user")

  for (const [messageIndex, message] of source.entries()) {
    if (!message || typeof message !== "object") continue
    if (message.role === "assistant") {
      const content = []
      for (const [blockIndex, block] of anthropicBlocks(message.content).entries()) {
        if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text })
        if (block.type === "thinking" && typeof block.thinking === "string") {
          content.push({ type: "reasoning", text: stripThinkControl(block.thinking) })
        }
        if (block.type === "redacted_thinking") content.push({ type: "reasoning", text: "" })
        if (block.type === "tool_use") {
          const id = block.id ?? `call_${messageIndex}_${blockIndex}`
          const name = block.name ?? ""
          const upstreamName = resolveToolName(toolRegistry, name) || "unknown"
          toolNames.set(id, upstreamName)
          content.push({
            type: "tool-call",
            toolCallId: id,
            toolName: upstreamName,
            input: parseToolArguments(block.input),
          })
        }
      }
      messages.push(
        content.length > 0
          ? { role: "assistant", content }
          : { role: "assistant", content: [{ type: "text", text: "(previous assistant response was empty)" }] },
      )
      continue
    }

    const parts = []
    let directiveApplied = false
    const flush = () => {
      if (parts.length === 0) return
      messages.push({ role: "user", content: parts.splice(0) })
    }
    for (const block of anthropicBlocks(message.content)) {
      if (block.type === "tool_result") {
        flush()
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: block.tool_use_id ?? "",
              toolName: toolNames.get(block.tool_use_id) ?? "unknown",
              output: { type: "text", value: anthropicText(block.content) },
            },
          ],
        })
        continue
      }
      if (block.type === "text" && typeof block.text === "string") {
        const text =
          messageIndex === lastUserIndex && !directiveApplied
            ? readThinkDirective(block.text, (effort) => (directiveEffort = effort))
            : block.text
        directiveApplied = true
        if (text) parts.push({ type: "text", text })
        continue
      }
      if (block.type === "image") {
        const url = anthropicImageUrl(block)
        if (url) parts.push({ type: "image", image: url, mimeType: mimeTypeOf(url) })
      }
    }
    flush()
  }

  if (system.length === 0) system.push({ type: "text", text: "You are a helpful assistant." })

  let tools = toolRegistry.tools

  const choice = input.tool_choice
  if (choice?.type === "none") tools = []
  else if (choice?.type === "any") {
    system.push({ type: "text", text: "You must call one of the provided tools for this request." })
  } else if (choice?.type === "tool" && choice.name) {
    system.push({
      type: "text",
      text: `You must call the tool "${resolveToolName(toolRegistry, choice.name)}" for this request.`,
    })
  }

  const maxTokens = Number(input.max_tokens)
  return {
    model: input.model,
    system,
    messages: repairToolCallHistory(messages),
    tools,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(64000, Math.floor(maxTokens)) : 64000,
    temperature: typeof input.temperature === "number" ? input.temperature : undefined,
    topP: typeof input.top_p === "number" ? input.top_p : undefined,
    stop: input.stop_sequences,
    reasoningEffort:
      directiveEffort ??
      (input.thinking?.type === "enabled" ? "high" : input.thinking?.type === "disabled" ? "off" : undefined),
    toolRegistry,
  }
}

function responsesToCommandCode(input) {
  const system = []
  if (typeof input.instructions === "string" && input.instructions.trim()) {
    system.push({ type: "text", text: input.instructions })
  }
  const messages = []
  const toolRegistry = buildToolRegistry(input.tools)
  const callNames = new Map()
  const source =
    typeof input.input === "string"
      ? [{ type: "message", role: "user", content: input.input }]
      : Array.isArray(input.input)
        ? input.input
        : []
  const lastUserIndex = lastMessageIndex(source, "user")
  let pendingReasoning = ""
  let pendingReasoningSeen = false
  let directiveEffort

  const takeReasoning = () => {
    if (!pendingReasoningSeen) return undefined
    const reasoning = { type: "reasoning", text: pendingReasoning }
    pendingReasoning = ""
    pendingReasoningSeen = false
    return reasoning
  }

  for (const [itemIndex, item] of source.entries()) {
    if (typeof item === "string") {
      const text = itemIndex === lastUserIndex ? readThinkDirective(item, (effort) => (directiveEffort = effort)) : item
      if (text) messages.push({ role: "user", content: [{ type: "text", text }] })
      continue
    }
    if (!item || typeof item !== "object") continue

    if (item.type === "reasoning") {
      pendingReasoning += stripThinkControl(decodeReasoning(item.encrypted_content) ?? reasoningTextFromItem(item))
      pendingReasoningSeen = true
      continue
    }

    if (item.type === "message") {
      const role = item.role ?? "user"
      const content = responsesContentToCommandCode(item.content)
      if (role === "system" || role === "developer") {
        system.push(
          ...content.flatMap((part, index) => {
            if (part.type !== "text") return [part]
            const text =
              index === 0 ? readThinkDirective(part.text, (effort) => (directiveEffort = effort)) : part.text
            return text ? [{ ...part, text }] : []
          }),
        )
        continue
      }
      if (role === "assistant") {
        const reasoning = takeReasoning()
        const parts = reasoning ? [reasoning, ...content] : content
        messages.push(
          parts.length > 0
            ? { role: "assistant", content: parts }
            : { role: "assistant", content: [{ type: "text", text: "(previous assistant response was empty)" }] },
        )
        continue
      }
      const reasoning = takeReasoning()
      if (reasoning) messages.push({ role: "assistant", content: [reasoning] })
      if (itemIndex === lastUserIndex) {
        const parts = stripThinkFromParts(content, (effort) => (directiveEffort = effort))
        if (parts.length > 0) messages.push({ role: "user", content: parts })
        continue
      }
      if (content.length > 0) messages.push({ role: "user", content })
      continue
    }

    if (item.type === "function_call") {
      const id = item.call_id ?? item.id ?? `call_${itemIndex}`
      const toolName = resolveToolName(toolRegistry, item.name ?? "", item.namespace) || "unknown"
      callNames.set(id, toolName)
      const reasoning = takeReasoning()
      messages.push({
        role: "assistant",
        content: [
          ...(reasoning ? [reasoning] : []),
          {
            type: "tool-call",
            toolCallId: id,
            toolName,
            input: parseToolArguments(item.arguments),
          },
        ],
      })
      continue
    }

    if (item.type === "custom_tool_call") {
      const id = item.call_id ?? item.id ?? `call_${itemIndex}`
      const toolName = resolveToolName(toolRegistry, item.name ?? "", item.namespace) || "unknown"
      callNames.set(id, toolName)
      const reasoning = takeReasoning()
      messages.push({
        role: "assistant",
        content: [
          ...(reasoning ? [reasoning] : []),
          {
            type: "tool-call",
            toolCallId: id,
            toolName,
            input: { input: customToolInput(item.input) },
          },
        ],
      })
      continue
    }

    if (
      item.type === "function_call_output" ||
      item.type === "custom_tool_call_output" ||
      item.type === "tool_result"
    ) {
      const id = item.call_id ?? item.tool_use_id ?? item.id ?? ""
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName:
              (callNames.get(id) ?? (item.name ? resolveToolName(toolRegistry, item.name, item.namespace) : "")) ||
              "unknown",
            output: { type: "text", value: outputText(item.output) },
          },
        ],
      })
    }
  }

  const trailingReasoning = takeReasoning()
  if (trailingReasoning) messages.push({ role: "assistant", content: [trailingReasoning] })
  if (system.length === 0) system.push({ type: "text", text: "You are a helpful assistant." })

  let tools = toolRegistry.tools

  const choice = input.tool_choice
  if (choice === "none") tools = []
  else if (choice === "required") {
    system.push({ type: "text", text: "You must call one of the provided tools for this request." })
  } else if (
    choice &&
    typeof choice === "object" &&
    (choice.type === "function" || choice.type === "custom") &&
    choice.name
  ) {
    system.push({
      type: "text",
      text: `You must call the tool "${resolveToolName(toolRegistry, choice.name, choice.namespace)}" for this request.`,
    })
  } else if (
    choice &&
    typeof choice === "object" &&
    choice.type === "allowed_tools" &&
    Array.isArray(choice.tools)
  ) {
    const allowed = new Set(
      choice.tools.map((tool) => resolveToolName(toolRegistry, tool.name, tool.namespace)),
    )
    tools = tools.filter((tool) => allowed.has(tool.name))
    if (choice.mode === "required") {
      system.push({ type: "text", text: "You must call one of the provided tools for this request." })
    }
  }

  const maxTokens = Number(input.max_output_tokens)
  return {
    model: input.model,
    system,
    messages: repairToolCallHistory(messages),
    tools,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(64000, Math.floor(maxTokens)) : 64000,
    temperature: typeof input.temperature === "number" ? input.temperature : undefined,
    topP: typeof input.top_p === "number" ? input.top_p : undefined,
    reasoningEffort: directiveEffort ?? normalizeReasoningEffort(input.reasoning?.effort, input.model),
    toolRegistry,
  }
}

function buildToolRegistry(tools) {
  const registry = {
    tools: [],
    byName: new Map(),
    byClient: new Map(),
    bySimpleName: new Map(),
  }
  const used = new Set()

  const add = (descriptor) => {
    const base = sanitizeToolName(descriptor.upstreamName) || "tool"
    let name = base
    let suffix = 2
    while (used.has(name)) name = `${base}_${suffix++}`
    used.add(name)
    const entry = { ...descriptor, upstreamName: name }
    registry.tools.push({
      name,
      description: entry.description ?? "",
      input_schema: entry.input_schema,
    })
    registry.byName.set(name, entry)
    for (const clientName of entry.clientNames ?? []) registry.byClient.set(clientName, name)
    const simple = registry.bySimpleName.get(entry.name) ?? []
    if (!simple.includes(name)) simple.push(name)
    registry.bySimpleName.set(entry.name, simple)
    return name
  }

  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== "object") continue

    if (tool.type === "namespace") {
      const namespace = tool.name
      if (!namespace) continue
      for (const nested of Array.isArray(tool.tools) ? tool.tools : []) {
        if (!nested || typeof nested !== "object") continue
        const description = [tool.description ? `[${namespace}] ${tool.description}` : `[${namespace}]`, nested.description]
          .filter(Boolean)
          .join("\n\n")
        if (nested.type === "custom") {
          add(customToolDescriptor(nested, namespace, description))
          continue
        }
        if (nested.type === "function" && nested.name) {
          add({
            kind: "function",
            name: nested.name,
            namespace,
            upstreamName: `${namespace}__${nested.name}`,
            description,
            input_schema: normalizeInputSchema(nested.parameters),
            clientNames: [`${namespace}__${nested.name}`, `${namespace}.${nested.name}`],
          })
        }
      }
      continue
    }

    if (tool.type === "custom" && tool.name) {
      add(customToolDescriptor(tool))
      continue
    }

    const functionSpec = tool.type === "function" ? tool : tool.type === undefined ? tool : undefined
    if (!functionSpec) continue
    const name = functionSpec.name ?? functionSpec.function?.name
    if (!name) continue
    add({
      kind: "function",
      name,
      namespace: tool.namespace ?? null,
      upstreamName: tool.namespace ? `${tool.namespace}__${name}` : name,
      description: functionSpec.description ?? functionSpec.function?.description ?? "",
      input_schema: normalizeInputSchema(functionSpec.parameters ?? functionSpec.function?.parameters ?? functionSpec.input_schema),
      clientNames: tool.namespace
        ? [`${tool.namespace}__${name}`, `${tool.namespace}.${name}`]
        : [name],
    })
  }

  return registry
}

function customToolDescriptor(tool, namespace, description) {
  const prefix = namespace ? `[${namespace}] ` : ""
  const base = description ?? `${prefix}${tool.description ?? ""}`
  return {
    kind: "custom",
    name: tool.name,
    namespace: namespace ?? null,
    upstreamName: namespace ? `${namespace}__${tool.name}` : tool.name,
    description: `${base}\n\nThe function-calling API requires a JSON object, but the "input" field itself is the exact freeform text. Put the complete raw input there without escaping, quoting, or JSON-encoding that value.`,
    input_schema: {
      type: "object",
      properties: {
        input: { type: "string", description: "The complete raw tool input." },
      },
      required: ["input"],
      additionalProperties: false,
    },
    clientNames: namespace ? [`${namespace}__${tool.name}`, `${namespace}.${tool.name}`] : [tool.name],
  }
}

function normalizeInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} }
  }
  return {
    ...schema,
    type: "object",
    properties: schema.properties ?? {},
    ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
  }
}

function sanitizeToolName(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
}

function resolveToolName(registry, name, namespace) {
  const raw = String(name ?? "")
  if (namespace) {
    const qualified = registry.byClient.get(`${namespace}__${raw}`) ?? registry.byClient.get(`${namespace}.${raw}`)
    if (qualified) return qualified
  }
  const direct = registry.byClient.get(raw)
  if (direct) return direct
  const simple = registry.bySimpleName.get(raw)
  if (simple?.length === 1) return simple[0]
  return sanitizeToolName(raw)
}

function customToolInput(value) {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    if (typeof value.input === "string") return value.input
    if (typeof value.patch === "string") return value.patch
    if (typeof value.content === "string") return value.content
    const strings = Object.values(value).filter((entry) => typeof entry === "string")
    if (strings.length === 1) return strings[0]
  }
  return JSON.stringify(value ?? "")
}

function coerceToolInput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value
  if (Array.isArray(value) && value.length === 1 && value[0] && typeof value[0] === "object") return value[0]
  if (typeof value === "string" && value.trim()) return parseJson(value) ?? { input: value }
  return {}
}

function parseToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value
  if (typeof value === "string" && value.trim()) return parseJson(value) ?? {}
  return {}
}

function reasoningTextFromItem(item) {
  return [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]
    .flatMap((part) => (typeof part?.text === "string" ? [part.text] : []))
    .join("")
}

function encodeReasoning(text) {
  if (!text) return undefined
  return REASONING_PREFIX + zlib.gzipSync(Buffer.from(text, "utf8")).toString("base64url")
}

function decodeReasoning(value) {
  if (typeof value !== "string" || !value.startsWith(REASONING_PREFIX)) return undefined
  try {
    return zlib.gunzipSync(Buffer.from(value.slice(REASONING_PREFIX.length), "base64url")).toString("utf8")
  } catch {
    return undefined
  }
}

function lastMessageIndex(messages, role) {
  let index = -1
  for (const [current, message] of messages.entries()) {
    if (typeof message === "string") {
      if (role === "user") index = current
      continue
    }
    if (message?.role === role) index = current
  }
  return index
}

function readThinkDirective(text, onEffort) {
  const match = /^\s*\/(no_think|think)(?=\s|$)[ \t]*/i.exec(text)
  if (!match) return text
  onEffort?.(match[1].toLowerCase() === "no_think" ? "off" : "high")
  return text.slice(match[0].length)
}

function stripThinkControl(text) {
  return String(text ?? "").replace(/^\s*\/(?:no_think|think)(?=$|\s|[.,;:!?])\s*/i, "")
}

function stripThinkFromParts(parts, onEffort) {
  let applied = false
  return parts.flatMap((part) => {
    if (part.type !== "text" || applied) return [part]
    applied = true
    const text = readThinkDirective(part.text, onEffort)
    return text ? [{ ...part, text }] : []
  })
}

function outputText(value) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .flatMap((part) => {
        if (typeof part === "string") return [part]
        if (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text") {
          return typeof part.text === "string" ? [part.text] : []
        }
        if (part?.type === "input_image" || part?.type === "image_url") return ["[image]"]
        return []
      })
      .join("\n")
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text
    if (typeof value.content === "string") return value.content
    return JSON.stringify(value)
  }
  return String(value ?? "")
}

class ControlTextFilter {
  constructor() {
    this.buffer = ""
    this.ready = false
    this.trimLeading = false
  }

  push(text) {
    if (typeof text !== "string" || text.length === 0) return ""
    if (this.trimLeading) {
      const trimmed = text.replace(/^\s+/, "")
      if (!trimmed) return ""
      this.trimLeading = false
      text = trimmed
    }
    if (this.ready) return text
    this.buffer += text
    const trimmed = this.buffer.replace(/^\s+/, "")
    const marker = /^(\/no_think|\/think)(?=$|\s|[.,;:!?])/i.exec(trimmed)
    if (marker) {
      this.ready = true
      this.buffer = ""
      const output = trimmed.slice(marker[0].length).replace(/^\s+/, "")
      this.trimLeading = output.length === 0
      return output
    }
    if (trimmed.startsWith("/") && trimmed.length < 12) return ""
    this.ready = true
    const output = this.buffer
    this.buffer = ""
    return output
  }

  flush() {
    if (this.ready) return ""
    this.ready = true
    const output = this.buffer
    this.buffer = ""
    return output.replace(/^\s*\/(?:no_think|think)(?=$|\s|[.,;:!?])\s*/i, "")
  }

  reset() {
    this.buffer = ""
    this.ready = false
    this.trimLeading = false
  }
}

function anthropicBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (Array.isArray(content)) return content.filter((block) => block && typeof block === "object")
  return []
}

function anthropicText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((block) => {
      if (typeof block === "string") return [block]
      if (block?.type === "text" && typeof block.text === "string") return [block.text]
      return []
    })
    .join("")
}

function anthropicImageUrl(block) {
  const source = block.source
  if (!source || typeof source !== "object") return undefined
  if (source.type === "base64" && source.data && source.media_type) {
    return `data:${source.media_type};base64,${source.data}`
  }
  if (source.type === "url" && source.url) return source.url
  return undefined
}

function responsesContentToCommandCode(content) {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    if (typeof part === "string") return [{ type: "text", text: part }]
    if (!part || typeof part !== "object") return []
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      return typeof part.text === "string" ? [{ type: "text", text: part.text }] : []
    }
    if (part.type === "input_image") {
      const raw = part.image_url ?? part.url
      const url = typeof raw === "string" ? raw : raw?.url
      return typeof url === "string" ? [{ type: "image", image: url, mimeType: mimeTypeOf(url) }] : []
    }
    return []
  })
}

function buildGenerateBody(input, threadId) {
  const reasoningEffort = normalizeReasoningEffort(input.reasoningEffort, input.model)
  return {
    config: {
      workingDir: WORKDIR,
      date: new Date().toISOString().slice(0, 10),
      environment: process.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    permissionMode: PERMISSION_MODE,
    threadId,
    mode: MODE,
    params: {
      model: input.model,
      messages: input.messages,
      tools: input.tools,
      system: input.system,
      max_tokens: input.maxTokens,
      stream: true,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { top_p: input.topP } : {}),
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
      ...(input.stop !== undefined ? { stop: input.stop } : {}),
    },
  }
}

function openAIToCommandCode(input) {
  const system = []
  const messages = []
  const toolNames = new Map()
  const toolRegistry = buildToolRegistry(input.tools)
  const source = Array.isArray(input.messages) ? input.messages : []
  const lastUserIndex = lastMessageIndex(source, "user")
  let directiveEffort

  for (const [messageIndex, message] of source.entries()) {
    if (!message || typeof message !== "object") continue
    if (message.role === "system" || message.role === "developer") {
      const text = readThinkDirective(contentText(message.content), (effort) => (directiveEffort = effort))
      if (text) system.push({ type: "text", text })
      continue
    }
    if (message.role === "assistant") {
      const textContent = []
      if (typeof message.content === "string" && message.content.length > 0) {
        textContent.push({ type: "text", text: message.content })
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (
            (part?.type === "text" || part?.type === "input_text" || part?.type === "output_text") &&
            typeof part.text === "string"
          ) {
            textContent.push({ type: "text", text: part.text })
          }
        }
      }
      const reasoningContent = []
      const seenReasoning = new Set()
      for (const value of [message.reasoning_content, message.reasoning, message.reasoning_text]) {
        if (typeof value !== "string" || value.length === 0 || seenReasoning.has(value)) continue
        seenReasoning.add(value)
        reasoningContent.push({ type: "reasoning", text: stripThinkControl(value) })
      }
      const content = [...reasoningContent, ...textContent]
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const name = call.function?.name ?? ""
        const upstreamName = resolveToolName(toolRegistry, name) || "unknown"
        if (call.id) toolNames.set(call.id, upstreamName)
        content.push({
          type: "tool-call",
          toolCallId: call.id ?? "",
          toolName: upstreamName,
          input: parseToolArguments(call.function?.arguments),
        })
      }
      messages.push(
        content.length > 0
          ? { role: "assistant", content }
          : { role: "assistant", content: [{ type: "text", text: "(previous assistant response was empty)" }] },
      )
      continue
    }
    if (message.role === "tool") {
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.tool_call_id ?? "",
            toolName: toolNames.get(message.tool_call_id) ?? "unknown",
            output: { type: "text", value: contentText(message.content) },
          },
        ],
      })
      continue
    }

    const content = []
    if (typeof message.content === "string") {
      const text =
        messageIndex === lastUserIndex
          ? readThinkDirective(message.content, (effort) => (directiveEffort = effort))
          : message.content
      if (text) content.push({ type: "text", text })
    } else if (Array.isArray(message.content)) {
      let directiveApplied = false
      for (const part of message.content) {
        if (
          (part?.type === "text" || part?.type === "input_text" || part?.type === "output_text") &&
          typeof part.text === "string"
        ) {
          const text =
            messageIndex === lastUserIndex && !directiveApplied
              ? readThinkDirective(part.text, (effort) => (directiveEffort = effort))
              : part.text
          directiveApplied = true
          if (text) content.push({ type: "text", text })
        }
        if (part?.type === "image_url") {
          const url = part.image_url?.url ?? part.image_url
          if (typeof url === "string") content.push({ type: "image", image: url, mimeType: mimeTypeOf(url) })
        }
      }
    }
    if (content.length > 0) messages.push({ role: "user", content })
  }

  if (system.length === 0) system.push({ type: "text", text: "You are a helpful assistant." })

  let tools = toolRegistry.tools

  const choice = input.tool_choice
  if (choice === "none") {
    tools = []
  } else if (choice && typeof choice === "object" && choice.type === "function" && choice.function?.name) {
    system.push({
      type: "text",
      text: `You must call the tool "${resolveToolName(toolRegistry, choice.function.name)}" for this request.`,
    })
  } else if (choice === "required") {
    system.push({ type: "text", text: "You must call one of the provided tools for this request." })
  }

  const maxTokens = Number(input.max_completion_tokens ?? input.max_tokens)
  return {
    model: input.model,
    system,
    messages: repairToolCallHistory(messages),
    tools,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(64000, Math.floor(maxTokens)) : 64000,
    temperature: typeof input.temperature === "number" ? input.temperature : undefined,
    topP: typeof input.top_p === "number" ? input.top_p : undefined,
    reasoningEffort:
      directiveEffort ?? normalizeReasoningEffort(input.reasoning_effort ?? input.reasoning?.effort, input.model),
    stop: input.stop,
    toolRegistry,
  }
}

function buildHeaders(threadId) {
  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "accept-encoding": "identity",
    authorization: `Bearer ${readAuthKey()}`,
    "user-agent": "cli",
    "x-command-code-version": CLI_VERSION,
    "x-cli-environment": CLI_ENVIRONMENT,
    "x-project-slug": PROJECT_SLUG,
    "x-taste-learning": TASTE_LEARNING,
    "x-session-id": threadId,
  }
  if (process.env.CMDC_SURFACE) headers["x-cli-surface"] = process.env.CMDC_SURFACE
  if (process.env.CMDC_ZDR === "1") headers["x-cmd-zdr"] = "1"
  return headers
}

function readAuthKey() {
  const envKey = process.env.COMMAND_CODE_API_KEY?.trim()
  if (envKey) return envKey
  let raw
  try {
    raw = fs.readFileSync(AUTH_PATH, "utf8")
  } catch {
    throw new HttpError(401, `Command Code login not found at ${AUTH_PATH}. Run "cmdc login" first.`)
  }
  const data = parseJson(raw)
  if (!data || typeof data.apiKey !== "string" || data.apiKey.length === 0) {
    throw new HttpError(401, `No apiKey found in ${AUTH_PATH}. Run "cmdc login" first.`)
  }
  return data.apiKey
}

function usageHeaders() {
  return {
    accept: "application/json",
    authorization: `Bearer ${readAuthKey()}`,
    "user-agent": "cli",
    "x-command-code-version": CLI_VERSION,
    "x-cli-environment": CLI_ENVIRONMENT,
    "x-project-slug": PROJECT_SLUG,
    "x-taste-learning": TASTE_LEARNING,
    "x-session-id": crypto.randomUUID(),
  }
}

async function fetchUsageJson(endpoint, params) {
  const url = new URL(`${BASE_URL}${endpoint}`)
  for (const [key, value] of params) {
    if (value.length > 0) url.searchParams.set(key, value)
  }
  const upstream = await fetch(url, { headers: usageHeaders() }).catch((error) => ({ error }))
  if ("error" in upstream) {
    throw new HttpError(502, upstream.error instanceof Error ? upstream.error.message : String(upstream.error))
  }
  const text = await upstream.text()
  if (!upstream.ok) throw new HttpError(upstream.status, text || `Command Code usage request failed (${upstream.status})`)
  const data = parseJson(text)
  if (!data) throw new HttpError(502, "Command Code returned an invalid usage response")
  return data
}

async function proxyUsage(response, params) {
  const [whoami, subscription, credits, summary] = await Promise.all([
    fetchUsageJson("/alpha/whoami", new URLSearchParams()),
    fetchUsageJson("/alpha/billing/subscriptions", new URLSearchParams()),
    fetchUsageJson("/alpha/billing/credits", new URLSearchParams()),
    fetchUsageJson("/alpha/usage/summary", params),
  ])
  json(response, 200, {
    account: usageAccount(whoami),
    subscription: usageSubscription(subscription),
    credits: usageCredits(credits),
    summary,
  })
}

async function proxyUsageDetail(response, detail, params) {
  const endpoints = {
    whoami: "/alpha/whoami",
    subscription: "/alpha/billing/subscriptions",
    subscriptions: "/alpha/billing/subscriptions",
    credits: "/alpha/billing/credits",
    summary: "/alpha/usage/summary",
    usage: "/alpha/usage/summary",
  }
  const name = detail.replace(/\/+$/, "")
  const endpoint = endpoints[name]
  if (!endpoint) throw new HttpError(404, `Unknown usage endpoint "${detail}"`)
  const data = await fetchUsageJson(endpoint, params)
  if (name === "whoami") return json(response, 200, usageAccount(data))
  if (name === "subscription" || name === "subscriptions") return json(response, 200, usageSubscription(data))
  if (name === "credits") return json(response, 200, usageCredits(data))
  json(response, 200, data)
}

function usageAccount(data) {
  const user = data?.user && typeof data.user === "object" ? data.user : {}
  const org = data?.org && typeof data.org === "object" ? data.org : undefined
  return {
    user: {
      ...(user.id ? { id: user.id } : {}),
      ...(user.name ? { name: user.name } : {}),
      ...(user.userName ? { userName: user.userName } : {}),
    },
    ...(org
      ? {
          org: {
            ...(org.id ? { id: org.id } : {}),
            ...(org.name ? { name: org.name } : {}),
          },
        }
      : { org: null }),
  }
}

function usageSubscription(data) {
  const item = data?.data && typeof data.data === "object" ? data.data : {}
  return {
    ...(item.planId ? { planId: item.planId } : {}),
    ...(item.status ? { status: item.status } : {}),
    ...(item.currentPeriodStart ? { currentPeriodStart: item.currentPeriodStart } : {}),
    ...(item.currentPeriodEnd ? { currentPeriodEnd: item.currentPeriodEnd } : {}),
    ...(typeof item.cancelAtPeriodEnd === "boolean" ? { cancelAtPeriodEnd: item.cancelAtPeriodEnd } : {}),
  }
}

function usageCredits(data) {
  return {
    credits: data?.credits ?? null,
    windowLimits: data?.windowLimits ?? null,
    sandboxAccess: data?.sandboxAccess ?? null,
    sandboxMinutes: data?.sandboxMinutes ?? null,
  }
}

function authStatus() {
  try {
    readAuthKey()
    return true
  } catch {
    return false
  }
}

async function streamOpenAI(upstream, response, options) {
  const id = `chatcmpl-${randomID()}`
  const created = Math.floor(Date.now() / 1000)
  let toolIndex = 0
  let finished = false
  let usage
  let error

  const write = (value) => {
    if (response.writableEnded || response.destroyed) return
    response.write(`data: ${JSON.stringify(value)}\n\n`)
  }
  const chunk = (delta, finishReason) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: options.model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  })

  write(chunk({ role: "assistant" }, null))
  const result = await readCommandCode(upstream, (event) => {
    if (finished) return
    if (event.type === "text") {
      markOutput(options.stats)
      write(chunk({ content: event.text }, null))
      return
    }
    if (event.type === "reasoning") {
      markOutput(options.stats)
      write(chunk({ reasoning_content: event.text }, null))
      return
    }
    if (event.type === "tool") {
      markOutput(options.stats)
      const name = options.toolRegistry?.byName.get(event.name)?.name ?? event.name
      write(
        chunk(
          {
            tool_calls: [
              {
                index: toolIndex++,
                id: event.id || `call_${randomID()}`,
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(event.input ?? {}),
                },
              },
            ],
          },
          null,
        ),
      )
      return
    }
    if (event.type === "finish") {
      finished = true
      usage = event.usage
      write(chunk({}, event.reason))
      if (options.includeUsage) {
        write({
          id,
          object: "chat.completion.chunk",
          created,
          model: options.model,
          choices: [],
          usage: openAIUsage(event.usage),
        })
      }
      response.write("data: [DONE]\n\n")
      return
    }
    if (event.type === "error") {
      finished = true
      error = event.message
      return
    }
  }, options.stats?.debug)

  const completed = finished && !error
  if (!completed) {
    error ??= result.error ?? result.readError ?? "Command Code stream ended before completion"
    write(chunk({}, "stop"))
    response.write("data: [DONE]\n\n")
  }
  response.end()
  return { usage, error, finished: completed }
}

async function collectCommandCode(upstream, stats) {
  const result = {
    created: Math.floor(Date.now() / 1000),
    text: "",
    reasoning: "",
    tools: [],
    blocks: [],
    finish: undefined,
    usage: undefined,
    error: undefined,
  }

  let lastBlock
  await readCommandCode(upstream, (event) => {
    if (event.type === "text") {
      markOutput(stats)
      if (lastBlock?.type !== "text") {
        lastBlock = { type: "text", text: "" }
        result.blocks.push(lastBlock)
      }
      lastBlock.text += event.text
      result.text += event.text
    }
    if (event.type === "reasoning") {
      markOutput(stats)
      if (lastBlock?.type !== "reasoning") {
        lastBlock = { type: "reasoning", text: "" }
        result.blocks.push(lastBlock)
      }
      lastBlock.text += event.text
      result.reasoning += event.text
    }
    if (event.type === "tool") {
      markOutput(stats)
      lastBlock = { type: "tool", tool: event }
      result.blocks.push(lastBlock)
      result.tools.push(event)
    }
    if (event.type === "finish") {
      result.finish = event.reason
      result.usage = event.usage
    }
    if (event.type === "error") result.error = event.message
  }, stats?.debug)

  if (result.error) throw new HttpError(errorStatus(result.error), result.error)
  if (result.finish === undefined) throw new HttpError(502, "Command Code stream ended before completion")
  return result
}

async function collectOpenAI(upstream, model, toolRegistry, stats) {
  const result = await collectCommandCode(upstream, stats)
  const message = {
    role: "assistant",
    content: result.text || (result.tools.length > 0 ? null : ""),
  }
  if (result.reasoning) message.reasoning_content = result.reasoning
  if (result.tools.length > 0) {
    message.tool_calls = result.tools.map((tool) => ({
      id: tool.id || `call_${randomID()}`,
      type: "function",
      function: {
        name: toolRegistry?.byName.get(tool.name)?.name ?? tool.name,
        arguments: JSON.stringify(tool.input ?? {}),
      },
    }))
  }

  return {
    id: `chatcmpl-${randomID()}`,
    object: "chat.completion",
    created: result.created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: result.finish,
        logprobs: null,
      },
    ],
    ...(result.usage ? { usage: openAIUsage(result.usage) } : {}),
  }
}

function commandCodeToAnthropic(result, model, toolRegistry) {
  const content = []
  const blocks = result.blocks?.length
    ? result.blocks
    : [
        ...(result.reasoning ? [{ type: "reasoning", text: result.reasoning }] : []),
        ...(result.text ? [{ type: "text", text: result.text }] : []),
        ...result.tools.map((tool) => ({ type: "tool", tool })),
      ]
  for (const block of blocks) {
    if (block.type === "reasoning") {
      content.push({
        type: "thinking",
        thinking: block.text,
        signature: encodeReasoning(block.text) ?? "",
      })
      continue
    }
    if (block.type === "text") {
      content.push({ type: "text", text: block.text })
      continue
    }
    const tool = block.tool
    content.push({
      type: "tool_use",
      id: tool.id || `toolu_${randomID()}`,
      name: toolRegistry?.byName.get(tool.name)?.name ?? tool.name,
      input: parseToolArguments(tool.input),
    })
  }
  if (content.length === 0) content.push({ type: "text", text: "" })

  return {
    id: `msg_${randomID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: anthropicStopReason(result.finish),
    stop_sequence: null,
    usage: anthropicUsageFromCommandCode(result.usage),
  }
}

function anthropicStopReason(reason) {
  if (reason === "tool_calls") return "tool_use"
  if (reason === "length") return "max_tokens"
  if (reason === "content_filter") return "refusal"
  return "end_turn"
}

function anthropicUsageFromCommandCode(usage) {
  const result = {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
  }
  const cached = usage?.inputTokenDetails?.cacheReadTokens
  if (cached) result.cache_read_input_tokens = cached
  return result
}

function commandCodeToResponses(result, model, toolRegistry) {
  const output = []
  const blocks = result.blocks?.length
    ? result.blocks
    : [
        ...(result.reasoning ? [{ type: "reasoning", text: result.reasoning }] : []),
        ...(result.text ? [{ type: "text", text: result.text }] : []),
        ...result.tools.map((tool) => ({ type: "tool", tool })),
      ]
  for (const block of blocks) {
    if (block.type === "reasoning") {
      output.push({
        type: "reasoning",
        id: `rs_${randomID()}`,
        summary: [{ type: "summary_text", text: block.text }],
        encrypted_content: encodeReasoning(block.text),
      })
      continue
    }
    if (block.type === "text") {
      output.push({
        type: "message",
        id: `msg_${randomID()}`,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: block.text, annotations: [] }],
      })
      continue
    }
    const tool = block.tool
    const descriptor = toolRegistry?.byName.get(tool.name)
    if (descriptor?.kind === "custom") {
      output.push({
        type: "custom_tool_call",
        id: `ctc_${randomID()}`,
        status: "completed",
        call_id: tool.id || `call_${randomID()}`,
        name: descriptor.name,
        ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}),
        input: customToolInput(tool.input),
      })
      continue
    }
    output.push({
      type: "function_call",
      id: `fc_${randomID()}`,
      status: "completed",
      call_id: tool.id || `call_${randomID()}`,
      name: descriptor?.name ?? tool.name,
      ...(descriptor?.namespace ? { namespace: descriptor.namespace } : {}),
      arguments: JSON.stringify(tool.input ?? {}),
    })
  }

  const incomplete = result.finish === "length"
  return {
    id: `resp_${randomID()}`,
    object: "response",
    created_at: result.created,
    status: incomplete ? "incomplete" : "completed",
    model,
    output,
    usage: responsesUsage(result.usage),
    error: null,
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
  }
}

function responsesUsage(usage) {
  const input = usage?.inputTokens ?? 0
  const output = usage?.outputTokens ?? 0
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: usage?.outputTokenDetails?.reasoningTokens ?? 0 },
    total_tokens: usage?.totalTokens ?? input + output,
  }
}

async function streamAnthropic(upstream, response, model, toolRegistry, stats) {
  const state = {
    id: `msg_${randomID()}`,
    model,
    next: 0,
    blocks: [],
    reasoning: undefined,
    text: undefined,
    tools: new Map(),
    usage: undefined,
    finish: undefined,
    failed: false,
  }

  const emit = (type, data) => {
    if (response.writableEnded || response.destroyed) return
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  }
  const ensureReasoning = () => {
    if (state.reasoning) return state.reasoning
    state.reasoning = { kind: "reasoning", index: state.next++, text: "" }
    state.blocks.push(state.reasoning)
    emit("content_block_start", {
      index: state.reasoning.index,
      content_block: { type: "thinking", thinking: "" },
    })
    return state.reasoning
  }
  const ensureText = () => {
    if (state.text) return state.text
    state.text = { kind: "text", index: state.next++, text: "" }
    state.blocks.push(state.text)
    emit("content_block_start", { index: state.text.index, content_block: { type: "text", text: "" } })
    return state.text
  }
  const ensureTool = (tool) => {
    const key = tool.id || tool.name
    if (state.tools.has(key)) return state.tools.get(key)
    const descriptor = toolRegistry?.byName.get(tool.name)
    const block = {
      kind: "tool",
      index: state.next++,
      id: tool.id || `toolu_${randomID()}`,
      name: descriptor?.name ?? tool.name,
    }
    state.tools.set(key, block)
    state.blocks.push(block)
    emit("content_block_start", {
      index: block.index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    })
    return block
  }

  emit("message_start", {
    message: {
      id: state.id,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
  emit("ping", {})

  const readResult = await readCommandCode(upstream, (event) => {
    if (state.finish || state.failed) return
    if (event.type === "text") {
      markOutput(stats)
      const block = ensureText()
      block.text += event.text
      emit("content_block_delta", { index: block.index, delta: { type: "text_delta", text: event.text } })
      return
    }
    if (event.type === "reasoning") {
      markOutput(stats)
      const block = ensureReasoning()
      block.text += event.text
      emit("content_block_delta", {
        index: block.index,
        delta: { type: "thinking_delta", thinking: event.text },
      })
      return
    }
    if (event.type === "tool") {
      markOutput(stats)
      const block = ensureTool(event)
      emit("content_block_delta", {
        index: block.index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(event.input ?? {}) },
      })
      state.text = undefined
      state.reasoning = undefined
      return
    }
    if (event.type === "finish") {
      state.finish = event.reason
      state.usage = event.usage
      return
    }
    if (event.type === "error") {
      state.failed = true
      emit("error", { error: { type: "upstream_error", message: event.message } })
    }
  }, stats?.debug)

  if (state.failed) {
    response.end()
    return { usage: state.usage, error: state.failed, finished: false }
  }
  const truncated = !state.finish
  if (truncated) state.finish = "stop"

  const blocks = [...state.blocks]
  blocks.sort((left, right) => left.index - right.index)
  if (blocks.length === 0) {
    emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    emit("content_block_stop", { index: 0 })
  } else {
    for (const block of blocks) {
      if (block.kind === "reasoning") {
        const text = block.text ?? ""
        emit("content_block_delta", {
          index: block.index,
          delta: { type: "signature_delta", signature: encodeReasoning(text) ?? "" },
        })
      }
      emit("content_block_stop", { index: block.index })
    }
  }

  emit("message_delta", {
    delta: { stop_reason: anthropicStopReason(state.finish), stop_sequence: null },
    usage: { output_tokens: state.usage?.outputTokens ?? 0 },
  })
  emit("message_stop", {})
  response.end()
  return {
    usage: state.usage,
    error: truncated ? (readResult.readError ?? "Command Code stream ended before completion") : undefined,
    finished: !truncated,
  }
}

async function streamResponses(upstream, response, model, toolRegistry, stats) {
  const state = {
    id: `resp_${randomID()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    sequence: 0,
    next: 0,
    blocks: [],
    reasoning: undefined,
    text: undefined,
    tools: new Map(),
    usage: undefined,
    finish: undefined,
    failed: false,
  }

  const responseObject = (status, output) => ({
    id: state.id,
    object: "response",
    created_at: state.created,
    status,
    model,
    output,
    usage: responsesUsage(state.usage),
    error: null,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  })
  const emit = (type, data) => {
    if (response.writableEnded || response.destroyed) return
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: state.sequence++, ...data })}\n\n`,
    )
  }
  const ensureReasoning = () => {
    if (state.reasoning) return state.reasoning
    state.reasoning = { kind: "reasoning", id: `rs_${randomID()}`, index: state.next++, text: "" }
    state.blocks.push(state.reasoning)
    emit("response.output_item.added", {
      output_index: state.reasoning.index,
      item: { type: "reasoning", id: state.reasoning.id, summary: [] },
    })
    return state.reasoning
  }
  const ensureText = () => {
    if (state.text) return state.text
    state.text = { kind: "text", id: `msg_${randomID()}`, index: state.next++, text: "" }
    state.blocks.push(state.text)
    emit("response.output_item.added", {
      output_index: state.text.index,
      item: { type: "message", id: state.text.id, status: "in_progress", role: "assistant", content: [] },
    })
    return state.text
  }
  const ensureTool = (tool) => {
    const key = tool.id || tool.name
    if (state.tools.has(key)) return state.tools.get(key)
    const descriptor = toolRegistry?.byName.get(tool.name)
    const custom = descriptor?.kind === "custom"
    const block = custom
      ? {
          kind: "custom",
          custom: true,
          id: `ctc_${randomID()}`,
          index: state.next++,
          callID: tool.id || `call_${randomID()}`,
          name: descriptor.name,
          namespace: descriptor.namespace,
          input: customToolInput(tool.input),
        }
      : {
          kind: "function",
          custom: false,
          id: `fc_${randomID()}`,
          index: state.next++,
          callID: tool.id || `call_${randomID()}`,
          name: descriptor?.name ?? tool.name,
          namespace: descriptor?.namespace ?? null,
          arguments: JSON.stringify(tool.input ?? {}),
        }
    state.tools.set(key, block)
    state.blocks.push(block)
    emit("response.output_item.added", {
      output_index: block.index,
      item: custom
        ? {
            type: "custom_tool_call",
            id: block.id,
            call_id: block.callID,
            name: block.name,
            ...(block.namespace ? { namespace: block.namespace } : {}),
            input: "",
            status: "in_progress",
          }
        : {
            type: "function_call",
            id: block.id,
            call_id: block.callID,
            name: block.name,
            ...(block.namespace ? { namespace: block.namespace } : {}),
            arguments: "",
            status: "in_progress",
          },
    })
    emit(custom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta", {
      item_id: block.id,
      output_index: block.index,
      delta: custom ? block.input : block.arguments,
    })
    return block
  }

  emit("response.created", { response: responseObject("in_progress", []) })
  emit("response.in_progress", { response: responseObject("in_progress", []) })

  const readResult = await readCommandCode(upstream, (event) => {
    if (state.finish || state.failed) return
    if (event.type === "text") {
      markOutput(stats)
      const item = ensureText()
      item.text += event.text
      emit("response.output_text.delta", {
        item_id: item.id,
        output_index: item.index,
        content_index: 0,
        delta: event.text,
      })
      return
    }
    if (event.type === "reasoning") {
      markOutput(stats)
      const item = ensureReasoning()
      item.text += event.text
      emit("response.reasoning_summary_text.delta", {
        item_id: item.id,
        output_index: item.index,
        summary_index: 0,
        delta: event.text,
      })
      return
    }
    if (event.type === "tool") {
      markOutput(stats)
      ensureTool(event)
      state.text = undefined
      state.reasoning = undefined
      return
    }
    if (event.type === "finish") {
      state.finish = event.reason
      state.usage = event.usage
      return
    }
    if (event.type === "error") {
      state.failed = true
      emit("error", { error: { type: "upstream_error", message: event.message } })
    }
  }, stats?.debug)

  if (state.failed) {
    response.end()
    return { usage: state.usage, error: state.failed, finished: false }
  }
  const truncated = !state.finish
  if (truncated) state.finish = "stop"

  const items = state.blocks.map((block) => {
    if (block.kind === "reasoning") {
      return {
        index: block.index,
        item: {
          type: "reasoning",
          id: block.id,
          summary: [{ type: "summary_text", text: block.text }],
          encrypted_content: encodeReasoning(block.text),
        },
        done: {
          type: "response.reasoning_summary_text.done",
          data: {
            item_id: block.id,
            output_index: block.index,
            summary_index: 0,
            text: block.text,
          },
        },
      }
    }
    if (block.kind === "text") {
      return {
        index: block.index,
        item: {
          type: "message",
          id: block.id,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: block.text, annotations: [] }],
        },
        done: {
          type: "response.output_text.done",
          data: {
            item_id: block.id,
            output_index: block.index,
            content_index: 0,
            text: block.text,
          },
        },
      }
    }
    if (block.kind === "custom") {
      return {
        index: block.index,
        item: {
          type: "custom_tool_call",
          id: block.id,
          status: "completed",
          call_id: block.callID,
          name: block.name,
          ...(block.namespace ? { namespace: block.namespace } : {}),
          input: block.input,
        },
        done: {
          type: "response.custom_tool_call_input.done",
          data: { item_id: block.id, output_index: block.index, input: block.input },
        },
      }
    }
    return {
      index: block.index,
      item: {
        type: "function_call",
        id: block.id,
        status: "completed",
        call_id: block.callID,
        name: block.name,
        ...(block.namespace ? { namespace: block.namespace } : {}),
        arguments: block.arguments,
      },
      done: {
        type: "response.function_call_arguments.done",
        data: { item_id: block.id, output_index: block.index, arguments: block.arguments },
      },
    }
  })
  items.sort((left, right) => left.index - right.index)
  for (const item of items) {
    emit(item.done.type, item.done.data)
    emit("response.output_item.done", { output_index: item.index, item: item.item })
  }

  const status = state.finish === "length" ? "incomplete" : "completed"
  const terminal = status === "incomplete" ? "response.incomplete" : "response.completed"
  emit(terminal, { response: responseObject(status, items.map((item) => item.item)) })
  response.end()
  return {
    usage: state.usage,
    error: truncated ? (readResult.readError ?? "Command Code stream ended before completion") : undefined,
    finished: !truncated,
  }
}

async function readCommandCode(upstream, onEvent, debug) {
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const debugStartedAt = Date.now()
  let buffer = ""
  let finished = false
  let error
  let readFailure
  let lastFinish
  let rawBytes = 0
  let lineCount = 0
  let parsedEvents = 0
  let unparsedLines = 0
  const eventTypes = new Map()
  const textFilter = new ControlTextFilter()
  const reasoningFilter = new ControlTextFilter()

  const flushFilters = () => {
    const text = textFilter.flush()
    if (text) onEvent({ type: "text", text })
    const reasoning = reasoningFilter.flush()
    if (reasoning) onEvent({ type: "reasoning", text: reasoning })
  }
  const flushBlock = (filter, type) => {
    const text = filter.flush()
    if (text) onEvent({ type, text })
    filter.reset()
  }

  const consume = (line) => {
    if (!line.trim()) {
      debug?.write("upstream_blank_line", { offsetMs: Date.now() - debugStartedAt })
      return
    }
    lineCount += 1
    const event = parseJson(line)
    debug?.write("upstream_line", {
      offsetMs: Date.now() - debugStartedAt,
      bytes: Buffer.byteLength(line) + 1,
      parsedType: event?.type ?? null,
      line: line.slice(0, 1_000_000),
    })
    if (!event) {
      unparsedLines += 1
      return
    }
    parsedEvents += 1
    const eventType = String(event.type ?? "unknown")
    eventTypes.set(eventType, (eventTypes.get(eventType) ?? 0) + 1)
    if (
      event.type === "text-start" ||
      event.type === "text-end" ||
      event.type === "reasoning-start" ||
      event.type === "reasoning-end"
    ) {
      flushBlock(textFilter, "text")
      flushBlock(reasoningFilter, "reasoning")
      return
    }
    if (event.type === "text-delta") {
      const text = textFilter.push(event.text ?? "")
      if (text) onEvent({ type: "text", text })
      return
    }
    if (event.type === "reasoning-delta") {
      const text = reasoningFilter.push(event.text ?? "")
      if (text) onEvent({ type: "reasoning", text })
      return
    }
    if (event.type === "tool-call") {
      if (event.providerExecuted === true) return
      flushBlock(textFilter, "text")
      flushBlock(reasoningFilter, "reasoning")
      onEvent({
        type: "tool",
        id: event.toolCallId ?? "",
        name: event.toolName ?? "",
        input: coerceToolInput(event.input ?? event.args),
      })
      return
    }
    if (event.type === "finish") {
      flushFilters()
      finished = true
      onEvent({
        type: "finish",
        reason: normalizeFinishReason(event.finishReason ?? event.rawFinishReason ?? lastFinish?.reason),
        usage: event.totalUsage ?? event.usage ?? lastFinish?.usage,
      })
      return
    }
    if (event.type === "abort") {
      flushFilters()
      finished = true
      onEvent({ type: "finish", reason: "stop", usage: undefined })
      return
    }
    if (event.type === "finish-step") {
      lastFinish = {
        reason: normalizeFinishReason(event.finishReason ?? event.rawFinishReason),
        usage: event.usage ?? event.totalUsage,
      }
      return
    }
    if (event.type === "error") {
      error = readError(event)
      onEvent({ type: "error", message: error })
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      rawBytes += value.byteLength
      debug?.write("upstream_chunk", { offsetMs: Date.now() - debugStartedAt, bytes: value.byteLength })
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        consume(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) consume(buffer)
  } catch (caught) {
    if (caught?.name === "AbortError") throw caught
    readFailure = caught instanceof Error ? caught.message : String(caught)
  }
  if (!finished) flushFilters()
  if (!finished && lastFinish) {
    finished = true
    onEvent({ type: "finish", reason: lastFinish.reason, usage: lastFinish.usage })
  }

  if (!finished || error || readFailure) {
    const types = [...eventTypes].map(([type, count]) => `${type}:${count}`).join(",") || "none"
    logWarn(
      `upstream stream incomplete: bytes=${rawBytes} lines=${lineCount} events=${parsedEvents} unparsed=${unparsedLines} types=${types}${readFailure ? ` read_error=${readFailure}` : ""}`,
    )
  }

  debug?.write("upstream_end", {
    offsetMs: Date.now() - debugStartedAt,
    finished,
    error: error ?? null,
    readFailure: readFailure ?? null,
    bytes: rawBytes,
    lines: lineCount,
    events: parsedEvents,
    unparsed: unparsedLines,
    types: Object.fromEntries(eventTypes),
  })
  return { finished, error, readError: readFailure }
}

function normalizeFinishReason(reason) {
  const value = String(reason ?? "").toLowerCase()
  if (value.includes("tool")) return "tool_calls"
  if (value.includes("length") || value.includes("max")) return "length"
  if (value.includes("refusal") || value.includes("content_filter")) return "content_filter"
  return "stop"
}

function normalizeReasoningEffort(value, model) {
  const effort = normalizeReasoningEffortValue(value)
  if (!effort || !model) return effort
  const supported = catalogCache?.find((entry) => entry.id === model)?.reasoningEfforts
  if (!Array.isArray(supported) || supported.length === 0 || supported.includes(effort)) return effort
  const order = ["off", "low", "medium", "high", "xhigh", "max"]
  const target = order.indexOf(effort)
  let best = supported[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of supported) {
    const index = order.indexOf(candidate)
    if (index === -1) continue
    const distance = Math.abs(index - target)
    if (distance < bestDistance || (distance === bestDistance && index > order.indexOf(best))) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

function normalizeReasoningEffortValue(value) {
  if (value === undefined) return undefined
  if (value === null || value === false) return "off"
  if (typeof value === "number") {
    if (value <= 0) return "off"
    if (value === 1) return "low"
    if (value === 2) return "medium"
    if (value === 3) return "high"
    if (value === 4) return "xhigh"
    return "max"
  }
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  if (!normalized) return "off"
  if (["none", "off", "disabled", "false", "no"].includes(normalized)) return "off"
  if (["minimal", "minimum"].includes(normalized)) return "low"
  if (normalized === "ultra") return "max"
  if (["low", "medium", "high", "xhigh", "max"].includes(normalized)) return normalized
  if (["auto", "default", "model_default"].includes(normalized)) return undefined
  return undefined
}

function openAIUsage(usage) {
  const input = usage?.inputTokens ?? usage?.prompt_tokens ?? 0
  const output = usage?.outputTokens ?? usage?.completion_tokens ?? 0
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: usage?.totalTokens ?? usage?.total_tokens ?? input + output,
    prompt_tokens_details: {
      cached_tokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    },
    completion_tokens_details: {
      reasoning_tokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,
    },
  }
}

function readError(event) {
  if (typeof event.error === "string" && event.error) return event.error
  if (event.error && typeof event.error.message === "string") return event.error.message
  if (typeof event.message === "string" && event.message) return event.message
  return "Command Code upstream error"
}

function errorStatus(message) {
  const value = String(message).toLowerCase()
  if (value.includes("model/provider not recognized") || value.includes("model_not_found") || value.includes("unknown model")) {
    return 404
  }
  if (value.includes("bad_request") || value.includes("validation error") || value.includes("invalid option")) {
    return 400
  }
  if (value.includes("model_not_in_plan") || value.includes("not available for your plan")) return 403
  if (value.includes("forbidden")) return 403
  if (value.includes("insufficient credits") || value.includes("premium_credits_exhausted")) return 402
  if (value.includes("rate limit") || value.includes("too many requests")) return 429
  return 502
}

async function proxyModels(response) {
  const models = await loadModels()
  json(response, 200, {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: "command-code",
      display_name: model.display?.label ?? model.name ?? model.id,
      context_window: model.context_length,
      max_output_tokens: model.maxOutputTokens,
      minimum_plan: model.minimumPlan,
      pricing: model.pricing,
    })),
  })
}

async function loadModels() {
  if (catalogCache && Date.now() - catalogCacheAt < 5 * 60 * 1000) return catalogCache
  const upstream = await fetch(`${BASE_URL}/provider/v1/models?view=client`, {
    headers: { accept: "application/json", "user-agent": "node" },
    signal: AbortSignal.timeout(5000),
  })
  if (!upstream.ok) throw new HttpError(upstream.status, "Could not load the Command Code model catalog")
  const data = await upstream.json()
  const rank = PLAN_RANK[PLAN] ?? 1
  catalogCache = (Array.isArray(data.data) ? data.data : []).filter(
    (model) => model && !model.hidden && (model.minimumPlan === undefined || (PLAN_RANK[model.minimumPlan] ?? 0) <= rank),
  )
  catalogCacheAt = Date.now()
  return catalogCache
}

async function resolveModel(model) {
  const normalized = normalizeModel(model)
  const alias = MODEL_ALIASES[normalized.toLowerCase()]
  if (alias) return alias
  const models = await loadModels().catch(() => [])
  const lower = normalized.toLowerCase()
  const exact = models.find((entry) => String(entry.id).toLowerCase() === lower)
  if (exact) return exact.id
  const byName = models.find((entry) => {
    const label = String(entry.display?.label ?? entry.name ?? "").toLowerCase()
    const bare = label.replace(/\s*\(latest\)\s*$/, "")
    return bare === lower || bare.replace(/\s+/g, "-") === lower || bare.replace(/\s+/g, "/") === lower
  })
  return byName?.id ?? normalized
}

function threadIdFrom(headers, body) {
  const values = [
    headers["x-cmdc-thread-id"],
    headers["x-session-id"],
    headers["session-id"],
    headers["thread-id"],
    headers["x-client-request-id"],
    body?.prompt_cache_key,
    body?.client_metadata?.session_id,
    body?.client_metadata?.thread_id,
  ]
  for (const value of values) {
    if (isUuid(value)) return value
  }
  if (DEFAULT_THREAD_ID) return DEFAULT_THREAD_ID
  const seed = values.find((value) => typeof value === "string" && value.length > 0)
  if (seed) {
    const hex = crypto.createHash("sha256").update(seed).digest("hex")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  return crypto.randomUUID()
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
}

function normalizeModel(model) {
  return String(model).replace(/^cmdc\//i, "").replace(/^command-code\//i, "").trim()
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part) => {
      if (typeof part === "string") return [part]
      if (
        (part?.type === "text" || part?.type === "input_text" || part?.type === "output_text") &&
        typeof part.text === "string"
      ) {
        return [part.text]
      }
      return []
    })
    .join("")
}

function mimeTypeOf(url) {
  const match = /^data:([^;,]+)[;,]/.exec(url)
  return match?.[1] ?? "image/png"
}

function slug(value) {
  return String(value)
    .replace(/[:\\/]+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
}

function randomID() {
  return crypto.randomBytes(12).toString("hex")
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function parseBody(value) {
  if (typeof value !== "string") return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  return parseJson(value)
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-headers", "*")
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS")
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  })
  response.end(body)
}

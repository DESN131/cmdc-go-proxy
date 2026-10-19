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

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? "127.0.0.1"
const BASE_URL = (process.env.CMDC_BASE_URL ?? "https://api.commandcode.ai").replace(/\/+$/, "")
const AUTH_PATH = process.env.CMDC_AUTH_PATH ?? path.join(os.homedir(), ".commandcode", "auth.json")
const CLI_VERSION = process.env.CMDC_CLI_VERSION ?? "1.84.0"
const CLI_ENVIRONMENT = process.env.CMDC_ENV ?? "production"
const WORKDIR = process.env.CMDC_WORKDIR ?? process.cwd()
const PROJECT_SLUG = process.env.CMDC_PROJECT_SLUG ?? slug(WORKDIR)
const PLAN = process.env.CMDC_PLAN ?? "individual-go"
const TASTE_LEARNING = process.env.CMDC_TASTE_LEARNING ?? "false"
const PERMISSION_MODE = process.env.CMDC_PERMISSION_MODE ?? "standard"
const DEFAULT_THREAD_ID = process.env.CMDC_THREAD_ID
const MAX_BODY_BYTES = 64 * 1024 * 1024

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
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    if (error?.name === "AbortError") return
    const status = typeof error?.status === "number" ? error.status : 500
    console.error(`[cmdc-proxy] ${error instanceof Error ? error.message : String(error)}`)
    if (!response.headersSent) {
      json(response, status, {
        error: {
          type: "proxy_error",
          message: error instanceof Error ? error.message : String(error),
        },
      })
      return
    }
    response.end()
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[cmdc-proxy] listening on http://${HOST}:${PORT}/v1`)
  console.log(`[cmdc-proxy] upstream ${BASE_URL}`)
  console.log(`[cmdc-proxy] plan ${PLAN}`)
  console.log(`[cmdc-proxy] workdir ${WORKDIR}`)
})

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
      message: "Use /v1/chat/completions, /v1/responses, /v1/messages, /v1/models or /health",
    },
  })
}

async function proxyChat(request, response) {
  const input = parseBody(await readBody(request))
  if (!input) throw new HttpError(400, "Request body must be a JSON object")
  if (typeof input.model !== "string" || input.model.length === 0) {
    throw new HttpError(400, "model is required")
  }

  const wantsStream = input.stream === true
  const model = normalizeModel(input.model)
  const threadId = threadIdFrom(request.headers)
  const controller = new AbortController()
  response.on("close", () => controller.abort())

  const upstream = await fetch(`${BASE_URL}/alpha/generate`, {
    method: "POST",
    headers: buildHeaders(threadId),
    body: JSON.stringify(buildGenerateBody(openAIToCommandCode({ ...input, model }), threadId)),
    signal: controller.signal,
  }).catch((error) => ({ error }))

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      response.end()
      return
    }
    throw new HttpError(502, upstream.error instanceof Error ? upstream.error.message : String(upstream.error))
  }

  console.log(`[cmdc-proxy] ${upstream.status} chat model=${model} stream=${wantsStream}`)
  if (!upstream.ok) {
    const text = await upstream.text()
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    await streamOpenAI(upstream, response, {
      model,
      includeUsage: input.stream_options?.include_usage === true,
    })
    return
  }

  json(response, 200, await collectOpenAI(upstream, model))
}

async function proxyAnthropic(request, response) {
  const input = parseBody(await readBody(request))
  if (!input) throw new HttpError(400, "Request body must be a JSON object")
  const model = normalizeModel(input.model)
  await runCommandCode(
    request,
    response,
    anthropicToCommandCode({ ...input, model }),
    "anthropic",
    model,
    input.stream === true,
  )
}

async function proxyResponses(request, response) {
  const input = parseBody(await readBody(request))
  if (!input) throw new HttpError(400, "Request body must be a JSON object")
  const model = normalizeModel(input.model)
  await runCommandCode(
    request,
    response,
    responsesToCommandCode({ ...input, model }),
    "responses",
    model,
    input.stream === true,
  )
}

async function runCommandCode(request, response, input, protocol, model, wantsStream) {
  const threadId = threadIdFrom(request.headers)
  const controller = new AbortController()
  response.on("close", () => controller.abort())

  const upstream = await fetch(`${BASE_URL}/alpha/generate`, {
    method: "POST",
    headers: buildHeaders(threadId),
    body: JSON.stringify(buildGenerateBody(input, threadId)),
    signal: controller.signal,
  }).catch((error) => ({ error }))

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      response.end()
      return
    }
    throw new HttpError(502, upstream.error instanceof Error ? upstream.error.message : String(upstream.error))
  }

  console.log(`[cmdc-proxy] ${upstream.status} ${protocol} model=${model} stream=${wantsStream}`)
  if (!upstream.ok) {
    const text = await upstream.text()
    const parsed = parseJson(text)
    const message = parsed?.error?.message ?? text
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
    if (protocol === "anthropic") await streamAnthropic(upstream, response, model)
    else await streamResponses(upstream, response, model)
    return
  }

  const result = await collectCommandCode(upstream)
  if (result.error) throw new HttpError(errorStatus(result.error), result.error)
  if (protocol === "anthropic") json(response, 200, commandCodeToAnthropic(result, model))
  else json(response, 200, commandCodeToResponses(result, model))
}

function anthropicToCommandCode(input) {
  const system = []
  const systemText = anthropicText(input.system)
  if (systemText) system.push({ type: "text", text: systemText })
  const messages = []
  const toolNames = new Map()

  for (const message of Array.isArray(input.messages) ? input.messages : []) {
    if (!message || typeof message !== "object") continue
    if (message.role === "assistant") {
      const content = []
      for (const block of anthropicBlocks(message.content)) {
        if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text })
        if (block.type === "tool_use") {
          const id = block.id ?? `call_${randomID()}`
          const name = block.name ?? ""
          toolNames.set(id, name)
          content.push({ type: "tool-call", toolCallId: id, toolName: name, input: block.input ?? {} })
        }
      }
      if (content.length > 0) messages.push({ role: "assistant", content })
      continue
    }

    const parts = []
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
        parts.push({ type: "text", text: block.text })
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

  let tools = (Array.isArray(input.tools) ? input.tools : []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.input_schema ?? { type: "object", properties: {} },
  }))

  const choice = input.tool_choice
  if (choice?.type === "none") tools = []
  else if (choice?.type === "any") {
    system.push({ type: "text", text: "You must call one of the provided tools for this request." })
  } else if (choice?.type === "tool" && choice.name) {
    system.push({ type: "text", text: `You must call the tool "${choice.name}" for this request.` })
  }

  const maxTokens = Number(input.max_tokens)
  return {
    model: normalizeModel(input.model),
    system,
    messages,
    tools,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(64000, Math.floor(maxTokens)) : 64000,
    temperature: typeof input.temperature === "number" ? input.temperature : undefined,
    topP: typeof input.top_p === "number" ? input.top_p : undefined,
    stop: input.stop_sequences,
    reasoningEffort:
      input.thinking?.type === "enabled" ? "high" : input.thinking?.type === "disabled" ? "off" : undefined,
  }
}

function responsesToCommandCode(input) {
  const system = []
  if (typeof input.instructions === "string" && input.instructions.trim()) {
    system.push({ type: "text", text: input.instructions })
  }
  const messages = []

  if (typeof input.input === "string") {
    messages.push({ role: "user", content: [{ type: "text", text: input.input }] })
  } else if (Array.isArray(input.input)) {
    for (const item of input.input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: [{ type: "text", text: item }] })
        continue
      }
      if (!item || typeof item !== "object") continue
      if (item.type === "message") {
        const content = responsesContentToCommandCode(item.content)
        if (content.length > 0) messages.push({ role: item.role ?? "user", content })
        continue
      }
      if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: item.call_id ?? item.id ?? `call_${randomID()}`,
              toolName: item.name ?? "",
              input: parseJson(item.arguments) ?? {},
            },
          ],
        })
        continue
      }
      if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: item.call_id ?? "",
              toolName: "unknown",
              output: {
                type: "text",
                value: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
              },
            },
          ],
        })
      }
    }
  }

  const systemMessages = messages.filter((message) => message.role === "system" || message.role === "developer")
  for (const message of systemMessages) system.push(...message.content)
  const chatMessages = messages.filter((message) => message.role !== "system" && message.role !== "developer")
  if (system.length === 0) system.push({ type: "text", text: "You are a helpful assistant." })

  let tools = (Array.isArray(input.tools) ? input.tools : [])
    .filter((tool) => tool?.type === "function")
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.parameters ?? { type: "object", properties: {} },
    }))

  const choice = input.tool_choice
  if (choice === "none") tools = []
  else if (choice === "required") {
    system.push({ type: "text", text: "You must call one of the provided tools for this request." })
  } else if (choice && typeof choice === "object" && choice.type === "function" && choice.name) {
    system.push({ type: "text", text: `You must call the tool "${choice.name}" for this request.` })
  }

  const maxTokens = Number(input.max_output_tokens)
  return {
    model: normalizeModel(input.model),
    system,
    messages: chatMessages,
    tools,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(64000, Math.floor(maxTokens)) : 64000,
    temperature: typeof input.temperature === "number" ? input.temperature : undefined,
    topP: typeof input.top_p === "number" ? input.top_p : undefined,
    reasoningEffort: normalizeReasoningEffort(input.reasoning?.effort),
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
      const url = part.image_url ?? part.url
      return typeof url === "string" ? [{ type: "image", image: url, mimeType: mimeTypeOf(url) }] : []
    }
    return []
  })
}

function buildGenerateBody(input, threadId) {
  const reasoningEffort = normalizeReasoningEffort(input.reasoningEffort)
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

  for (const message of Array.isArray(input.messages) ? input.messages : []) {
    if (!message || typeof message !== "object") continue
    if (message.role === "system" || message.role === "developer") {
      const text = contentText(message.content)
      if (text) system.push({ type: "text", text })
      continue
    }
    if (message.role === "assistant") {
      const content = []
      if (typeof message.content === "string" && message.content.length > 0) {
        content.push({ type: "text", text: message.content })
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text })
        }
      }
      if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
        content.push({ type: "reasoning", text: message.reasoning_content })
      }
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const name = call.function?.name ?? ""
        if (call.id) toolNames.set(call.id, name)
        content.push({
          type: "tool-call",
          toolCallId: call.id ?? "",
          toolName: name,
          input: parseJson(call.function?.arguments) ?? {},
        })
      }
      if (content.length > 0) messages.push({ role: "assistant", content })
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
      content.push({ type: "text", text: message.content })
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text })
        if (part?.type === "image_url") {
          const url = part.image_url?.url ?? part.image_url
          if (typeof url === "string") content.push({ type: "image", image: url, mimeType: mimeTypeOf(url) })
        }
      }
    }
    if (content.length > 0) messages.push({ role: "user", content })
  }

  if (system.length === 0) system.push({ type: "text", text: "You are a helpful assistant." })

  let tools = (Array.isArray(input.tools) ? input.tools : [])
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description ?? "",
      input_schema: tool.function.parameters ?? { type: "object", properties: {} },
    }))

  const choice = input.tool_choice
  if (choice === "none") {
    tools = []
  } else if (choice && typeof choice === "object" && choice.type === "function" && choice.function?.name) {
    system.push({ type: "text", text: `You must call the tool "${choice.function.name}" for this request.` })
  } else if (choice === "required") {
    system.push({ type: "text", text: "You must call one of the provided tools for this request." })
  }

  const maxTokens = Number(input.max_completion_tokens ?? input.max_tokens)
  return {
    model: normalizeModel(input.model),
    system,
    messages,
    tools,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(64000, Math.floor(maxTokens)) : 64000,
    temperature: typeof input.temperature === "number" ? input.temperature : undefined,
    topP: typeof input.top_p === "number" ? input.top_p : undefined,
    reasoningEffort: normalizeReasoningEffort(input.reasoning_effort),
    stop: input.stop,
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

  const write = (value) => {
    if (response.writableEnded || response.destroyed) return
    response.write(`data: ${JSON.stringify(value)}\n\n`)
  }
  const chunk = (delta, finishReason, usage) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: options.model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    ...(usage ? { usage } : {}),
  })

  write(chunk({ role: "assistant" }, null))
  const result = await readCommandCode(upstream, (event) => {
    if (finished) return
    if (event.type === "text") {
      write(chunk({ content: event.text }, null))
      return
    }
    if (event.type === "reasoning") {
      write(chunk({ reasoning_content: event.text }, null))
      return
    }
    if (event.type === "tool") {
      write(
        chunk(
          {
            tool_calls: [
              {
                index: toolIndex++,
                id: event.id || `call_${randomID()}`,
                type: "function",
                function: {
                  name: event.name,
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
      write(chunk({}, event.reason, options.includeUsage ? openAIUsage(event.usage) : undefined))
      response.write("data: [DONE]\n\n")
      return
    }
    if (event.type === "error") {
      finished = true
      write({ error: { message: event.message, type: "upstream_error" } })
      response.write("data: [DONE]\n\n")
    }
  })

  if (!finished) {
    write({
      error: {
        message: result.error ?? "Command Code stream ended before completion",
        type: "upstream_error",
      },
    })
    response.write("data: [DONE]\n\n")
  }
  response.end()
}

async function collectCommandCode(upstream) {
  const result = {
    created: Math.floor(Date.now() / 1000),
    text: "",
    reasoning: "",
    tools: [],
    finish: undefined,
    usage: undefined,
    error: undefined,
  }

  await readCommandCode(upstream, (event) => {
    if (event.type === "text") result.text += event.text
    if (event.type === "reasoning") result.reasoning += event.text
    if (event.type === "tool") result.tools.push(event)
    if (event.type === "finish") {
      result.finish = event.reason
      result.usage = event.usage
    }
    if (event.type === "error") result.error = event.message
  })

  if (result.error) throw new HttpError(errorStatus(result.error), result.error)
  if (result.finish === undefined) throw new HttpError(502, "Command Code stream ended before completion")
  return result
}

async function collectOpenAI(upstream, model) {
  const result = await collectCommandCode(upstream)
  const message = { role: "assistant", content: result.text || "" }
  if (result.reasoning) message.reasoning_content = result.reasoning
  if (result.tools.length > 0) {
    message.tool_calls = result.tools.map((tool) => ({
      id: tool.id || `call_${randomID()}`,
      type: "function",
      function: {
        name: tool.name,
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

function commandCodeToAnthropic(result, model) {
  const content = []
  if (result.reasoning) content.push({ type: "thinking", thinking: result.reasoning, signature: "" })
  if (result.text) content.push({ type: "text", text: result.text })
  for (const tool of result.tools) {
    content.push({
      type: "tool_use",
      id: tool.id || `toolu_${randomID()}`,
      name: tool.name,
      input: tool.input ?? {},
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

function commandCodeToResponses(result, model) {
  const output = []
  if (result.reasoning) {
    output.push({
      type: "reasoning",
      id: `rs_${randomID()}`,
      summary: [{ type: "summary_text", text: result.reasoning }],
    })
  }
  if (result.text) {
    output.push({
      type: "message",
      id: `msg_${randomID()}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: result.text, annotations: [] }],
    })
  }
  for (const tool of result.tools) {
    output.push({
      type: "function_call",
      id: `fc_${randomID()}`,
      status: "completed",
      call_id: tool.id || `call_${randomID()}`,
      name: tool.name,
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

async function streamAnthropic(upstream, response, model) {
  const state = {
    id: `msg_${randomID()}`,
    model,
    next: 0,
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
    state.reasoning = { index: state.next++, text: "" }
    emit("content_block_start", {
      index: state.reasoning.index,
      content_block: { type: "thinking", thinking: "" },
    })
    return state.reasoning
  }
  const ensureText = () => {
    if (state.text) return state.text
    state.text = { index: state.next++, text: "" }
    emit("content_block_start", { index: state.text.index, content_block: { type: "text", text: "" } })
    return state.text
  }
  const ensureTool = (tool) => {
    const key = tool.id || tool.name
    if (state.tools.has(key)) return state.tools.get(key)
    const block = {
      index: state.next++,
      id: tool.id || `toolu_${randomID()}`,
      name: tool.name,
    }
    state.tools.set(key, block)
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

  await readCommandCode(upstream, (event) => {
    if (state.finish || state.failed) return
    if (event.type === "text") {
      const block = ensureText()
      block.text += event.text
      emit("content_block_delta", { index: block.index, delta: { type: "text_delta", text: event.text } })
      return
    }
    if (event.type === "reasoning") {
      const block = ensureReasoning()
      block.text += event.text
      emit("content_block_delta", {
        index: block.index,
        delta: { type: "thinking_delta", thinking: event.text },
      })
      return
    }
    if (event.type === "tool") {
      const block = ensureTool(event)
      emit("content_block_delta", {
        index: block.index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(event.input ?? {}) },
      })
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
  })

  if (state.failed) {
    response.end()
    return
  }
  if (!state.finish) {
    emit("error", { error: { type: "upstream_error", message: "Command Code stream ended before completion" } })
    response.end()
    return
  }

  const blocks = []
  if (state.reasoning) blocks.push({ index: state.reasoning.index, type: "reasoning" })
  if (state.text) blocks.push({ index: state.text.index, type: "text" })
  for (const tool of state.tools.values()) blocks.push({ index: tool.index, type: "tool" })
  blocks.sort((left, right) => left.index - right.index)
  if (blocks.length === 0) {
    emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    emit("content_block_stop", { index: 0 })
  } else {
    for (const block of blocks) {
      if (block.type === "reasoning") {
        emit("content_block_delta", { index: block.index, delta: { type: "signature_delta", signature: "" } })
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
}

async function streamResponses(upstream, response, model) {
  const state = {
    id: `resp_${randomID()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    sequence: 0,
    next: 0,
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
    state.reasoning = { id: `rs_${randomID()}`, index: state.next++, text: "" }
    emit("response.output_item.added", {
      output_index: state.reasoning.index,
      item: { type: "reasoning", id: state.reasoning.id, summary: [] },
    })
    return state.reasoning
  }
  const ensureText = () => {
    if (state.text) return state.text
    state.text = { id: `msg_${randomID()}`, index: state.next++, text: "" }
    emit("response.output_item.added", {
      output_index: state.text.index,
      item: { type: "message", id: state.text.id, status: "in_progress", role: "assistant", content: [] },
    })
    return state.text
  }
  const ensureTool = (tool) => {
    const key = tool.id || tool.name
    if (state.tools.has(key)) return state.tools.get(key)
    const block = {
      id: `fc_${randomID()}`,
      index: state.next++,
      callID: tool.id || `call_${randomID()}`,
      name: tool.name,
      arguments: JSON.stringify(tool.input ?? {}),
    }
    state.tools.set(key, block)
    emit("response.output_item.added", {
      output_index: block.index,
      item: {
        type: "function_call",
        id: block.id,
        call_id: block.callID,
        name: block.name,
        arguments: "",
        status: "in_progress",
      },
    })
    emit("response.function_call_arguments.delta", {
      item_id: block.id,
      output_index: block.index,
      delta: block.arguments,
    })
    return block
  }

  emit("response.created", { response: responseObject("in_progress", []) })
  emit("response.in_progress", { response: responseObject("in_progress", []) })

  await readCommandCode(upstream, (event) => {
    if (state.finish || state.failed) return
    if (event.type === "text") {
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
      ensureTool(event)
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
  })

  if (state.failed) {
    response.end()
    return
  }
  if (!state.finish) {
    emit("error", { error: { type: "upstream_error", message: "Command Code stream ended before completion" } })
    response.end()
    return
  }

  const items = []
  if (state.reasoning) {
    items.push({
      index: state.reasoning.index,
      item: {
        type: "reasoning",
        id: state.reasoning.id,
        summary: [{ type: "summary_text", text: state.reasoning.text }],
      },
      done: {
        type: "response.reasoning_summary_text.done",
        data: {
          item_id: state.reasoning.id,
          output_index: state.reasoning.index,
          summary_index: 0,
          text: state.reasoning.text,
        },
      },
    })
  }
  if (state.text) {
    items.push({
      index: state.text.index,
      item: {
        type: "message",
        id: state.text.id,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: state.text.text, annotations: [] }],
      },
      done: {
        type: "response.output_text.done",
        data: {
          item_id: state.text.id,
          output_index: state.text.index,
          content_index: 0,
          text: state.text.text,
        },
      },
    })
  }
  for (const tool of state.tools.values()) {
    items.push({
      index: tool.index,
      item: {
        type: "function_call",
        id: tool.id,
        status: "completed",
        call_id: tool.callID,
        name: tool.name,
        arguments: tool.arguments,
      },
      done: {
        type: "response.function_call_arguments.done",
        data: { item_id: tool.id, output_index: tool.index, arguments: tool.arguments },
      },
    })
  }
  items.sort((left, right) => left.index - right.index)
  for (const item of items) {
    emit(item.done.type, item.done.data)
    emit("response.output_item.done", { output_index: item.index, item: item.item })
  }

  const status = state.finish === "length" ? "incomplete" : "completed"
  const terminal = status === "incomplete" ? "response.incomplete" : "response.completed"
  emit(terminal, { response: responseObject(status, items.map((item) => item.item)) })
  response.end()
}

async function readCommandCode(upstream, onEvent) {
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let finished = false
  let error
  let lastFinish

  const consume = (line) => {
    if (!line.trim()) return
    const event = parseJson(line)
    if (!event) return
    if (event.type === "text-delta") {
      onEvent({ type: "text", text: event.text ?? "" })
      return
    }
    if (event.type === "reasoning-delta") {
      onEvent({ type: "reasoning", text: event.text ?? "" })
      return
    }
    if (event.type === "tool-call") {
      onEvent({
        type: "tool",
        id: event.toolCallId ?? "",
        name: event.toolName ?? "",
        input: event.input ?? {},
      })
      return
    }
    if (event.type === "finish") {
      finished = true
      onEvent({
        type: "finish",
        reason: normalizeFinishReason(event.finishReason ?? event.rawFinishReason),
        usage: event.totalUsage ?? event.usage,
      })
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

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
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
  if (!finished && lastFinish) {
    finished = true
    onEvent({ type: "finish", reason: lastFinish.reason, usage: lastFinish.usage })
  }

  return { finished, error }
}

function normalizeFinishReason(reason) {
  const value = String(reason ?? "").toLowerCase()
  if (value.includes("tool")) return "tool_calls"
  if (value.includes("length") || value.includes("max")) return "length"
  if (value.includes("refusal") || value.includes("content_filter")) return "content_filter"
  return "stop"
}

function normalizeReasoningEffort(value) {
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
  if (value.includes("model_not_in_plan") || value.includes("not available for your plan")) return 403
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

function threadIdFrom(headers) {
  const value = headers["x-cmdc-thread-id"] ?? headers["x-session-id"]
  if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return value
  }
  return DEFAULT_THREAD_ID ?? crypto.randomUUID()
}

function normalizeModel(model) {
  return String(model).replace(/^cmdc\//, "").replace(/^command-code\//, "")
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part) => {
      if (typeof part === "string") return [part]
      if (part?.type === "text" && typeof part.text === "string") return [part.text]
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

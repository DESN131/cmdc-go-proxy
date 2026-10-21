import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { test } from "node:test"

const PROXY = "cmdc-proxy.mjs"

async function startProxy(handler, extraEnv = {}) {
  const mock = http.createServer(handler)
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve))
  const mockPort = mock.address().port
  const child = spawn(process.execPath, [PROXY], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      CMDC_BASE_URL: `http://127.0.0.1:${mockPort}`,
      COMMAND_CODE_API_KEY: "test",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let logs = ""
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proxy startup timeout\n${logs}`)), 8000)
    const onData = (chunk) => {
      logs += chunk
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+\/v1)/.exec(logs)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`proxy exited ${code}\n${logs}`))
    })
  })
  return {
    base,
    child,
    async close() {
      if (!child.killed) child.kill()
      mock.closeAllConnections?.()
      await new Promise((resolve) => mock.close(resolve))
    },
    get logs() {
      return logs
    },
  }
}

async function readRequestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}

function writeCommandEvents(response, events, end = true) {
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const event of events) response.write(`${JSON.stringify(event)}\n`)
  if (end) response.end()
}

async function proxyJson(proxy, path, body) {
  const response = await fetch(`${proxy.base.replace(/\/v1$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}

const textEvents = (text = "hello") => [
  { type: "text-start" },
  { type: "text-delta", text },
  { type: "text-end" },
  { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } },
]

test("streams and aggregates chat completions", async (t) => {
  const proxy = await startProxy(async (request, response) => {
    await readRequestBody(request)
    writeCommandEvents(response, textEvents())
  })
  t.after(() => proxy.close())

  const stream = await fetch(`${proxy.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }],
    }),
  })
  const streamText = await stream.text()
  assert.equal(stream.status, 200)
  assert.match(streamText, /hello/)
  assert.match(streamText, /"prompt_tokens":2/)
  assert.match(streamText, /\[DONE\]/)

  const json = await proxyJson(proxy, "/v1/chat/completions", {
    model: "deepseek-flash",
    messages: [{ role: "user", content: "hi" }],
  })
  assert.equal(json.status, 200)
  assert.equal(JSON.parse(json.text).choices[0].message.content, "hello")
})

test("falls back to the next port when the preferred port is occupied", async (t) => {
  const occupied = http.createServer((_request, response) => {
    response.writeHead(200)
    response.end("occupied")
  })
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve))
  const occupiedPort = occupied.address().port
  const proxy = await startProxy(async (request, response) => {
    await readRequestBody(request)
    writeCommandEvents(response, textEvents())
  }, {
    PORT: String(occupiedPort),
    PORT_ATTEMPTS: "3",
  })
  t.after(async () => {
    await proxy.close()
    await new Promise((resolve) => occupied.close(resolve))
  })

  assert.notEqual(new URL(proxy.base).port, String(occupiedPort))
  assert.match(proxy.logs, new RegExp(`port ${occupiedPort} is unavailable \\(EADDRINUSE\\)`))
  const health = await fetch(proxy.base.replace(/\/v1$/, "") + "/health")
  assert.equal(health.status, 200)
})

test("retries an upstream stream with no output before the first event", async (t) => {
  let calls = 0
  const proxy = await startProxy(async (request, response) => {
    await readRequestBody(request)
    calls += 1
    if (calls === 1) {
      writeCommandEvents(response, [{ type: "start" }])
      return
    }
    writeCommandEvents(response, textEvents("retried"))
  })
  t.after(() => proxy.close())

  const result = await proxyJson(proxy, "/v1/chat/completions", {
    model: "deepseek-flash",
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  })
  assert.equal(result.status, 200)
  assert.equal(JSON.parse(result.text).choices[0].message.content, "retried")
  assert.equal(calls, 2)
})

test("retries an empty stream without committing an SSE response", async (t) => {
  let calls = 0
  const proxy = await startProxy(async (request, response) => {
    await readRequestBody(request)
    calls += 1
    writeCommandEvents(response, calls === 1 ? [{ type: "start" }] : textEvents("stream retried"))
  })
  t.after(() => proxy.close())

  const result = await proxyJson(proxy, "/v1/chat/completions", {
    model: "deepseek-flash",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  })
  assert.equal(result.status, 200)
  assert.match(result.text, /stream retried/)
  assert.match(result.text, /\[DONE\]/)
  assert.equal(calls, 2)
})

test("finishes a stream even when upstream keeps the connection open", async (t) => {
  const heldResponses = []
  const proxy = await startProxy(async (request, response) => {
    await readRequestBody(request)
    heldResponses.push(response)
    writeCommandEvents(response, textEvents(), false)
  })
  t.after(() => proxy.close())

  const settled = await Promise.race([
    proxyJson(proxy, "/v1/chat/completions", {
      model: "deepseek-flash",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("proxy kept stream open")), 1500)),
  ])
  assert.equal(settled.status, 200)
  assert.match(settled.text, /\[DONE\]/)
  for (const response of heldResponses) response.end()
})

test("returns an error instead of an empty success after idle upstreams", async (t) => {
  const proxy = await startProxy(async (request, response) => {
    await readRequestBody(request)
    response.writeHead(200, { "content-type": "text/event-stream" })
  }, { CMDC_STREAM_IDLE_TIMEOUT_MS: "150" })
  t.after(() => proxy.close())

  const result = await proxyJson(proxy, "/v1/chat/completions", {
    model: "deepseek-flash",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  })
  assert.equal(result.status, 502)
  assert.match(result.text, /idle|empty completion/i)
})

test("keeps system text and removes think markers from all user history", async (t) => {
  let received
  const proxy = await startProxy(async (request, response) => {
    received = JSON.parse(await readRequestBody(request))
    writeCommandEvents(response, textEvents())
  })
  t.after(() => proxy.close())

  const result = await proxyJson(proxy, "/v1/chat/completions", {
    model: "deepseek-flash",
    messages: [
      { role: "system", content: "/no_think system text" },
      { role: "user", content: "/think old" },
      {
        role: "user",
        content: [
          { type: "text", text: "prefix" },
          { type: "text", text: "/no_think latest" },
        ],
      },
    ],
  })
  assert.equal(result.status, 200)
  assert.equal(received.params.system[0].text, "/no_think system text")
  assert.equal(received.params.messages[0].content[0].text, "old")
  assert.deepEqual(received.params.messages[1].content.map((part) => part.text), ["prefix", "latest"])
  assert.equal(received.params.reasoning_effort, "off")
})

test("preserves tool calls and rejects unsupported semantic options", async (t) => {
  const proxy = await startProxy(async (request, response) => {
    await readRequestBody(request)
    writeCommandEvents(response, [
      { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { q: "x" } },
      { type: "finish", finishReason: "tool_calls" },
    ])
  })
  t.after(() => proxy.close())

  const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }]
  const stream = await proxyJson(proxy, "/v1/chat/completions", {
    model: "deepseek-flash",
    stream: true,
    tools,
    messages: [{ role: "user", content: "lookup" }],
  })
  assert.equal(stream.status, 200)
  assert.match(stream.text, /"tool_calls"/)
  assert.match(stream.text, /"finish_reason":"tool_calls"/)

  const result = await proxyJson(proxy, "/v1/chat/completions", {
    model: "deepseek-flash",
    tools,
    messages: [{ role: "user", content: "lookup" }],
  })
  assert.equal(result.status, 200)
  const call = JSON.parse(result.text).choices[0].message.tool_calls[0]
  assert.equal(call.function.name, "lookup")

  const unsupported = await proxyJson(proxy, "/v1/chat/completions", {
    model: "deepseek-flash",
    n: 2,
    messages: [{ role: "user", content: "hi" }],
  })
  assert.equal(unsupported.status, 400)
  assert.match(unsupported.text, /unsupported_parameter/)
})

test("returns 404 for removed protocol routes and non-standard prefixes", async (t) => {
  const proxy = await startProxy(async (request, response) => {
    await readRequestBody(request)
    writeCommandEvents(response, textEvents())
  })
  t.after(() => proxy.close())

  for (const path of ["/v1/responses", "/v1/messages", "/foo/chat/completions"]) {
    const result = await proxyJson(proxy, path, { model: "x", messages: [] })
    assert.equal(result.status, 404)
  }
})

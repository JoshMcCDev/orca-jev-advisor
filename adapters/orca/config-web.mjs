import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const LOOPBACK = '127.0.0.1'
const ACTION_PATH = '/__jev/action'
const DOCTOR_PATH = '/__jev/doctor'
const MAX_BODY_BYTES = 256 * 1024
const RATE_WINDOW_MS = 10 * 1000
const RATE_LIMIT = 120

function sendJson (response, status, value) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(JSON.stringify(value))
}

async function readJsonBody (request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw new Error('request too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function isRecord (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeDoctorText (value, limit) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(TYPESAFE_API_KEY|API[_ -]?KEY)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(?:sk|jev)_[A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/\b[a-f0-9]{48,}\b/gi, '[redacted]')
    .trim()
    .slice(0, limit)
}

function safeDoctorResult (result) {
  if (!isRecord(result)) return { ok: false, checks: [] }
  const checks = Array.isArray(result.checks) ? result.checks.slice(0, 32).map((check) => ({
    id: typeof check?.id === 'string' && /^[a-z0-9-]{1,80}$/i.test(check.id) ? check.id : 'check',
    ok: check?.ok === true,
    detail: safeDoctorText(check?.detail, 1200)
  })) : []
  return { ok: result.ok === true, checks }
}

/**
 * Orca 1.4.235 panels cannot call plugin storage. This short-lived loopback
 * page serves the existing configuration UI in a normal Orca Browser tab and
 * forwards only its storage get/set actions back through the worker host.
 */
export async function startConfigWebServer ({ htmlPath, storageHost }) {
  const html = await readFile(htmlPath, 'utf8')
  const token = randomBytes(32).toString('hex')
  const requests = []
  let origin = null
  let doctorResult = { ok: false, checks: [] }

  const server = createServer((request, response) => {
    void (async () => {
      if (origin === null || request.headers.host !== origin.slice('http://'.length)) {
        sendJson(response, 403, { ok: false })
        return
      }

      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
          'Content-Type': 'text/html; charset=utf-8',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY'
        })
        response.end(html)
        return
      }

      if (request.method === 'POST' && request.url === DOCTOR_PATH) {
        if (request.headers.origin !== origin || request.headers.authorization !== `Bearer ${token}`) {
          sendJson(response, 403, { ok: false })
          return
        }
        sendJson(response, 200, doctorResult)
        return
      }

      if (request.method !== 'POST' || request.url !== ACTION_PATH) {
        sendJson(response, 404, { ok: false })
        return
      }

      if (request.headers.origin !== origin || request.headers.authorization !== `Bearer ${token}`) {
        sendJson(response, 403, { ok: false })
        return
      }

      const now = Date.now()
      while (requests.length > 0 && requests[0] <= now - RATE_WINDOW_MS) requests.shift()
      if (requests.length >= RATE_LIMIT) {
        sendJson(response, 429, { ok: false, errorCode: 'rate_limited' })
        return
      }
      requests.push(now)

      if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
        sendJson(response, 415, { ok: false })
        return
      }

      try {
        const message = await readJsonBody(request)
        if (!isRecord(message) || !isRecord(message.params) || typeof message.params.key !== 'string') {
          sendJson(response, 400, { ok: false })
          return
        }

        if (message.action === 'storage.get') {
          const value = await storageHost.get(message.params.key)
          sendJson(response, 200, { ok: true, value: { value } })
          return
        }
        if (message.action === 'storage.set' && Object.hasOwn(message.params, 'value')) {
          await storageHost.set(message.params.key, message.params.value)
          sendJson(response, 200, { ok: true })
          return
        }
        sendJson(response, 403, { ok: false })
      } catch {
        sendJson(response, 400, { ok: false })
      }
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { ok: false })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, resolve)
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve))
    throw new Error('loopback server did not receive a TCP address')
  }
  origin = `http://${LOOPBACK}:${address.port}`

  return {
    url: `${origin}/#jev-config=${token}`,
    setDoctorResult: (result) => { doctorResult = safeDoctorResult(result) },
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

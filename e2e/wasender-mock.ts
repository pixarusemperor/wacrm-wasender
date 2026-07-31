/**
 * WasenderApi mock server for E2E tests.
 *
 * Answers the exact documented WasenderApi shapes so the app's real
 * client code runs against it without external dependencies. Runs on
 * a fixed port (e.g. 3100) and is pointed at via WASENDER_BASE_URL.
 *
 * Endpoints (from wasenderapi.com/llms.txt):
 *   GET/POST /api/whatsapp-sessions
 *   POST /api/whatsapp-sessions/:id/connect
 *   GET  /api/whatsapp-sessions/:id/qrcode
 *   GET  /api/status
 *   POST /api/send-message
 *   POST /api/send-presence-update
 *   POST /api/decrypt-media
 *   GET  /api/groups
 *   GET  /api/groups/:jid/participants
 */

import http from 'http'

const SESSIONS = [
  {
    id: 1,
    name: 'E2E Session',
    phone_number: '+15550199',
    status: 'connected',
    account_protection: true,
    log_messages: true,
    api_key: 'e2e-session-key',
    webhook_secret: 'e2e-webhook-secret',
    webhook_url: null,
    webhook_enabled: false,
    webhook_events: [],
  },
  {
    id: 2,
    name: 'E2E Need Scan',
    phone_number: '+15550200',
    status: 'need_scan',
    account_protection: true,
    log_messages: true,
    api_key: 'e2e-session-key-2',
    webhook_secret: 'e2e-webhook-secret-2',
    webhook_url: null,
    webhook_enabled: false,
    webhook_events: [],
  },
]

const GROUPS = [
  { jid: '120363000001@g.us', name: 'E2E Group One', imgUrl: null },
  { jid: '120363000002@g.us', name: 'E2E Group Two', imgUrl: null },
]

const GROUP_PARTICIPANTS: Record<string, Array<{ id: string; admin?: string }>> = {
  '120363000001@g.us': [
    { id: '155501990001@s.whatsapp.net', admin: 'superadmin' },
    { id: '155501990002@s.whatsapp.net' },
  ],
  '120363000002@g.us': [{ id: '155501990003@s.whatsapp.net' }],
}

let msgCounter = 100000

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const path = url.pathname

  // Sessions list / create
  if (path === '/api/whatsapp-sessions' && req.method === 'GET') {
    return json(res, 200, { success: true, data: SESSIONS })
  }
  if (path === '/api/whatsapp-sessions' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      const session = {
        id: 99,
        name: parsed.name || 'New',
        phone_number: parsed.phone_number || '',
        status: 'need_scan',
        account_protection: true,
        log_messages: true,
        api_key: 'e2e-session-key-new',
        webhook_secret: 'e2e-webhook-secret-new',
        webhook_url: parsed.webhook_url || null,
        webhook_enabled: parsed.webhook_enabled || false,
        webhook_events: parsed.webhook_events || [],
      }
      SESSIONS.push(session as unknown as (typeof SESSIONS)[number])
      return json(res, 200, { success: true, data: session })
    })
    return
  }

  // Connect session → QR
  const connectMatch = path.match(/^\/api\/whatsapp-sessions\/(\d+)\/connect$/)
  if (connectMatch && req.method === 'POST') {
    return json(res, 200, {
      success: true,
      data: { status: 'NEED_SCAN', qrCode: '2@E2E_QR_CODE_PAYLOAD' },
    })
  }

  // QR code
  const qrMatch = path.match(/^\/api\/whatsapp-sessions\/(\d+)\/qrcode$/)
  if (qrMatch && req.method === 'GET') {
    return json(res, 200, { success: true, data: { qrCode: '2@E2E_QR_CODE_PAYLOAD' } })
  }

  // Session status
  if (path === '/api/status' && req.method === 'GET') {
    return json(res, 200, { status: 'connected' })
  }

  // Send message
  if (path === '/api/send-message' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      msgCounter++
      return json(res, 200, {
        success: true,
        data: { msgId: msgCounter, jid: parsed.to || '', status: 'in_progress' },
      })
    })
    return
  }

  // Presence
  if (path === '/api/send-presence-update' && req.method === 'POST') {
    return json(res, 200, { success: true, data: { jid: '', type: 'composing' } })
  }

  // Decrypt media
  if (path === '/api/decrypt-media' && req.method === 'POST') {
    return json(res, 200, {
      success: true,
      publicUrl: 'https://wasenderapi.test/decrypted-media/e2e',
    })
  }

  // Groups
  if (path === '/api/groups' && req.method === 'GET') {
    return json(res, 200, { success: true, data: GROUPS })
  }

  // Group participants
  const participantsMatch = path.match(/^\/api\/groups\/([^/]+)\/participants$/)
  if (participantsMatch && req.method === 'GET') {
    const jid = decodeURIComponent(participantsMatch[1])
    return json(res, 200, { success: true, data: GROUP_PARTICIPANTS[jid] ?? [] })
  }

  // Unknown
  return json(res, 404, { success: false, message: `Not found: ${req.method} ${path}` })
})

const PORT = Number(process.env.WASENDER_MOCK_PORT || 3100)
server.listen(PORT, () => {
  console.log(`[wasender-mock] listening on ${PORT}`)
})

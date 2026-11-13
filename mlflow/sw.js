// Demo service worker: answers the MLflow UI's server calls from demo-data.json,
// a snapshot recorded from a real MLflow server (see seed/capture.py).
// Reads return the closest recorded response; writes "succeed" but change nothing.
// Requests to other websites are blocked so the demo stays offline (no telemetry).

const SCOPE = new URL(self.registration.scope).pathname // e.g. "/mlflow-demo/"
const PASS = ['', 'index.html', 'sw.js', 'demo-data.json', 'demo.css']
let data

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

const load = () => (data ??= fetch(SCOPE + 'demo-data.json').then((r) => r.json()))

// Compare values ignoring object key order and long numbers (timestamps), so a
// "last 7 days" query made today still matches the one recorded on capture day.
const canon = (v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
    : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : JSON.stringify(v ?? null)
const norm = (v) => canon(v).replace(/\d{10,}/g, '#')
const same = (a, b) => norm(a) === norm(b)

function score(c, query, body) {
  let s = 0
  for (const [k, v] of query) if (c.q.some(([ck, cv]) => ck === k && same(cv, v))) s += 1
  if (c.q.length === query.length) s += 0.5
  if (body && typeof body === 'object' && c.body && typeof c.body === 'object') {
    for (const k of Object.keys(body)) if (same(body[k], c.body[k])) s += 1
  } else if (same(body, c.body)) s += 1
  if ((c.r.body ?? c.r.b64 ?? '').length > 2) s += 0.1 // on a tie, prefer a response with data
  return s
}

function respond(r) {
  const headers = { 'content-type': r.type || 'application/json' }
  if (r.b64) {
    const bin = atob(r.b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Response(bytes, { status: r.status, headers })
  }
  return new Response(r.body, { status: r.status, headers })
}

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

async function answer(req, path) {
  const { routes } = await load()
  const url = new URL(req.url)
  const query = [...url.searchParams]
  let body = null
  if (!['GET', 'HEAD'].includes(req.method)) {
    const text = await req.text()
    try { body = text ? JSON.parse(text) : null } catch { body = text }
  }
  const candidates = routes[`${req.method} ${path}`]
  if (candidates) {
    let best = candidates[0], top = -1
    for (const c of candidates) {
      const s = score(c, query, body)
      if (s > top) { top = s; best = c }
    }
    return respond(best.r)
  }
  if (req.method === 'GET') return json(404, { error_code: 'RESOURCE_DOES_NOT_EXIST', message: 'Not included in this demo.' })
  return json(200, {}) // create / update / delete: pretend it worked
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin) {
    e.respondWith(new Response(null, { status: 204 }))
    return
  }
  if (!url.pathname.startsWith(SCOPE)) return
  const path = url.pathname.slice(SCOPE.length)
  if (PASS.includes(path) || path.startsWith('static-files/')) return
  e.respondWith(answer(e.request, path))
})

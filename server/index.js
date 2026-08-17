// API HTTP fina à frente do Claude Code em modo headless.
//
// O n8n faz POST /jobs, recebe logo um job_id, e é avisado por callback quando
// a sessão termina. Nada bloqueia: uma sessão pode demorar 40 minutos sem que o
// nó HTTP do n8n dê timeout.
//
// Cada job corre `claude -p` num processo próprio, com o seu próprio workspace.
// O session_id devolvido pelo Claude fica gravado, o que permite continuar a
// conversa mais tarde com --resume.

import express from 'express'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const PORT = Number(process.env.PORT || 8080)
const WORK_DIR = process.env.WORK_DIR || '/work'
const JOBS_DIR = path.join(WORK_DIR, 'jobs')
const WORKSPACES_DIR = path.join(WORK_DIR, 'workspaces')
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || ''
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || Math.max(1, os.cpus().length - 2))
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || ''
const DEFAULT_EFFORT = process.env.DEFAULT_EFFORT || ''
const DEFAULT_MAX_BUDGET_USD = Number(process.env.DEFAULT_MAX_BUDGET_USD || 0)
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS || 60 * 60 * 1000)
const MCP_CONFIG = process.env.MCP_CONFIG || '/home/node/mcp.json'
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const KILL_GRACE_MS = 10_000
const STDERR_CAP = 64 * 1024
// Com autenticação por subscrição, bater na janela de 5 horas é rotina e não
// erro. Em vez de falhar, o job espera pelo reset e recomeça de onde ficou.
// Um MCP mal configurado NÃO faz o `claude -p` falhar: ele corre sem essas
// ferramentas e devolve um resultado plausível mas sem capacidades. O evento
// `system/init` é o único sítio onde isso aparece. Verificado em agosto de 2026.
const FAIL_ON_MCP_ERROR = process.env.FAIL_ON_MCP_ERROR !== 'false'
const RESCHEDULE_ON_RATE_LIMIT = process.env.RESCHEDULE_ON_RATE_LIMIT !== 'false'
const MAX_RESCHEDULES = Number(process.env.MAX_RESCHEDULES || 3)
const SWEEP_INTERVAL_MS = 30_000
// Margem depois do resetsAt, para não voltar a bater no limite por um segundo.
const RESET_MARGIN_MS = 60_000

/** @type {Map<string, object>} */
const jobs = new Map()
/** @type {string[]} */
const queue = []
/** @type {Map<string, import('node:child_process').ChildProcess>} */
const children = new Map()
let running = 0
let shuttingDown = false

const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---------------------------------------------------------------- helpers ----

/** Impede que um nome de workspace escape de WORKSPACES_DIR. */
function safeSlug(input) {
  const slug = String(input).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug || slug === '.' || slug === '..') throw new Error('workspace inválido')
  return slug.slice(0, 100)
}

async function persist(job) {
  const dir = path.join(JOBS_DIR, job.id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(job, null, 2))
}

/** Recarrega jobs do disco no arranque, para sobreviver a restarts do container. */
async function restore() {
  await fs.mkdir(JOBS_DIR, { recursive: true })
  await fs.mkdir(WORKSPACES_DIR, { recursive: true })
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const job = JSON.parse(await fs.readFile(path.join(JOBS_DIR, entry.name, 'job.json'), 'utf8'))
      // Um job que ficou a meio quando o container morreu não é retomável:
      // o processo desapareceu. Marca-o em vez de o deixar eternamente "running".
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'interrupted'
        job.error = 'Container reiniciou enquanto o job estava a correr'
        job.finished_at = new Date().toISOString()
      }
      // Já os que esperam pelo reset do limite sobrevivem ao restart: o sweeper
      // volta a pegar neles quando chegar a hora.
      jobs.set(job.id, job)
    } catch {
      /* ignora jobs corrompidos */
    }
  }
  log(`restaurados ${jobs.size} jobs do disco`)
}

/** Aviso intermédio, não terminal. Não substitui o callback final. */
async function notify(job, event) {
  if (!job.notify_url) return
  await fetch(job.notify_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(job.callback_headers || {}) },
    body: JSON.stringify({
      job_id: job.id, event, status: job.status, retry_at: job.retry_at,
      attempt: job.attempts, max_reschedules: job.max_reschedules,
      rate_limit: job.rate_limit, meta: job.meta,
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(err => log(`notify falhou para ${job.id}: ${err.message}`))
}

async function fireCallback(job) {
  if (!job.callback_url) return
  const body = JSON.stringify({
    job_id: job.id,
    status: job.status,
    session_id: job.session_id,
    workspace: job.workspace,
    result: job.result,
    error: job.error,
    cost_usd: job.cost_usd,
    num_turns: job.num_turns,
    duration_ms: job.duration_ms,
    terminal_reason: job.terminal_reason,
    mcp_servers: job.mcp_servers,
    meta: job.meta,
  })
  const headers = { 'content-type': 'application/json', ...(job.callback_headers || {}) }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(job.callback_url, { method: 'POST', headers, body,
        signal: AbortSignal.timeout(30_000) })
      if (res.ok) {
        job.callback_status = res.status
        await persist(job)
        return
      }
      job.callback_status = res.status
    } catch (err) {
      job.callback_error = String(err?.message || err)
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 3000))
  }
  log(`callback falhou para o job ${job.id}: ${job.callback_error || job.callback_status}`)
  await persist(job)
}

// ------------------------------------------------------------------ runner ----

function buildArgs(job) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
  ]
  // Numa sessão nova fixamos nós o id, para o session_id ser igual ao job_id e
  // não depender de o conseguirmos ler do stream. A retomar, o id vem do pedido.
  if (job.session_id_in) args.push('--resume', job.session_id_in)
  else args.push('--session-id', job.id)

  if (job.model) args.push('--model', job.model)
  if (job.effort) args.push('--effort', job.effort)
  // Travão de custo real. Não existe --max-turns no CLI.
  if (job.max_budget_usd) args.push('--max-budget-usd', String(job.max_budget_usd))
  if (existsSync(MCP_CONFIG)) {
    args.push('--mcp-config', MCP_CONFIG)
    // Ignora configurações de MCP herdadas do home do utilizador: o que corre é
    // exatamente o que está no ficheiro montado.
    args.push('--strict-mcp-config')
  }
  if (job.tools?.length) args.push('--tools', job.tools.join(','))
  if (job.allowed_tools?.length) args.push('--allowedTools', job.allowed_tools.join(','))
  if (job.disallowed_tools?.length) args.push('--disallowedTools', job.disallowed_tools.join(','))
  if (job.append_system_prompt) args.push('--append-system-prompt', job.append_system_prompt)
  // Faz o Claude devolver JSON validado contra um schema, em vez de texto livre.
  if (job.json_schema) args.push('--json-schema', JSON.stringify(job.json_schema))
  for (const dir of job.add_dirs || []) args.push('--add-dir', dir)
  if (job.extra_args?.length) args.push(...job.extra_args)
  return args
}

async function runJob(job) {
  job.status = 'running'
  job.started_at = new Date().toISOString()
  await fs.mkdir(job.workspace, { recursive: true })
  await persist(job)

  const logPath = path.join(JOBS_DIR, job.id, 'log.jsonl')
  const logStream = createWriteStream(logPath, { flags: 'a' })
  const args = buildArgs(job)
  log(`job ${job.id} arranca em ${job.workspace}`)

  const child = spawn(CLAUDE_BIN, args, {
    cwd: job.workspace,
    env: { ...process.env, ...(job.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.set(job.id, child)

  // O prompt vai por stdin em vez de argv: não tem limite de tamanho nem
  // problemas de escaping.
  child.stdin.write(job.prompt)
  child.stdin.end()

  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr += chunk.toString()
    if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP)
  })

  let resultEvent = null
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    logStream.write(line + '\n')
    let event
    try { event = JSON.parse(line) } catch { return }
    // O session_id aparece logo no evento de init; guardá-lo cedo garante que
    // conseguimos retomar mesmo que a sessão rebente a meio.
    if (event.session_id && !job.session_id) {
      job.session_id = event.session_id
      persist(job).catch(() => {})
    }
    // Único evento que reporta o estado dos MCPs. `failed` é definitivo;
    // `pending` significa apenas que um servidor stdio ainda estava a arrancar
    // quando este evento saiu, e não há atualização posterior no stream.
    if (event.type === 'system' && event.subtype === 'init') {
      job.mcp_servers = event.mcp_servers || []
      job.claude_version = event.claude_code_version || null
      const failed = job.mcp_servers.filter(s => s.status === 'failed').map(s => s.name)
      if (failed.length) {
        job.mcp_failed = failed
        log(`job ${job.id}: MCP não ligou -> ${failed.join(', ')}`)
        if (job.fail_on_mcp_error) {
          // Aborta já. Sem isto o job gasta a janela de utilização a produzir
          // um resultado que parece bom mas foi feito sem as ferramentas.
          job.mcp_aborted = true
          child.kill('SIGTERM')
          setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, KILL_GRACE_MS)
        }
      }
      persist(job).catch(() => {})
    }
    if (event.type === 'assistant') job.num_events = (job.num_events || 0) + 1
    // Com autenticação por subscrição, bater no limite de 5h é o modo de falha
    // mais comum e não vem no evento de result. Regista-o para o erro fazer
    // sentido a quem for ver.
    if (event.type === 'rate_limit_event' && event.rate_limit_info?.status !== 'allowed') {
      job.rate_limit = event.rate_limit_info
    }
    if (event.type === 'result') resultEvent = event
  })

  const timer = setTimeout(() => {
    job.timed_out = true
    log(`job ${job.id} excedeu ${job.timeout_ms}ms, a terminar`)
    child.kill('SIGTERM')
    setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, KILL_GRACE_MS)
  }, job.timeout_ms)

  const code = await new Promise(resolve => {
    child.on('error', err => { stderr += `\nspawn: ${err.message}`; resolve(-1) })
    child.on('close', resolve)
  })

  clearTimeout(timer)
  children.delete(job.id)
  await new Promise(r => logStream.end(r))
  rl.close()

  job.exit_code = code
  job.finished_at = new Date().toISOString()
  job.duration_ms = Date.parse(job.finished_at) - Date.parse(job.started_at)

  if (resultEvent) {
    job.result = resultEvent.result ?? null
    job.cost_usd = resultEvent.total_cost_usd ?? null
    job.num_turns = resultEvent.num_turns ?? null
    job.session_id = resultEvent.session_id || job.session_id
    job.result_subtype = resultEvent.subtype ?? null
    job.terminal_reason = resultEvent.terminal_reason ?? null
    if (resultEvent.permission_denials?.length) job.permission_denials = resultEvent.permission_denials
  }

  if (stderr.trim()) job.stderr = stderr.trim().slice(-4000)

  // MCP em falta é erro de configuração, não vale a pena reagendar nem retomar.
  if (job.mcp_aborted) {
    job.status = 'failed'
    job.error = `MCP não ligou: ${job.mcp_failed.join(', ')}. `
      + 'Verifica o mcp.json, as variáveis de ambiente que ele referencia e se o '
      + 'servidor exige OAuth interativo (não funciona em headless).'
    await persist(job)
    log(`job ${job.id} -> failed (MCP: ${job.mcp_failed.join(', ')})`)
    fireCallback(job).catch(() => {})
    return
  }

  // Limite de utilização: não é falha, é esperar a vez. O job volta à fila à
  // hora do reset e retoma a sessão em vez de recomeçar do zero.
  const hitRateLimit = job.rate_limit && !job.cancelled && !job.timed_out && job.status !== 'done'
  if (hitRateLimit && job.reschedule_on_rate_limit && job.attempts < job.max_reschedules) {
    job.attempts += 1
    // Margem mais um pouco de jitter: com várias instâncias a partilhar o mesmo
    // token, sem isto todas voltavam à carga no mesmo segundo e batiam outra vez.
    const jitter = Math.floor(Math.random() * 120_000)
    job.retry_at = new Date(job.rate_limit.resetsAt * 1000 + RESET_MARGIN_MS + jitter).toISOString()
    job.status = 'waiting_rate_limit'
    // Se já houve sessão, a retentativa continua-a. O trabalho feito não se perde.
    if (job.session_id) job.session_id_in = job.session_id
    await persist(job)
    log(`job ${job.id} bateu no limite, retoma em ${job.retry_at} (tentativa ${job.attempts}/${job.max_reschedules})`)
    // Aviso separado do callback: o callback principal só dispara no fim, senão
    // o nó Wait do n8n retomava o workflow a meio.
    notify(job, 'rate_limited').catch(() => {})
    return
  }

  if (job.cancelled) job.status = 'cancelled'
  else if (job.timed_out) { job.status = 'timeout'; job.error = `Excedeu ${job.timeout_ms}ms` }
  else if (code === 0 && resultEvent && !resultEvent.is_error) job.status = 'done'
  else {
    job.status = 'failed'
    job.error = job.rate_limit
      ? `Limite de utilização atingido (${job.rate_limit.rateLimitType}), reinicia em ${new Date(job.rate_limit.resetsAt * 1000).toISOString()}`
      : resultEvent?.result || stderr.trim().slice(-4000) || `claude terminou com código ${code}`
  }

  await persist(job)
  log(`job ${job.id} -> ${job.status} (${job.duration_ms}ms, $${job.cost_usd ?? '?'})`)
  fireCallback(job).catch(() => {})
}

/** Devolve à fila os jobs que estavam à espera do reset do limite. */
function sweepRateLimited() {
  if (shuttingDown) return
  const now = Date.now()
  for (const job of jobs.values()) {
    if (job.status !== 'waiting_rate_limit') continue
    if (!job.retry_at || Date.parse(job.retry_at) > now) continue
    job.status = 'queued'
    job.rate_limit = null
    queue.push(job.id)
    persist(job).catch(() => {})
    log(`job ${job.id} volta à fila depois do limite de utilização`)
  }
  pump()
}

function pump() {
  while (!shuttingDown && running < MAX_CONCURRENCY && queue.length > 0) {
    const job = jobs.get(queue.shift())
    if (!job || job.status !== 'queued') continue
    running++
    runJob(job)
      .catch(async err => {
        job.status = 'failed'
        job.error = String(err?.message || err)
        job.finished_at = new Date().toISOString()
        await persist(job).catch(() => {})
        fireCallback(job).catch(() => {})
      })
      .finally(() => { running--; pump() })
  }
}

// --------------------------------------------------------------------- api ----

const app = express()
app.use(express.json({ limit: '25mb' }))

app.get('/healthz', (_req, res) => {
  const waiting = [...jobs.values()].filter(j => j.status === 'waiting_rate_limit')
  res.json({
    ok: true,
    running,
    queued: queue.length,
    max_concurrency: MAX_CONCURRENCY,
    waiting_rate_limit: waiting.length,
    // Se isto estiver preenchido com frequência, a janela de 5h está a ficar
    // curta para o volume de trabalho.
    next_retry_at: waiting.map(j => j.retry_at).sort()[0] || null,
  })
})

app.use((req, res, next) => {
  if (!RUNNER_TOKEN) return next()
  const header = req.get('authorization') || ''
  if (header === `Bearer ${RUNNER_TOKEN}`) return next()
  res.status(401).json({ error: 'não autorizado' })
})

app.post('/jobs', async (req, res) => {
  const b = req.body || {}
  if (!b.prompt || typeof b.prompt !== 'string') {
    return res.status(400).json({ error: 'campo "prompt" obrigatório' })
  }
  if (shuttingDown) return res.status(503).json({ error: 'a desligar' })

  const id = randomUUID()
  let workspace
  try {
    workspace = b.workspace
      ? path.join(WORKSPACES_DIR, safeSlug(b.workspace))
      : path.join(JOBS_DIR, id, 'workspace')
  } catch (err) {
    return res.status(400).json({ error: String(err.message) })
  }

  const job = {
    id,
    status: 'queued',
    created_at: new Date().toISOString(),
    prompt: b.prompt,
    workspace,
    workspace_name: b.workspace || null,
    // session_id_in é o que pedimos retomar; session_id é o que o Claude devolveu.
    session_id_in: b.session_id || null,
    session_id: null,
    model: b.model || DEFAULT_MODEL || null,
    effort: b.effort || DEFAULT_EFFORT || null,
    max_budget_usd: Number(b.max_budget_usd) || DEFAULT_MAX_BUDGET_USD || null,
    tools: b.tools || null,
    allowed_tools: b.allowed_tools || null,
    disallowed_tools: b.disallowed_tools || null,
    append_system_prompt: b.append_system_prompt || null,
    json_schema: b.json_schema || null,
    add_dirs: Array.isArray(b.add_dirs) ? b.add_dirs.map(String) : null,
    extra_args: Array.isArray(b.extra_args) ? b.extra_args.map(String) : null,
    env: b.env && typeof b.env === 'object' ? b.env : null,
    timeout_ms: Number(b.timeout_ms) || DEFAULT_TIMEOUT_MS,
    callback_url: b.callback_url || null,
    callback_headers: b.callback_headers || null,
    // Avisos intermédios (por agora só "rate_limited"). Separado do callback,
    // que só dispara quando o job termina de vez.
    notify_url: b.notify_url || null,
    // Aborta se algum MCP declarado não ligar, em vez de correr sem ele.
    fail_on_mcp_error: b.fail_on_mcp_error ?? FAIL_ON_MCP_ERROR,
    reschedule_on_rate_limit: b.reschedule_on_rate_limit ?? RESCHEDULE_ON_RATE_LIMIT,
    max_reschedules: Number(b.max_reschedules) || MAX_RESCHEDULES,
    attempts: 0,
    retry_at: null,
    meta: b.meta ?? null,
  }

  jobs.set(id, job)
  queue.push(id)
  await persist(job)
  pump()

  res.status(202).json({ job_id: id, status: 'queued', workspace, position: queue.length })
})

app.get('/jobs', (req, res) => {
  const status = req.query.status
  const list = [...jobs.values()]
    .filter(j => !status || j.status === status)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, Number(req.query.limit) || 100)
    .map(({ prompt, env, callback_headers, ...rest }) => rest)
  res.json({ jobs: list, running, queued: queue.length })
})

app.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'job não encontrado' })
  const { env, callback_headers, ...safe } = job
  res.json(safe)
})

// Log completo da sessão em JSONL, um evento por linha. Útil para debug quando
// um job falha e a mensagem de erro não chega.
app.get('/jobs/:id/log', async (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'job não encontrado' })
  try {
    const content = await fs.readFile(path.join(JOBS_DIR, job.id, 'log.jsonl'), 'utf8')
    res.type('application/x-ndjson').send(content)
  } catch {
    res.status(404).json({ error: 'sem log' })
  }
})

app.post('/jobs/:id/cancel', async (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'job não encontrado' })
  if (job.status === 'queued' || job.status === 'waiting_rate_limit') {
    const i = queue.indexOf(job.id)
    if (i >= 0) queue.splice(i, 1)
    job.status = 'cancelled'
    job.retry_at = null
    job.finished_at = new Date().toISOString()
    await persist(job)
    return res.json({ job_id: job.id, status: job.status })
  }
  if (job.status === 'running') {
    job.cancelled = true
    const child = children.get(job.id)
    child?.kill('SIGTERM')
    setTimeout(() => { if (child && !child.killed) child.kill('SIGKILL') }, KILL_GRACE_MS)
    return res.json({ job_id: job.id, status: 'cancelling' })
  }
  res.status(409).json({ error: `job já está em ${job.status}` })
})

// ---------------------------------------------------------------- arranque ----

await restore()
sweepRateLimited()
const sweeper = setInterval(sweepRateLimited, SWEEP_INTERVAL_MS)
sweeper.unref?.()

const server = app.listen(PORT, () => {
  log(`claude-runner à escuta na porta ${PORT}, concorrência ${MAX_CONCURRENCY}`)
  if (!RUNNER_TOKEN) log('AVISO: RUNNER_TOKEN não definido, a API está aberta a quem chegar à rede')
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    log('AVISO: nem ANTHROPIC_API_KEY nem CLAUDE_CODE_OAUTH_TOKEN definidos')
  }
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1)
    shuttingDown = true
    log(`${signal} recebido, a terminar ${children.size} job(s)`)
    server.close()
    for (const child of children.values()) child.kill('SIGTERM')
    setTimeout(() => process.exit(0), KILL_GRACE_MS + 2000)
  })
}

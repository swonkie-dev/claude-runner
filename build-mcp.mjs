// Constrói o mcp.json a partir de variáveis de ambiente simples.
//
// Porquê assim e não um JSON dentro de uma variável: painéis de gestão
// reescrevem os valores que lhes passam. O do ZimaOS apaga as aspas do JSON e
// expande ${...} para vazio, mesmo com escape. Um par CHAVE=valor com texto
// simples sobrevive a isso; JSON não.
//
// Um servidor só entra se tiver a configuração de que precisa. Falta de
// credenciais significa ausência, não um servidor partido que faria o job
// abortar por FAIL_ON_MCP_ERROR.

import fs from 'node:fs'

const out = process.argv[2] || '/home/node/mcp.json'
const env = process.env
const val = k => (env[k] || '').trim()
const has = (...ks) => ks.every(k => val(k).length > 0)

// Se já vier com prefixo, não o duplica.
const bearer = v => (/^bearer\s/i.test(v) ? v : `Bearer ${v}`)

const servers = {}

// Não precisa de credenciais, está sempre disponível.
servers.playwright = { command: 'playwright-mcp', args: ['--headless', '--isolated'] }

if (has('SWONKIE_MCP_URL')) {
  servers.swonkie = { type: 'http', url: val('SWONKIE_MCP_URL') }
}
if (has('SWONKIE_BR_MCP_URL')) {
  servers['swonkie-br'] = { type: 'http', url: val('SWONKIE_BR_MCP_URL') }
}

// Endpoints atrás de Cloudflare Access partilham o mesmo service token.
const cf = has('CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET')
  ? {
      'CF-Access-Client-Id': val('CF_ACCESS_CLIENT_ID'),
      'CF-Access-Client-Secret': val('CF_ACCESS_CLIENT_SECRET'),
    }
  : {}

const viaN8n = (nome, urlKey, authKey) => {
  if (!has(urlKey)) return
  const headers = { ...cf }
  if (has(authKey)) headers.Authorization = bearer(val(authKey))
  servers[nome] = { type: 'http', url: val(urlKey), ...(Object.keys(headers).length ? { headers } : {}) }
}
viaN8n('teams', 'TEAMS_MCP_URL', 'TEAMS_AUTHORIZATION')
viaN8n('hievents', 'HIEVENTS_MCP_URL', 'HIEVENTS_AUTHORIZATION')

if (has('POSTHOG_API_KEY')) {
  servers.posthog = {
    type: 'http',
    url: val('POSTHOG_MCP_URL') || 'https://mcp.posthog.com/mcp',
    headers: { Authorization: bearer(val('POSTHOG_API_KEY')) },
  }
}

if (has('N8N_API_URL', 'N8N_API_KEY')) {
  servers.n8n = {
    command: 'n8n-mcp',
    env: { N8N_API_URL: val('N8N_API_URL'), N8N_API_KEY: val('N8N_API_KEY') },
  }
}

fs.writeFileSync(out, JSON.stringify({ mcpServers: servers }, null, 2))
console.log(`entrypoint: mcp.json gerado com ${Object.keys(servers).length} servidores: ${Object.keys(servers).join(', ')}`)

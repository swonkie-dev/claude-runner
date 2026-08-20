# claude-runner

Claude Code em modo headless, dentro de um container, disparável por HTTP.
Feito para ser chamado por um orquestrador como o n8n: mandas um prompt
completo, o agente executa tudo sem fazer perguntas, e o resultado volta por
callback. A sessão fica gravada e pode ser retomada depois.

```
n8n  --POST /jobs-------->  claude-runner
                              |  fila (MAX_CONCURRENCY)
                              |  1 processo `claude -p` por job
                              |  1 workspace por job
                              v
n8n  <--POST callback_url---  resultado + session_id
```

Não há segredos neste repositório. Tudo o que é credencial ou específico de uma
instalação entra em runtime pelo `.env`, que está no `.gitignore`.

## Arranque

A imagem é publicada no GHCR pelo GitHub Actions a cada push para `main`, em
`ghcr.io/swonkie-dev/claude-runner:latest`. Não é preciso construir nada.

```bash
# valores que tens de descobrir na tua máquina:
docker network ls                    # nome da rede onde vive o orquestrador
getent group render | cut -d: -f3    # GID para o RENDER_GID (GPU)

cp .env.example .env && $EDITOR .env
docker compose up -d
docker compose logs -f
```

Sem ficheiros na máquina, por painel gráfico: usa o
[`docker-compose.zimaos.yml`](docker-compose.zimaos.yml), que é autónomo. Não
precisa de repositório clonado, nem de `.env`, nem de `mcp.json`: tudo entra por
variáveis de ambiente.

Para desenvolver com build local:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Autenticação: define `CLAUDE_CODE_OAUTH_TOKEN` (subscrição, gerado com
`claude setup-token` numa sessão interativa) **ou** `ANTHROPIC_API_KEY`
(faturação por uso). Não definas as duas.

Teste rápido:

```bash
docker compose exec claude-runner curl -s -X POST localhost:8080/jobs \
  -H "Authorization: Bearer $RUNNER_TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"Cria hello.txt com a data de hoje e diz-me o que fizeste."}'
```

## API

Tudo autenticado com `Authorization: Bearer $RUNNER_TOKEN`, exceto `/healthz`.

| Método | Rota | O que faz |
|---|---|---|
| `POST` | `/jobs` | Enfileira um job. Devolve `202` com `job_id` de imediato. |
| `GET` | `/jobs/:id` | Estado e resultado de um job. |
| `GET` | `/jobs` | Lista (`?status=running`, `?limit=50`). |
| `GET` | `/jobs/:id/log` | Log completo da sessão em JSONL, um evento por linha. |
| `POST` | `/jobs/:id/cancel` | Cancela na fila ou mata o processo. |
| `GET` | `/healthz` | Sem auth. Estado da fila. |

### `POST /jobs`

```jsonc
{
  "prompt": "…",                    // obrigatório

  "workspace": "relatorios-mensais", // pasta persistente reutilizada entre jobs.
                                     // Sem isto, cada job tem pasta descartável.
  "session_id": "abc-123",           // continua uma sessão anterior

  "model": "opus",                   // alias (opus/sonnet/fable) ou nome completo
  "effort": "high",                  // low | medium | high | xhigh | max
  "max_budget_usd": 5,               // travão de custo (só com API key)
  "timeout_ms": 3600000,

  "mcp": ["swonkie", "playwright"],  // servidores MCP para ESTE job. Omitir = todos
  "tools": ["Bash", "Read", "Edit", "Write"],  // omitir = todas as built-in
  "disallowed_tools": ["mcp__hievents__hievents_refund_order"],
  "allowed_tools": [],               // NÃO restringe, ver aviso abaixo
  "add_dirs": ["/work/workspaces/outro"],
  "append_system_prompt": "…",
  "json_schema": { "type": "object", "properties": {} },

  "env": { "FOO": "bar" },           // variáveis extra só para este job
  "extra_args": [],                  // flags cruas do CLI, escape hatch

  "callback_url": "https://…/webhook/…",   // dispara no fim
  "notify_url": "https://…/webhook/…",     // avisos intermédios
  "callback_headers": { "X-Token": "…" },
  "reschedule_on_rate_limit": true,
  "max_reschedules": 3,
  "meta": { "task_id": "DEV-1234" }  // devolvido tal e qual no callback
}
```

Estados possíveis: `queued`, `running`, `waiting_rate_limit`, `done`, `failed`,
`timeout`, `cancelled`, `interrupted`.

O callback recebe:

```jsonc
{
  "job_id": "…", "status": "done",
  "session_id": "…",                 // guarda isto para continuar a conversa
  "result": "texto final do Claude",
  "error": null,
  "cost_usd": 0.42, "num_turns": 17, "duration_ms": 184000,
  "terminal_reason": "completed",
  "workspace": "/work/workspaces/relatorios-mensais",
  "meta": { "task_id": "DEV-1234" }
}
```

## Privilégio mínimo por job

O pedido declara o que aquele trabalho pode usar. É melhor do que restringir o
servidor MCP partilhado: não afeta mais ninguém, e fica explícito no workflow que
dispara em vez de escondido numa configuração global.

### Dois eixos independentes

| Campo | Controla | Tipo |
|---|---|---|
| `mcp` | que servidores MCP são ligados | allowlist |
| `tools` | que ferramentas built-in existem na sessão | allowlist |
| `disallowed_tools` | corta built-ins **e** ferramentas MCP | blocklist |

Um job com `"tools": ["Read"]` e `"mcp": ["swonkie"]` fica sem shell mas com todas
as ferramentas da Swonkie. Cortar built-ins não corta MCPs, e vice-versa.

```jsonc
{ "prompt": "…", "mcp": ["swonkie"], "tools": ["Read"] }   // só ler a Swonkie
{ "prompt": "…", "mcp": [] }                                // sem MCP nenhum
{ "prompt": "…", "tools": [] }                              // sem built-ins
{ "prompt": "…" }                                           // ver Defaults
```

`mcp` é a barreira mais forte das três: um servidor fora da lista **nem sequer é
ligado**, portanto não há prompt que lá chegue. Um nome desconhecido devolve
`400` com a lista dos disponíveis, em vez de correr em silêncio sem ferramentas
e devolver um resultado plausível mas oco.

### Descobrir os nomes das ferramentas

Os nomes válidos para `tools` dependem da versão do Claude Code e dos plugins
instalados. **Não copies listas de fora, pergunta ao teu container:**

```bash
docker exec <runner> claude -p "ok" --output-format stream-json --verbose \
  | head -1 | jq -r '.tools[]' | sort
```

As ferramentas MCP aparecem como `mcp__<servidor>__<ferramenta>` e só servem para
`disallowed_tools`; para as escolher, usa o `mcp`.

### Defaults: por omissão é tudo

Sem `DEFAULT_MCP` / `DEFAULT_TOOLS` definidos, um job que não declare nada recebe
**todos** os servidores MCP e **todas** as ferramentas, Bash e escrita incluídos.
É falhar em aberto, e num sistema que corre com `bypassPermissions` é o default
errado.

| Estado da variável | Significado |
|---|---|
| não definida | tudo |
| definida mas vazia | nenhum |
| com lista | exatamente essa lista |

Recomendado:

```bash
DEFAULT_MCP=
DEFAULT_TOOLS=Read
DEFAULT_DISALLOWED_TOOLS=
```

Assim o privilégio passa a ser **concedido**, não herdado: quem precisa de mais
declara-o no pedido, e isso fica visível no workflow. O runner avisa no arranque
quando estes defaults não estão definidos, e regista sempre o privilégio efetivo.

### O que funciona mesmo

Tudo verificado empiricamente contra o CLI, não deduzido da documentação:

| Mecanismo | Efeito | Aplica-se a |
|---|---|---|
| Âmbito da credencial | o servidor não **consegue** fazer a operação | tudo |
| `mcp: [...]` | o servidor nem é ligado | servidores MCP |
| `tools: [...]` | allowlist | built-ins |
| `disallowed_tools: [...]` | blocklist | built-ins e MCP |
| `allowed_tools: [...]` | **nenhum** | — |

> ⚠️ **`allowed_tools` não restringe nada em modo headless.** Testado com e sem
> `bypassPermissions`, e com as definições do utilizador desligadas: o modelo usou
> o Bash na mesma, sem uma única negação registada. É uma lista de *permissões*,
> não de capacidades. **Não o uses como barreira de segurança.**

### Quando o MCP expõe uma só ferramenta genérica

Filtrar ferramentas não serve de nada se o servidor expuser um único `exec` ou
`raw_api_request` que aceita qualquer operação. O MCP do PostHog é assim: tem uma
ferramenta só, portanto não há como permitir "apenas SQL" pela via das
ferramentas.

Aí a única barreira real é o **âmbito da credencial**. Uma chave de API só de
leitura torna a escrita impossível, por muito bem escrita que esteja a injeção.
Vale a pena criar credenciais dedicadas ao agente, separadas das pessoais: além
da segurança, passas a distinguir nos logs do serviço o que foi o agente.

Ordem de preferência, da barreira mais forte para a mais fraca:

1. **Âmbito da credencial** — o serviço recusa a operação.
2. **`mcp`** — o servidor não é ligado.
3. **`tools` / `disallowed_tools`** — a ferramenta não é oferecida ao modelo.
4. **Instruções no prompt** — uma sugestão forte, não um cadeado.

## Repositórios como contexto

O campo `repos` clona ou atualiza repositórios dentro do workspace **antes** de o
agente arrancar, usando o `GH_TOKEN` já configurado.

```jsonc
{
  "prompt": "…",
  "workspace": "site",
  "repos": ["swonkie-homepage", "swonkie-dev/landing-pages"],
  "tools": ["Read", "Bash", "Edit", "Write"]
}
```

Nome curto usa o `GITHUB_ORG`; com barra, o slug completo. O clone é raso
(`GIT_CLONE_DEPTH`, 50 por omissão) porque o histórico completo raramente serve e
custa minutos. Se o repositório já lá estiver, faz `fetch` e **não** mexe na
árvore de trabalho: trabalho por committar de um job anterior é do agente para
resolver, não meu para apagar em silêncio. Uma falha do git aborta o job com a
saída do git no erro, em vez de deixar o agente a trabalhar sem o código.

Combina com um `workspace` fixo para os clones sobreviverem entre jobs: o segundo
job passa a ser um `fetch` em vez de um clone.

### Os `CLAUDE.md` dos repositórios

Os repositórios que trazem `CLAUDE.md` e `.claude/memory/` carregam consigo as
convenções da equipa, que é metade do contexto que o agente precisa. Mas o
Claude Code descobre automaticamente o `CLAUDE.md` a partir do diretório de
trabalho **para cima**, e aqui os repositórios ficam abaixo dele.

Não contes com a descoberta automática. **Diz no prompt**, explicitamente:

> Antes de mexeres em `<repo>`, lê o `CLAUDE.md` e os ficheiros em
> `<repo>/.claude/memory/`. São as convenções da equipa e mandam sobre o que
> aqui está escrito.

Custa duas linhas e é determinístico.

## Limite de utilização e reagendamento

Com autenticação por subscrição, bater na janela de utilização é rotina, não
avaria. O runner deteta o `rate_limit_event` no stream e, em vez de falhar:

1. põe o job em `waiting_rate_limit` e grava o `retry_at`;
2. devolve-o à fila à hora do reset, mais um minuto de margem;
3. **retoma a sessão** em vez de recomeçar, portanto o trabalho já feito
   não se perde;
4. avisa o `notify_url`, se estiver definido. O `callback_url` **não** dispara
   aqui, senão o nó Wait do n8n retomaria o workflow a meio;
5. sobrevive a restarts, porque o `retry_at` está em disco.

Tecto de `max_reschedules` (3 por omissão) para nenhum job ficar em ciclo.
Desliga com `reschedule_on_rate_limit: false` ou `RESCHEDULE_ON_RATE_LIMIT=false`.

O `/healthz` expõe `waiting_rate_limit` e `next_retry_at`. Se estiverem
preenchidos com frequência, a janela está curta para o volume de trabalho.

## No n8n

O padrão que funciona sem timeouts:

1. **HTTP Request** → `POST http://claude-runner:8080/jobs`
   (o hostname é o nome do serviço; os containers têm de partilhar a rede)
   Header `Authorization: Bearer {{$env.RUNNER_TOKEN}}`.
2. **Wait** em modo *On Webhook Call*, com **HTTP Method: POST**. Põe o
   `$execution.resumeUrl` como `callback_url` no passo anterior.

   > ⚠️ **O `httpMethod` do Wait é `GET` por omissão e o runner faz `POST`.**
   > Se te esqueceres disto, o callback leva `404` com a mensagem
   > *"does not contain a waiting webhook with a matching path/method"*, o job
   > aparece `done` nos logs e o workflow fica preso à espera para sempre. É o
   > erro mais fácil de fazer e o mais difícil de adivinhar, porque tudo o resto
   > parece bem.
3. O workflow continua sozinho quando o job terminar, com o resultado no body.

Se preferires polling, troca o Wait por um loop com `GET /jobs/:id` e um Wait de
30s, mas o callback é mais limpo e não gasta execuções.

> ⚠️ **Não reescrevas o host do `$execution.resumeUrl`.** O n8n **assina** o URL
> de retoma (`?signature=...`) e a assinatura cobre o URL original. Trocar o host
> invalida-a e o n8n responde **404**, com o job a aparecer `done` nos logs e o
> workflow preso no Wait para sempre. Sem a assinatura responde **401**, o que
> ajuda a distinguir os casos.
>
> Se o domínio público não for alcançável de dentro da rede docker (hairpin NAT,
> DNS interno, proxy com autenticação), a solução **não** é mexer no URL: é
> mapear o nome para o IP interno no container do runner, mantendo o URL
> byte a byte igual ao que foi assinado.
>
> ```yaml
> extra_hosts:
>   - "n8n.exemplo.com:172.18.0.5"   # IP do container do orquestrador
> ```
>
> Diagnóstico, sem precisar de token:
>
> ```bash
> docker exec <runner> sh -c 'cat /work/jobs/<job_id>/job.json' \
>   | jq '{callback_url, callback_status, callback_error}'
> ```

**Conversas com continuidade:** guarda o `session_id` que vem no callback e
envia-o no job seguinte. Combina com `workspace` fixo para os ficheiros também
persistirem.

**Vale a pena um sub-workflow reutilizável** que faça o POST, espere pelo
callback e trate o erro. Cada automação nova passa a ser só um trigger mais um
prompt.

## O que está instalado

**Media e ficheiros:** ffmpeg (com VAAPI), ImageMagick, libvips, poppler,
ghostscript, qpdf, tesseract (por/eng/spa), exiftool, LibreOffice headless,
7zip, unzip, zstd.

**Python** (venv em `/opt/venv`, já no PATH): pandas, polars, numpy, pyarrow,
pillow, opencv-headless, scikit-image, pypdf, pdfplumber, pymupdf, openpyxl,
xlsxwriter, python-docx, python-pptx, beautifulsoup4, lxml, httpx, matplotlib,
yt-dlp, pydub, mutagen, markitdown, pytesseract, faster-whisper, fonttools e
brotli.

Os dois últimos existem para os pipelines de vídeo: o libass não lê `woff2` e a
fonte de marca não está instalada em máquina nenhuma, por isso a prática é
converter os `woff2` do repositório para TTF em runtime. Sem o **brotli** essa
conversão rebenta a descomprimir, e o sintoma aparece longe da causa, no vídeo a
sair sem legendas.

**Node:** o próprio Claude Code, playwright, tsx, typescript.

**Git:** git, git-lfs e o **GitHub CLI (`gh`)**, que se autentica sozinho a partir
do `GH_TOKEN`. Abrir um PR passa a ser `gh pr create` em vez de montar o pedido à
API com curl.

**Browser:** Chromium via Playwright, alcançável tanto pela API como pelo
binário `google-chrome`. Ver a secção Browser abaixo.

Tudo o resto o Claude instala em runtime: `pip install` e `npm i -g` funcionam
sem sudo, e os caches ficam no volume `claude-cache`, portanto a segunda vez é
rápida. Não vale a pena inchar a imagem com bibliotecas que talvez nunca use.

## Browser

A imagem traz o seu próprio Chromium, em `PLAYWRIGHT_BROWSERS_PATH`
(`/home/node/browsers`), partilhado por qualquer projeto que o Claude crie dentro
do container. Para firefox e webkit também:
`PLAYWRIGHT_BROWSERS="chromium firefox webkit"` e rebuild.

> ⚠️ **O browser não pode viver dentro de um volume montado.** O
> `PLAYWRIGHT_BROWSERS_PATH` esteve em `/home/node/.cache/ms-playwright`, que é
> precisamente onde o compose monta o volume `claude-cache`. Um volume só é
> povoado a partir da imagem quando está **vazio**: assim que existe de uma
> versão anterior, nunca mais é atualizado. O Chromium que a imagem instalou fica
> tapado e **desaparece sem erro nenhum**.
>
> Foi medido, não deduzido: uma imagem construída com chromium a servir jobs sem
> browser nenhum, e o sintoma a aparecer longe da causa, num gerador de imagens a
> devolver `spawn google-chrome ENOENT`.
>
> Por isso o caminho passou para `/home/node/browsers`, que não é ponto de
> montagem de nada. Uma atualização da imagem chega para corrigir, sem mexer em
> volumes. O `claude-cache` fica com o que deve mesmo ser cache: pip e npm.
>
> O entrypoint verifica isto no arranque e avisa alto se não houver browser, em
> vez de deixar a falha aparecer só quando alguém pedir uma imagem:
>
> ```
> entrypoint: AVISO, nao ha Chromium em /home/node/.cache/ms-playwright.
> entrypoint: esse caminho esta dentro do volume claude-cache, que tapa o que
> entrypoint: a imagem instalou.
> ```

**`google-chrome` está no PATH.** Muito gerador de imagem não usa a API do
Playwright: invoca o binário do Chrome à mão, tipicamente

```js
execFile(process.env.CHROME_BIN || 'google-chrome',
         ['--headless', '--no-sandbox', `--screenshot=${dst}`, html]);
```

Sem um binário com esse nome, uma imagem que **tem** Chromium instalado responde
`ENOENT` a quem lhe pede um browser, e o erro não diz nada sobre o que falta. Por
isso a imagem instala um shim em `google-chrome` (mais os aliases `chrome`,
`chromium` e `chromium-browser`) e define `CHROME_BIN` e
`PUPPETEER_EXECUTABLE_PATH` a apontar para ele.

O shim resolve o caminho real **em runtime**, porque esse caminho leva o número
de revisão lá dentro (`chromium-1187/chrome-linux/chrome`) e muda a cada
atualização. Gravá-lo na imagem partiria no dia em que alguém corresse
`playwright install` dentro da sessão. Sem browser local (modo browserless), o
shim sai com 127 e diz porquê, em vez de simplesmente não existir.

**Alternativa: ligar a um browserless externo.** Se já tens um browserless na
rede, podes dispensar o browser local (`PLAYWRIGHT_BROWSERS=` vazio) e apontar o
`BROWSERLESS_WS` para ele, acrescentando `--cdp-endpoint ${BROWSERLESS_WS}` aos
argumentos do MCP do Playwright. Em código o equivalente é
`chromium.connectOverCDP(process.env.BROWSERLESS_WS)`.

Antes de o fazer, verifica três coisas, porque é aqui que isto costuma
desiludir:

```bash
docker run --rm --network <rede> curlimages/curl:latest \
  -s http://<browserless>:3000/json/version
docker inspect <browserless> --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -iE 'token|concurr|timeout'
```

- **Versão do Chrome.** Instâncias de browserless ficam esquecidas durante anos.
  Um Chrome muito mais antigo do que o cliente Playwright não fala o mesmo CDP,
  e sites atuais renderizam mal. `connectOverCDP` é tolerante a diferenças
  pequenas, não a anos.
- **`CONNECTION_TIMEOUT`.** No browserless v1 é o tempo máximo que uma sessão
  pode ficar ligada, e o default é baixo. Sobrepõe-se por ligação com
  `?timeout=600000` na URL, sem alterar o default partilhado.
- **Contenção.** Um browserless partilhado com workflows de produção significa
  que uma sessão do agente compete com eles pelo mesmo pool.

Para scraping simples serve bem. Para testes de Playwright, o browser local é
melhor: é atual, está isolado, e os ~500MB são irrelevantes num disco decente.

## ZimaOS

**Instala pelo painel, com a imagem pública do GHCR.** App Store → *Install a
customized app* → *Import*, e cola o
[`docker-compose.zimaos.yml`](docker-compose.zimaos.yml). Não precisa de SSH,
nem de repositório clonado, nem de ficheiros na máquina.

Isto contorna o [problema conhecido do ZimaOS com registries
privados](https://community.zimaspace.com/t/installing-a-customized-app-from-private-registry/6218),
onde a instalação pelo dashboard dá erro de autorização: sendo a imagem
**pública**, não há autenticação nenhuma envolvida. A imagem não contém
segredos, todas as credenciais entram em runtime.

Duas condições para a dashboard mostrar a app corretamente:

- o compose tem de ter o campo `name` no topo (já tem), senão aparece como
  parado mesmo a correr;
- se ainda assim aparecer mal, abre as definições da app na UI e dá-lhe título.

**O pacote no GHCR nasce privado, mesmo num repositório público.** Depois da
primeira corrida do workflow, vai a *Packages* → `claude-runner` → *Package
settings* → *Change visibility* → **Public**. Uma vez só. Sem isso o ZimaOS não
consegue puxar a imagem.

**Não uses ZVM.** O [passthrough de GPU não é suportado nas VMs do
ZimaOS](https://github.com/IceWhaleTech/ZimaOS/issues/167), o que deixa o ffmpeg
em CPU puro. E uma VM configurada à mão não deixa receita, que é precisamente o
que este repositório existe para evitar.

## Aceleração por hardware (VAAPI)

O `RENDER_GID` no `.env` tem de bater certo com o dono de
`/dev/dri/renderD128` no host (`getent group render | cut -d: -f3`), senão o
ffmpeg cai para CPU **em silêncio**, sem erro nenhum.

Confirmar depois do arranque:

```bash
docker compose exec claude-runner vainfo
```

Deve listar `VAProfileH264*` e `VAProfileHEVC*` com `VAEntrypointEncSlice`. Se
só aparecerem entradas de decode, ficou o driver livre em vez do `non-free`. Se
der `vaInitialize failed`, é o `RENDER_GID` errado ou o `/dev/dri` não mapeado.

A imagem instala `intel-media-va-driver-non-free` e força `LIBVA_DRIVER_NAME=iHD`,
que é o driver correto para Intel Gen9 e mais recente. Para AMD, troca por
`mesa-va-drivers` e remove o `LIBVA_DRIVER_NAME`.

```bash
ffmpeg -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 \
  -hwaccel_output_format vaapi -i entrada.mp4 \
  -c:v h264_vaapi -b:v 4M saida.mp4
```

Para transcode de 1080p a iGPU dá um ganho grande; para filtros complexos o CPU
costuma ganhar.

## Notas e armadilhas

**Root.** O Claude Code recusa-se a arrancar com `bypassPermissions` como root,
mesmo dentro de um container. Por isso corre como o utilizador `node`. Se
mexeres no Dockerfile, não voltes a pôr `USER root` no fim.

**shm do Chromium.** O `shm_size: 1gb` no compose não é decorativo. Sem ele o
Playwright rebenta com `Target closed` em páginas pesadas.

## MCPs

O `mcp.json` vive em `/home/node/mcp.json` e é passado a cada job com
`--mcp-config` e `--strict-mcp-config`, o que ignora qualquer configuração de
MCP herdada do home. É a única fonte de verdade.

**O container monta-o sozinho a partir de variáveis simples**, no arranque.
Defines `SWONKIE_MCP_URL`, `TEAMS_MCP_URL`, `POSTHOG_API_KEY` e companhia, e o
`build-mcp.mjs` gera o ficheiro. Um servidor sem os valores preenchidos é
**omitido**, não fica meio configurado a fazer abortar os jobs.

| Servidor | Variáveis |
|---|---|
| `playwright` | nenhuma, está sempre presente |
| `swonkie` / `swonkie-br` | `SWONKIE_MCP_URL` / `SWONKIE_BR_MCP_URL` |
| `teams` | `TEAMS_MCP_URL`, `TEAMS_AUTHORIZATION` |
| `hievents` | `HIEVENTS_MCP_URL`, `HIEVENTS_AUTHORIZATION` |
| `posthog` | `POSTHOG_API_KEY`, opcionalmente `POSTHOG_MCP_URL` |
| `n8n` | `N8N_API_URL` + `N8N_API_KEY` |

Endpoints atrás de Cloudflare Access herdam `CF_ACCESS_CLIENT_ID` e
`CF_ACCESS_CLIENT_SECRET`. O prefixo `Bearer` é acrescentado se faltar e não é
duplicado se já lá estiver.

> ⚠️ **Não uses uma variável com o JSON completo lá dentro.** Existe um escape
> hatch, `MCP_CONFIG_JSON`, mas painéis de gestão reescrevem os valores que lhes
> passam: o do ZimaOS **apaga as aspas do JSON e expande `${...}` para vazio**,
> mesmo com `$$`. O container deteta e recusa-se a arrancar, mas o problema
> repete-se a cada edição. Variáveis simples sobrevivem a isso; JSON não. Foi
> por isto que o desenho mudou.

**`${VARIAVEL}` é expandido** a partir do ambiente do container, tanto em `url`
como em `args` e `env`. Verificado empiricamente. Portanto os segredos ficam no
`.env` e o `mcp.json` pode ser lido por qualquer pessoa.

**Um MCP que não liga não faz o job falhar.** Esta é a armadilha grande: com uma
URL errada ou um token inválido, o `claude -p` corre à mesma, sem as
ferramentas, e devolve um resultado plausível com exit 0. Nada no output se
queixa. O único sítio onde isso aparece é o evento `system/init` do
`stream-json`, que traz `mcp_servers: [{name, status}]`.

O runner lê esse evento e, se algum servidor vier com `status: "failed"`, aborta
o job de imediato com um erro explícito, em vez de o deixar gastar a janela de
utilização a produzir trabalho sem capacidades. Desliga com
`FAIL_ON_MCP_ERROR=false` ou `fail_on_mcp_error: false` no job. O estado de
todos os servidores vai no callback, em `mcp_servers`.

Nota sobre `status`: `failed` é definitivo, mas `pending` significa apenas que
um servidor stdio ainda estava a arrancar quando o evento saiu. Não há
atualização posterior no stream, por isso só se atua sobre `failed`.

**Pré-instala os servidores stdio na imagem.** Um `npx -y pacote@latest` no
`mcp.json` é pago no arranque de **cada job**, e passa a depender de a npm estar
de pé. A imagem já traz `playwright-mcp` e `n8n-mcp` no PATH; acrescenta os que
precisares no Dockerfile e chama o binário em vez de `npx`.

**OAuth interativo não funciona.** Só servidores que autentiquem por token, em
variável de ambiente ou na URL. Não há browser para completar o fluxo. Para os
que só fazem OAuth (Meta Ads, e por omissão ClickUp e Stripe), expõe as
operações de que precisas através de um MCP Server Trigger do n8n, que já guarda
essas credenciais. O orquestrador passa a ser também o cofre, e ganhas de
caminho o controlo de exatamente que operações o agente pode invocar.

**Dá-lhe tokens próprios.** Não reutilizes as tuas credenciais pessoais. Um
token por serviço, com o âmbito mínimo, dá-te revogação individual e um registo
de auditoria que distingue o agente de ti.

**Prompt autónomo.** Como não há ninguém para responder, vale a pena acrescentar
ao prompt (ou a um `CLAUDE.md` no workspace) qualquer coisa como: *"Estás a
correr de forma autónoma, ninguém pode responder a perguntas. Decide tu e
continua. Só termina o turno quando a tarefa estiver completa."*

**Devolver dados estruturados.** Em vez de fazer parsing do texto livre que vem
em `result`, passa um `json_schema` no job. O Claude valida a resposta contra o
schema e o `result` vem já em JSON. Poupa um nó de Code e falha alto em vez de
silenciosamente.

**Segurança.** `bypassPermissions` significa mesmo tudo: o container é o sandbox.
Não montes o socket do Docker, não lhe dês credenciais que não sejam
estritamente necessárias, e mantém o `RUNNER_TOKEN` definido. Conteúdo que o
agente leia (um website, um issue do GitHub) pode conter prompt injection e
executa com os privilégios que lhe deres. Para ações que saem para fora
(publicar, enviar, apagar), a mitigação certa não é isolamento adicional, é
privilégio mínimo e um humano a aprovar: o agente cria em rascunho, uma pessoa
promove.

**Flags do CLI.** O `buildArgs()` em `server/index.js` constrói a linha de
comando. As flags foram verificadas contra `claude --help` em agosto de 2026. O
CLI evolui depressa, por isso se algum job falhar logo no arranque, confirma com
`docker compose exec claude-runner claude --help` antes de procurar noutro lado.
Nota: **não existe `--max-turns`**; o travão de custo é `--max-budget-usd`.

## Estado

Verificado sem servidor:

- Sintaxe do `server/index.js`, do `docker-compose.yml` e do Dockerfile
  (`docker build --check`, sem avisos).
- Flags do CLI contra `claude --help` (corrigiu um `--max-turns` inexistente).
- Formato do `stream-json`: os campos que o wrapper lê do evento `result`
  (`result`, `session_id`, `total_cost_usd`, `num_turns`, `is_error`,
  `terminal_reason`) existem e têm os nomes usados.
- `--cdp-endpoint` existe no `@playwright/mcp`.

Por validar, precisa da máquina: o build da imagem, o `vainfo` a detetar a
iGPU, o Playwright a abrir uma página, e um job ponta a ponta com callback.

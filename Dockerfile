# Claude Code como serviço headless, disparável pelo n8n.
#
# Filosofia da imagem: traz os *binários de sistema* que não se instalam bem em
# runtime (ffmpeg, tesseract, libreoffice, poppler, browsers) mais um núcleo de
# bibliotecas Python que aparecem em quase todos os jobs. Tudo o resto o Claude
# instala sozinho durante a sessão, com pip e npm já configurados para escrever
# sem sudo.

FROM node:22-bookworm-slim

ARG WITH_LIBREOFFICE=true
ARG WITH_WHISPER=true
# Browser próprio dentro do container. Alternativa considerada e rejeitada:
# ligar por CDP ao `browserless` da rede `n8n`, que corre HeadlessChrome/121
# (janeiro de 2024) com um limite de 60s por sessão e partilhado com produção.
# Velho demais para o Playwright atual. Ver o README, secção Browser.
# Vazio = sem browser local, usa o BROWSERLESS_WS.
ARG PLAYWRIGHT_BROWSERS=chromium

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ---------------------------------------------------------------- sistema ----
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg openssh-client \
      git git-lfs \
      build-essential pkg-config \
      python3 python3-venv python3-dev \
      ffmpeg \
      imagemagick libvips-tools \
      poppler-utils ghostscript qpdf \
      tesseract-ocr tesseract-ocr-por tesseract-ocr-eng tesseract-ocr-spa \
      libimage-exiftool-perl \
      unzip zip p7zip-full xz-utils zstd bzip2 \
      jq ripgrep fd-find sqlite3 \
      file libmagic1 libglib2.0-0 \
      fonts-dejavu fonts-liberation fonts-noto-color-emoji \
      tzdata procps less nano \
  && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# Aceleração por hardware da GPU integrada (VAAPI). O ffmpeg do Debian já vem
# com VAAPI compilado; falta o driver do lado do userspace.
#
# Assume GPU integrada Intel (Gen9 ou mais recente), que usa o driver iHD. A
# variante com suporte completo de encode vive no componente `non-free` do
# Debian, que não está ativo na imagem base do node. O pacote
# `intel-media-va-driver` (livre) instala e arranca, mas fica com menos codecs
# de encode, que é precisamente o que interessa para transcodificar vídeo.
# Para AMD: troca por `mesa-va-drivers` e remove o LIBVA_DRIVER_NAME abaixo.
# A imagem base usa o formato deb822 em /etc/apt/sources.list.d/debian.sources,
# com `Signed-By` definido. Acrescentar uma segunda fonte para o mesmo
# repositório sem esse campo dá "Conflicting values set for option Signed-By" e
# o apt recusa-se a ler a lista toda. Por isso acrescentam-se os componentes à
# fonte existente, em vez de se criar outra.
RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' \
      /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends \
      intel-media-va-driver-non-free \
      libva-drm2 libva2 vainfo intel-gpu-tools \
  && rm -rf /var/lib/apt/lists/*

# Sem isto o libva pode escolher o driver legado i965, que não serve para Gen12.
ENV LIBVA_DRIVER_NAME=iHD

# GitHub CLI. O agente usa-o para abrir Pull Requests; sem ele tem de montar o
# pedido à API com curl, que é o passo que falha mais vezes. Autentica-se sozinho
# a partir do GH_TOKEN que já está no ambiente, não precisa de `gh auth login`.
# A fonte traz `signed-by`, por isso não colide com a fonte deb822 da imagem base.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# O Debian bloqueia PDF e PostScript no ImageMagick por omissão (CVE-2016-3714).
# Dentro deste container o sandbox é o próprio container, e sem isto metade das
# conversões de PDF falha com "not authorized".
RUN for p in /etc/ImageMagick-6/policy.xml /etc/ImageMagick-7/policy.xml; do \
      [ -f "$p" ] && sed -i -E 's/rights="none" pattern="(PDF|PS|EPS|XPS)"/rights="read|write" pattern="\1"/g' "$p" || true; \
    done

# LibreOffice headless: converte docx/xlsx/pptx/odt para PDF e entre si.
# Pesa ~450MB. Desliga com --build-arg WITH_LIBREOFFICE=false.
RUN if [ "$WITH_LIBREOFFICE" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
        default-jre-headless \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# ------------------------------------------------------------------ python ----
# venv em /opt/venv, com dono `node`, para o Claude poder fazer pip install
# durante a sessão sem privilégios.
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

RUN pip install --upgrade pip setuptools wheel && pip install \
      numpy pandas polars pyarrow \
      pillow opencv-python-headless scikit-image imageio imageio-ffmpeg \
      pypdf pdfplumber pymupdf pdf2image \
      openpyxl xlsxwriter python-docx python-pptx odfpy xlrd \
      beautifulsoup4 lxml html5lib httpx requests \
      matplotlib \
      yt-dlp mutagen pydub \
      python-magic filetype chardet \
      markitdown \
      pytesseract \
      tabulate rich python-dateutil tqdm

# Transcrição de áudio. faster-whisper corre em CPU via CTranslate2, sem torch
# (~250MB em vez de ~2.5GB). Os modelos descarregam no primeiro uso.
RUN if [ "$WITH_WHISPER" = "true" ]; then pip install faster-whisper; fi

# --------------------------------------------------------------- browsers -----
# Só corre se PLAYWRIGHT_BROWSERS não estiver vazio. Vazio significa usar um
# browserless externo, e nesse caso não há browser local para preparar.
RUN if [ -n "$PLAYWRIGHT_BROWSERS" ]; then npx -y playwright@latest install-deps ${PLAYWRIGHT_BROWSERS}; fi

# ------------------------------------------------------------------- node -----
# npm global no home do utilizador, para o Claude poder `npm i -g` sem sudo
# e para o auto-update do próprio Claude Code funcionar.
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global \
    PATH=/home/node/.npm-global/bin:/opt/venv/bin:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright

RUN mkdir -p /home/node/.npm-global /home/node/server /home/node/.cache /work \
 && chown -R node:node /home/node /opt/venv /work

# IMPORTANTE: o Claude Code recusa-se a arrancar com bypassPermissions como root.
USER node
WORKDIR /home/node

RUN npm install -g @anthropic-ai/claude-code playwright tsx typescript

# Servidores MCP stdio pré-instalados. Sem isto, cada job pagaria um
# `npx -y ...@latest` no arranque (dezenas de segundos, mais uma dependência da
# npm estar de pé). Assim os binários já estão no PATH: `playwright-mcp` e
# `n8n-mcp`. Acrescenta aqui os que precisares e referencia o binário no
# mcp.json em vez de npx.
RUN npm install -g @playwright/mcp n8n-mcp

# Só se pediram browsers locais. A biblioteca `playwright` instalada acima entra
# sempre, porque é ela que faz o connectOverCDP ao browserless.
RUN if [ -n "$PLAYWRIGHT_BROWSERS" ]; then playwright install ${PLAYWRIGHT_BROWSERS}; fi

# --------------------------------------------------------------- wrapper ------
COPY --chown=node:node server/package.json /home/node/server/
RUN cd /home/node/server && npm install --omit=dev
COPY --chown=node:node server/index.js /home/node/server/
COPY --chown=node:node entrypoint.sh /home/node/entrypoint.sh
COPY --chown=node:node build-mcp.mjs /home/node/build-mcp.mjs
# Configuração mínima de MCPs, substituída em runtime por MCP_CONFIG_JSON.
COPY --chown=node:node mcp.default.json /home/node/mcp.json
RUN chmod +x /home/node/entrypoint.sh

ENV CLAUDE_CONFIG_DIR=/home/node/.claude \
    WORK_DIR=/work \
    PORT=8080 \
    NODE_ENV=production \
    # Browser partilhado na rede `n8n`. O ?timeout= sobrepõe-se ao
    # CONNECTION_TIMEOUT de 60s do browserless. Ver o README.
    BROWSERLESS_WS=ws://browserless:3000?timeout=600000

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/home/node/entrypoint.sh"]
CMD ["node", "/home/node/server/index.js"]

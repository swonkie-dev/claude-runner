#!/bin/sh
# Configura o git antes de arrancar o servidor. Corre como o utilizador `node`.
set -e

# Configuração dos MCPs por variável de ambiente, para o deploy poder ser feito
# inteiramente por um painel, sem ficheiros na máquina anfitriã. Se
# MCP_CONFIG_JSON estiver definida, escreve-a; senão fica o ficheiro que veio na
# imagem (só o playwright).
MCP_CONFIG="${MCP_CONFIG:-/home/node/mcp.json}"
if [ -n "$MCP_CONFIG_JSON" ]; then
  printf '%s' "$MCP_CONFIG_JSON" > "$MCP_CONFIG"
  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$MCP_CONFIG"; then
    echo "entrypoint: MCP_CONFIG_JSON não é JSON válido, a abortar." >&2
    exit 1
  fi
  echo "entrypoint: mcp.json escrito a partir de MCP_CONFIG_JSON"
fi

git config --global init.defaultBranch main
# Os repositórios são clonados para volumes; sem isto o git recusa-se a operar
# neles quando o owner não bate certo.
git config --global --add safe.directory '*'

[ -n "$GIT_AUTHOR_NAME" ]  && git config --global user.name  "$GIT_AUTHOR_NAME"
[ -n "$GIT_AUTHOR_EMAIL" ] && git config --global user.email "$GIT_AUTHOR_EMAIL"

# Autenticação no GitHub por HTTPS. O helper lê a variável de ambiente na hora,
# em vez de gravar o token em ~/.git-credentials em texto simples.
if [ -n "$GH_TOKEN" ]; then
  git config --global credential."https://github.com".helper \
    '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'

  # Os repositórios costumam ter remote SSH (git@github.com:org/repo.git), e
  # aqui dentro não há chave SSH. Reescrever para HTTPS faz o token funcionar
  # mesmo quando o agente copia uma URL SSH de um README.
  git config --global url."https://github.com/".insteadOf "git@github.com:"
  git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
fi

# NÃO definir core.hooksPath aqui. Isso sobrepõe-se aos hooks dos repositórios
# (husky), e os gates de pre-commit são obrigatórios: contorná-los deixa passar
# código que não compila. A proteção de branches vive no GitHub, não aqui.

# Sem argumentos, arranca o servidor à mesma. Alguns painéis (o importador do
# ZimaOS, por exemplo) escrevem `command: []` no compose, o que apaga o CMD da
# imagem. Sem esta rede de segurança o `exec "$@"` não executava nada, o script
# terminava, o container saía com código 0 e o `restart: unless-stopped`
# reiniciava-o para sempre, sem nunca dar um erro que explicasse porquê.
if [ "$#" -eq 0 ]; then
  echo "entrypoint: sem argumentos (CMD apagado pelo orquestrador?), a arrancar o servidor"
  set -- node /home/node/server/index.js
fi

echo "entrypoint: a executar -> $*"
exec "$@"

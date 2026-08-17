#!/bin/sh
# Configura o git antes de arrancar o servidor. Corre como o utilizador `node`.
set -e

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

exec "$@"

#!/bin/sh
# Runs the fixcrash hook (src/hook.ts) with Node 24+, which runs TypeScript as is.
# Without Node 24 the hook can't check anything, so it blocks what it guards:
# pull requests and writes to .git/fixcrash. Everything else goes through.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 24 ]; then
  exec node "$here/../src/hook.ts"
fi
input=$(cat)
case "$input" in
  *"pr create"*|*pull-request*|*pull_request*|*"/pulls"*|*".git/fixcrash"*)
    echo "fixcrash: Node.js 24 or newer is needed to check this action, so it is blocked" >&2
    exit 2
    ;;
esac
exit 0

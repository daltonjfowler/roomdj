#!/usr/bin/env bash
# Secret guard: refuses to let credentials get committed. Catches both known
# provider tokens (Stripe, Google, AWS, GitHub, Slack, Anthropic, private keys)
# AND custom secrets by name (SESSION_SECRET, BACKUP_KEY, api_key = "…") that
# GitHub's own scanner won't know about.
#
#   bash scripts/secret-scan.sh            # scan STAGED changes (used by the hook)
#   bash scripts/secret-scan.sh --all      # audit every tracked file
#
# Bypass a genuine false positive by putting  pragma: allowlist secret  on the
# line, or (whole commit) with  git commit --no-verify.
set -u
MODE="${1:---staged}"
RED=$'\033[31m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
found=0

# Files that must never be committed (real secrets live in these).
BLOCK_FILES='(^|/)(\.env(\.[^/]*)?|\.dev\.vars|[^/]*\.pem|[^/]*\.p12|[^/]*\.pfx|id_rsa|id_dsa)$|(^|/)\.wrangler/'
# …except templates, which are meant to be shared.
ALLOW_FILES='\.(example|sample)$|\.dev\.vars\.example$'

# regex|||human label. Kept as ERE so it runs anywhere git does.
RULES=(
  'GOCSPX-[A-Za-z0-9_-]{20}|||Google OAuth client secret'
  'sk_live_[0-9A-Za-z]{16}|||Stripe live secret key'
  'sk_test_[0-9A-Za-z]{16}|||Stripe test secret key'
  '(rk|pk)_live_[0-9A-Za-z]{16}|||Stripe live key'
  'whsec_[0-9A-Za-z]{16}|||Stripe webhook secret'
  'AKIA[0-9A-Z]{16}|||AWS access key id'
  'BEGIN [A-Z ]*PRIVATE KEY|||Private key block'
  'ghp_[0-9A-Za-z]{36}|||GitHub personal access token'
  'github_pat_[0-9A-Za-z_]{40}|||GitHub fine-grained PAT'
  'xox[baprs]-[0-9A-Za-z-]{10}|||Slack token'
  'sk-ant-[0-9A-Za-z-]{20}|||Anthropic API key'
  'AIza[0-9A-Za-z_-]{35}|||Google API key'
  '(password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|session[_-]?secret|backup[_-]?key|private[_-]?key)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9+/_.=-]{16,}["'"'"']|||Secret-looking assignment'
)
# Obvious non-secrets: placeholders and intentional allowlists.
SKIP='pragma: allowlist secret|allowlist[- ]secret|YOUR_|EXAMPLE|placeholder|changeme|change-me|dummy|redacted|xxxx|<[A-Za-z._-]+>|\.\.\.'
# Pathspecs never worth scanning: the guard itself (its rules ARE the patterns),
# lockfiles, built asset bundles, and the shareable templates.
EXCL=(':(exclude,glob)**/secret-scan.sh' ':(exclude,glob)**/pre-commit' ':(exclude)package-lock.json' ':(exclude,glob)**/*.example' ':(exclude,glob)**/*.sample' ':(exclude,glob)**/dist/assets/**' ':(exclude,glob)public/assets/**')

mask() { sed -E 's![A-Za-z0-9+/_=-]{12,}![…MASKED…]!g'; }

# One fast pass per rule via `git grep -I` (skips binaries automatically):
# working tree for --all, the staged index for the hook.
grep_rule() {
  if [ "$MODE" = "--all" ]; then
    git grep -I -nEi "$1" -- . "${EXCL[@]}" 2>/dev/null
  else
    [ -n "$STAGED" ] && git grep -I -nEi --cached "$1" -- $STAGED "${EXCL[@]}" 2>/dev/null
  fi
}

# --- filename rules (fast: just the name list) ---
if [ "$MODE" = "--all" ]; then NAMES=$(git ls-files); else NAMES=$(git diff --cached --name-only --diff-filter=ACM); fi
STAGED="$NAMES"
for f in $NAMES; do
  if echo "$f" | grep -qE "$BLOCK_FILES" && ! echo "$f" | grep -qE "$ALLOW_FILES"; then
    echo "${RED}✖ blocked file:${RST} $f  ${DIM}(secrets belong in an untracked .dev.vars / secret store)${RST}"
    found=1
  fi
done

# --- content rules ---
for rule in "${RULES[@]}"; do
  re="${rule%%|||*}"; label="${rule##*|||}"
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    file="${hit%%:*}"; rest="${hit#*:}"; lineno="${rest%%:*}"; text="${rest#*:}"
    echo "$text" | grep -qiE "$SKIP" && continue
    echo "${RED}✖ ${label}:${RST} $file:$lineno  ${DIM}$(printf '%s' "$text" | mask | cut -c1-100)${RST}"
    found=1
  done < <(grep_rule "$re")
done

if [ "$found" -ne 0 ]; then
  echo ""
  echo "${YEL}Commit blocked: a credential looks like it's about to be committed.${RST}"
  echo "${DIM}False alarm? add  pragma: allowlist secret  to the line, or bypass once with  git commit --no-verify${RST}"
  exit 1
fi
[ "$MODE" = "--all" ] && echo "${DIM}secret-scan: clean${RST}"
exit 0

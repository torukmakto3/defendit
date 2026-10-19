#!/usr/bin/env bash
# Deploy the Defend It voice interviewer to LiveKit Cloud.
# Run from this folder after `lk cloud auth`. Secrets never touch the repo or chat:
# the shared agent secret comes from .agent-secret (gitignored, also stored in Vercel),
# and the Deepgram key is read with hidden input (press Enter to use LiveKit's
# built-in Deepgram access instead).
set -euo pipefail
cd "$(dirname "$0")"

if ! lk project list >/dev/null 2>&1; then
  echo "Not linked to LiveKit Cloud yet. Run: lk cloud auth" >&2
  exit 1
fi
[ -s .agent-secret ] || { echo "Missing .agent-secret (ask Claude to regenerate it)." >&2; exit 1; }

read -r -s -p "Deepgram API key (hidden; Enter to skip): " DG_KEY; echo
API_URL="${DEFEND_IT_API_URL:-https://defendit-two.vercel.app}"

SECRETS_FILE="$(mktemp)"
trap 'rm -f "$SECRETS_FILE"' EXIT
chmod 600 "$SECRETS_FILE"
{
  echo "VOICE_AGENT_SECRET=$(cat .agent-secret)"
  echo "DEFEND_IT_API_URL=$API_URL"
  [ -n "$DG_KEY" ] && echo "DEEPGRAM_API_KEY=$DG_KEY"
} > "$SECRETS_FILE"
unset DG_KEY

if [ -f livekit.toml ]; then
  lk agent update-secrets --secrets-file "$SECRETS_FILE" --overwrite -y
  lk agent deploy -y
else
  lk agent create --secrets-file "$SECRETS_FILE" -y
fi
lk agent status

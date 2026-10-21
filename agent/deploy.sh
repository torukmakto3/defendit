#!/usr/bin/env bash
# Deploy the Defend It voice interviewer to LiveKit Cloud.
# Run from this folder in a terminal. Secrets never touch the repo or chat:
# the shared agent secret comes from .agent-secret (gitignored, also stored in Vercel),
# and the Deepgram key is read with hidden input (press Enter to use LiveKit's
# built-in Deepgram access instead).
set -euo pipefail
cd "$(dirname "$0")"

# Use a project linked with `lk cloud auth` if there is one; otherwise ask for
# the project's URL, API key and secret (the same values set in Vercel).
if ! lk project list 2>/dev/null | grep -q .; then
  read -r -p "LiveKit URL (wss://...livekit.cloud): " LIVEKIT_URL
  read -r -s -p "LiveKit API key (hidden): " LIVEKIT_API_KEY; echo
  read -r -s -p "LiveKit API secret (hidden): " LIVEKIT_API_SECRET; echo
  export LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET
  read -r -p "Save these in the LiveKit CLI config on this Mac (lets Claude read agent logs)? [y/N] " SAVE
  if [[ "$SAVE" =~ ^[Yy]$ ]]; then
    lk project add defend-it --url "$LIVEKIT_URL" --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET" --default >/dev/null
    echo "Saved as LiveKit project 'defend-it'."
  fi
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
  # Unset keeps Deepgram Aura-2. Export TTS_PROVIDER=xai to opt in on this deploy.
  [ -n "${TTS_PROVIDER:-}" ] && echo "TTS_PROVIDER=$TTS_PROVIDER"
  [ -n "${TTS_VOICE:-}" ] && echo "TTS_VOICE=$TTS_VOICE"
} > "$SECRETS_FILE"
unset DG_KEY

if [ -f livekit.toml ]; then
  lk agent update-secrets --secrets-file "$SECRETS_FILE" --overwrite -y
  lk agent deploy -y
else
  lk agent create --secrets-file "$SECRETS_FILE" -y
fi
lk agent status

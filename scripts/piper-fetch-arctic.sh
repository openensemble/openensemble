#!/usr/bin/env bash
# scripts/piper-fetch-arctic.sh
#
# Fetch CMU ARCTIC sentence prompts (phonetically balanced, public domain)
# and emit them in id|text format for piper-elevenlabs-corpus.mjs.
#
# Usage:
#   scripts/piper-fetch-arctic.sh [out_path] [count]
#
# Defaults:
#   out_path = ~/piper-training/aussie-female-v1/sentences.csv
#   count    = 300  (~18-22 min of speech, ~25-30k characters)
#
# ARCTIC has 1132 sentences (A list + B list). 200-400 is plenty for a
# fine-tune from a strong base voice; the LJSpeech-style format Piper
# expects is just `id|text` per line.

set -euo pipefail

OUT="${1:-${HOME}/piper-training/aussie-female-v1/sentences.csv}"
COUNT="${2:-300}"

mkdir -p "$(dirname "$OUT")"

URL="http://festvox.org/cmu_arctic/cmuarctic.data"
echo "Fetching ARCTIC sentences from $URL"

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsSL "$URL" \
  | sed -nE 's/^\( arctic_([ab][0-9]+) "(.*)" \)$/\1|\2/p' \
  > "$TMP"
head -n "$COUNT" "$TMP" > "$OUT"

LINES=$(wc -l < "$OUT")
CHARS=$(awk -F'|' '{ for (i=2; i<=NF; i++) sum += length($i) } END { print sum }' "$OUT")

echo ""
echo "Wrote $LINES sentences ($CHARS chars) to:"
echo "  $OUT"
echo ""
echo "ElevenLabs cost estimate (rough):"
echo "  Starter  (\$5/30k chars):  \$$(awk "BEGIN { printf \"%.2f\", $CHARS / 30000 * 5 }")"
echo "  Creator  (\$22/100k):      \$$(awk "BEGIN { printf \"%.2f\", $CHARS / 100000 * 22 }")"
echo "  Pro      (\$99/500k):      \$$(awk "BEGIN { printf \"%.2f\", $CHARS / 500000 * 99 }")"

#!/usr/bin/env bash
# Mnemosyne nightly dream — 04:30 daily
#
# Phase 1 (automated): Generate episodic narratives for recent sessions
# Phase 2 (flag): Set .dream-pending so Claude runs the full scoring/promotion
#                 cycle at the next session start

set -euo pipefail

LOG="$HOME/.claude/memory/dream-cron.log"
NARRATE="$HOME/.claude/skills/mnemosyne/dream-narrate.js"
FLAG="$HOME/.claude/.dream-pending"

echo "$(date '+%Y-%m-%dT%H:%M:%S'): mnemosyne-dream starting" >> "$LOG"

# Run episodic narration for sessions from the last 2 days
echo "$(date '+%Y-%m-%dT%H:%M:%S'): running dream-narrate..." >> "$LOG"
node "$NARRATE" --days 2 >> "$LOG" 2>&1

# Set flag so /mnemosyne runs at next session start (scoring, promotion, eviction, topology)
touch "$FLAG"
echo "$(date '+%Y-%m-%dT%H:%M:%S'): dream-pending flag set" >> "$LOG"

echo "$(date '+%Y-%m-%dT%H:%M:%S'): mnemosyne-dream done" >> "$LOG"

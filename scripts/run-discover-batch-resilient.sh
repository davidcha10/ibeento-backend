#!/usr/bin/env bash

# Resilient batch runner for discover:qid.
# - Retries each city until success (or MAX_ATTEMPTS_PER_CITY if set > 0)
# - Writes detailed logs per attempt
# - Persists completed QIDs so it can resume safely

set -u
set -o pipefail

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BACKEND_DIR" || exit 1

CITIES_JSON="${1:-/tmp/city-qids-wikipedia.json}"

HEARTBEAT_MS="${HEARTBEAT_MS:-15000}"
NETWORK_RETRY_ATTEMPTS="${NETWORK_RETRY_ATTEMPTS:-20}"
NETWORK_RETRY_DELAY_MS="${NETWORK_RETRY_DELAY_MS:-2000}"
SLEEP_BETWEEN_SUCCESS_SEC="${SLEEP_BETWEEN_SUCCESS_SEC:-3}"
SLEEP_ON_FAILURE_SEC="${SLEEP_ON_FAILURE_SEC:-20}"
MAX_ATTEMPTS_PER_CITY="${MAX_ATTEMPTS_PER_CITY:-0}" # 0 = infinite retries
RUN_ID="${RUN_ID:-}"
RUN_DIR_OVERRIDE="${RUN_DIR:-}"
FORCE_REBUILD_CITIES="${FORCE_REBUILD_CITIES:-0}"

if [ ! -f "$CITIES_JSON" ]; then
  echo "[batch] Missing cities JSON: $CITIES_JSON"
  exit 1
fi

if [ -n "$RUN_DIR_OVERRIDE" ]; then
  RUN_DIR="$RUN_DIR_OVERRIDE"
elif [ -n "$RUN_ID" ]; then
  RUN_DIR="logs/discover-batch-$RUN_ID"
else
  TS="$(date +%Y%m%d-%H%M%S)"
  RUN_DIR="logs/discover-batch-$TS"
fi
mkdir -p "$RUN_DIR"

CITIES_TSV="$RUN_DIR/cities.tsv"
SUMMARY_TSV="$RUN_DIR/summary.tsv"
DONE_QIDS="$RUN_DIR/done-qids.txt"

if [ ! -s "$CITIES_TSV" ] || [ "$FORCE_REBUILD_CITIES" = "1" ]; then
  node -e '
const fs=require("fs");
const arr=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for(const r of arr){
  const rank = r?.rank ?? "";
  const city = String(r?.city ?? "").replace(/\t/g," ").trim();
  const qid = String(r?.qid ?? "").trim().toUpperCase();
  process.stdout.write(`${rank}\t${city}\t${qid}\n`);
}
' "$CITIES_JSON" > "$CITIES_TSV"
fi

if [ ! -f "$SUMMARY_TSV" ]; then
  echo -e "timestamp\trank\tcity\tqid\tattempt\tstatus\texit_code\tlog_file" > "$SUMMARY_TSV"
fi
touch "$DONE_QIDS"

is_done_qid() {
  local qid="$1"
  grep -Fxq "$qid" "$DONE_QIDS"
}

mark_done_qid() {
  local qid="$1"
  if ! is_done_qid "$qid"; then
    echo "$qid" >> "$DONE_QIDS"
  fi
}

append_summary() {
  local ts="$1"
  local rank="$2"
  local city="$3"
  local qid="$4"
  local attempt="$5"
  local status="$6"
  local exit_code="$7"
  local log_file="$8"
  echo -e "${ts}\t${rank}\t${city}\t${qid}\t${attempt}\t${status}\t${exit_code}\t${log_file}" >> "$SUMMARY_TSV"
}

echo "[batch] Starting resilient discover batch"
echo "[batch] Run dir: $RUN_DIR"
echo "[batch] Cities file: $CITIES_JSON"

while IFS=$'\t' read -r rank city qid; do
  if [[ -z "$qid" || ! "$qid" =~ ^Q[0-9]+$ ]]; then
    continue
  fi

  if is_done_qid "$qid"; then
    echo "[batch] Skip already done: $city ($qid)"
    continue
  fi

  attempt=0
  while true; do
    attempt=$((attempt + 1))
    now="$(date +%Y-%m-%dT%H:%M:%S%z)"
    log_file="$RUN_DIR/${rank}-${qid}-attempt${attempt}.log"

    echo "[batch] [$rank] $city ($qid) attempt $attempt"
    npm run discover:qid -- "$qid" \
      --heartbeat-ms "$HEARTBEAT_MS" \
      --network-retry-attempts "$NETWORK_RETRY_ATTEMPTS" \
      --network-retry-delay-ms "$NETWORK_RETRY_DELAY_MS" \
      --no-timeout 2>&1 | tee "$log_file"
    cmd_exit="${PIPESTATUS[0]}"

    if [ "$cmd_exit" -eq 0 ]; then
      echo "[batch] OK $city ($qid)"
      append_summary "$now" "$rank" "$city" "$qid" "$attempt" "ok" "$cmd_exit" "$log_file"
      mark_done_qid "$qid"
      sleep "$SLEEP_BETWEEN_SUCCESS_SEC"
      break
    fi

    echo "[batch] ERROR $city ($qid) attempt $attempt exit=$cmd_exit"
    append_summary "$now" "$rank" "$city" "$qid" "$attempt" "error" "$cmd_exit" "$log_file"

    if [ "$MAX_ATTEMPTS_PER_CITY" -gt 0 ] && [ "$attempt" -ge "$MAX_ATTEMPTS_PER_CITY" ]; then
      echo "[batch] Reached MAX_ATTEMPTS_PER_CITY=$MAX_ATTEMPTS_PER_CITY for $qid; moving on."
      break
    fi

    echo "[batch] Retry in ${SLEEP_ON_FAILURE_SEC}s..."
    sleep "$SLEEP_ON_FAILURE_SEC"
  done
done < "$CITIES_TSV"

echo "[batch] Completed. Summary: $SUMMARY_TSV"

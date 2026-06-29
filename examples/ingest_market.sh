#!/usr/bin/env bash
set -euo pipefail

: "${HERMES_DASHBOARD_URL:=http://127.0.0.1:8080}"
: "${HERMES_INGEST_TOKEN:?HERMES_INGEST_TOKEN is required}"

gold_price="${1:?usage: ingest_market.sh GOLD_PRICE}"

curl -fsS -X POST "${HERMES_DASHBOARD_URL}/api/ingest" \
  -H "Authorization: Bearer ${HERMES_INGEST_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"key\":\"gold_spot\",
    \"name\":\"黄金现货\",
    \"unit\":\"USD/oz\",
    \"category\":\"market\",
    \"sort_order\":1,
    \"value\":${gold_price}
  }"

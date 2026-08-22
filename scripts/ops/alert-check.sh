#!/usr/bin/env bash
# Polls the deployed service's /health, /ready, and (if an admin token is
# configured) /api/admin/storage endpoints, and posts a webhook alert when
# something is unhealthy, not ready, or a storage warning threshold is
# crossed. Designed to run from cron, a docker-compose sidecar, or a
# scheduled GitHub Actions job pointed at a real deployment.
#
# Required:
#   SERVICE_URL          base URL of the deployed mcp-server, e.g.
#                         https://gyeongbuk-public-ai.example.org
# Optional:
#   ADMIN_TOKEN           HTTP_AUTH_TOKEN value; enables the storage check
#   ALERT_WEBHOOK_URL     generic JSON webhook (Slack/Discord-compatible
#                         incoming webhook, or any endpoint accepting
#                         {"text": "..."}). If unset, alerts are only printed.
set -euo pipefail

: "${SERVICE_URL:?SERVICE_URL is required}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"

problems=()

check_endpoint() {
  local path="$1"
  local expect_status="$2"
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${SERVICE_URL}${path}" || echo "000")"
  if [[ "$status" != "$expect_status" ]]; then
    problems+=("${path} returned HTTP ${status} (expected ${expect_status})")
  else
    echo "[alert-check] ${path} OK (${status})"
  fi
}

check_endpoint "/health" "200"
check_endpoint "/ready" "200"

if [[ -n "$ADMIN_TOKEN" ]]; then
  storage_status_and_body="$(curl -s --max-time 10 -w '\n%{http_code}' -H "Authorization: Bearer ${ADMIN_TOKEN}" "${SERVICE_URL}/api/admin/storage" || printf '\n000')"
  storage_status="$(echo "$storage_status_and_body" | tail -n1)"
  storage_response="$(echo "$storage_status_and_body" | sed '$d')"
  if [[ "$storage_status" != "200" ]]; then
    problems+=("/api/admin/storage returned HTTP ${storage_status} (expected 200)")
  else
    warning_count="$(echo "$storage_response" | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk));
      process.stdin.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
          if (warnings.length > 0) console.log(warnings.join("; "));
        } catch {
          console.log("__parse_error__");
        }
      });
    ')"
    if [[ "$warning_count" == "__parse_error__" ]]; then
      problems+=("/api/admin/storage returned an unparseable response")
    elif [[ -n "$warning_count" ]]; then
      problems+=("storage warnings: ${warning_count}")
    else
      echo "[alert-check] /api/admin/storage OK (no warnings)"
    fi
  fi
else
  echo "[alert-check] ADMIN_TOKEN not set, skipping storage warning check"
fi

if [[ ${#problems[@]} -gt 0 ]]; then
  message="gyeongbuk-public-ai alert (${SERVICE_URL}): $(IFS='; '; echo "${problems[*]}")"
  echo "[alert-check] $message" >&2
  if [[ -n "$ALERT_WEBHOOK_URL" ]]; then
    curl -s -X POST -H "Content-Type: application/json" \
      -d "$(node -e 'console.log(JSON.stringify({text: process.argv[1]}))' "$message")" \
      "$ALERT_WEBHOOK_URL" > /dev/null || echo "[alert-check] failed to deliver webhook" >&2
  fi
  exit 1
fi

echo "[alert-check] all checks passed"

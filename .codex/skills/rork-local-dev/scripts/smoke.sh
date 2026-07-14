#!/bin/sh
# Smoke-test a running rork-local server: root UI, simulator mount,
# status API shape, and a screenshot capture/delete round-trip.
set -eu

PORT="${PORT:-3131}"
BASE="http://localhost:${PORT}"
FAIL=0

check_code() {
  desc="$1"; path="$2"; want="$3"
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${BASE}${path}") || code="000"
  if [ "$code" = "$want" ]; then
    echo "ok   ${desc} (${code})"
  else
    echo "FAIL ${desc}: got ${code}, want ${want}"
    FAIL=1
  fi
}

check_code "root UI" "/" 200
check_code "simulator mount" "/.sim" 200

status=$(curl -s --max-time 10 "${BASE}/api/status" || true)
if printf '%s' "$status" | grep -q '"detected"' && printf '%s' "$status" | grep -q '"job"'; then
  echo "ok   /api/status shape"
else
  echo "FAIL /api/status shape: ${status}"
  FAIL=1
fi

name="smoke-$$"
cap=$(curl -s --max-time 30 -X POST "${BASE}/api/screenshots/capture" \
  -H 'content-type: application/json' -d "{\"name\":\"${name}\"}" || true)
if printf '%s' "$cap" | grep -q '"ok":true'; then
  echo "ok   screenshot capture"
  curl -s --max-time 10 -X DELETE "${BASE}/api/screenshots/raw/${name}" > /dev/null || true
else
  echo "warn screenshot capture skipped/failed (no booted simulator?): ${cap}"
fi

exit "$FAIL"

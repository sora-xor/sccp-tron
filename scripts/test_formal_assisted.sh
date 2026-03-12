#!/usr/bin/env bash
set -euo pipefail

PROFILE="full"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "usage: scripts/test_formal_assisted.sh [--profile fast|full]" >&2
      exit 1
      ;;
  esac
done

if [[ "${PROFILE}" != "fast" && "${PROFILE}" != "full" ]]; then
  echo "profile must be fast or full (got: ${PROFILE})" >&2
  exit 1
fi

echo "[sccp-formal-assisted] profile=${PROFILE}"
npm run test:formal-assisted -- --profile "${PROFILE}"

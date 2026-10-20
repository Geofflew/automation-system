#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v gitleaks >/dev/null || { echo 'Install gitleaks to run the secret scan.' >&2; exit 1; }
gitleaks dir . --redact

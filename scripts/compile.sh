#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

mkdir -p artifacts

echo "solc: $(solc --version | head -n 1)"

solc \
  --overwrite \
  --optimize \
  --abi --bin \
  --base-path . \
  --include-path . \
  -o artifacts \
  contracts/SccpRouter.sol \
  contracts/SccpToken.sol \
  contracts/SccpCodec.sol \
  contracts/ISccpVerifier.sol \
  contracts/verifiers/AlwaysFalseVerifier.sol \
  contracts/verifiers/AlwaysTrueVerifier.sol

echo "wrote artifacts/ (abi + bin)"

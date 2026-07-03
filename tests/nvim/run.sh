#!/usr/bin/env bash
# Headless smoke tests for the nvim plugin (no Rust binary needed —
# a bash shim stands in for ledger). Requires nvim >= 0.10.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec nvim --headless --clean -u tests/nvim/minimal_init.lua -l tests/nvim/ledger_spec.lua

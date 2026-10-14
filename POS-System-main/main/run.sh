#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
export STOREFLOW_PORT="${STOREFLOW_PORT:-8080}"
java src/StoreFlowServer.java

#!/usr/bin/env sh
# Container entrypoint for the Ryu open-core stack.
#
# Managed platforms (Render, Railway, DigitalOcean, Fly) inject the public port
# via $PORT and health-check the public interface. Core reads RYU_BIND, so map
# $PORT onto it and bind all interfaces. The Gateway is NOT started here: Core
# spawns and manages it on loopback (127.0.0.1:7981) unless RYU_GATEWAY_MANAGED
# is disabled (see docker-compose.yml for the externally-managed split).
set -e

# Respect an explicit RYU_BIND if the operator set one; otherwise derive it from
# the platform-provided $PORT (default 7980).
export RYU_BIND="${RYU_BIND:-0.0.0.0:${PORT:-7980}}"

exec ryu-core "$@"

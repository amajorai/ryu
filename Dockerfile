# syntax=docker/dockerfile:1
#
# One-image build of the Ryu open-core stack: ryu-core (Apache-2.0, :7980) and
# ryu-gateway (AGPL-3.0, :7981). This is what every one-click deploy button
# (Render, Railway, DigitalOcean, Fly) and `docker compose` build from.
#
# The runtime container runs `ryu-core`; Core spawns and manages `ryu-gateway`
# itself on loopback (RYU_GATEWAY_MANAGED defaults on), so only Core's port is
# published. The two-service split is available via docker-compose.yml.
#
# Build-from-source rather than fetching release binaries: it works before any
# GitHub release is published and pins nothing to a release asset name. The
# runtime image stays small (debian-slim + two static binaries), preserving the
# "two binaries, no runtime" footprint. First build compiles Core (~hundreds of
# crates), so expect 10-15 min on a cold cache; it is cached afterwards.

# ---- builder ------------------------------------------------------------------
FROM rust:1-bookworm AS builder

# Core and Gateway build deps. cmake + a C/C++ toolchain are needed for Core's
# vendored audio codec (audiopus_sys builds libopus via CMake); protobuf-compiler
# for prost-build; libssl-dev + libdbus-1-dev + pkg-config for the rest. GitHub's
# ubuntu runners ship cmake preinstalled, so the release workflow omits it; a
# bare debian builder does not, so install it explicitly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      pkg-config \
      protobuf-compiler \
      libssl-dev \
      libdbus-1-dev \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

# apps/core and apps/gateway are each their own Cargo workspace (there is no root
# manifest), so build each by its manifest path — the same invocation the release
# workflow uses. Binaries land at apps/<app>/target/release/.
RUN cargo build --release --manifest-path apps/gateway/Cargo.toml \
 && cargo build --release --manifest-path apps/core/Cargo.toml \
 && cp apps/gateway/target/release/ryu-gateway /usr/local/bin/ryu-gateway \
 && cp apps/core/target/release/ryu-core /usr/local/bin/ryu-core

# ---- runtime ------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      libssl3 \
      libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/ryu-core /usr/local/bin/ryu-core
COPY --from=builder /usr/local/bin/ryu-gateway /usr/local/bin/ryu-gateway
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Core persists everything (models, state, keys) under RYU_DIR; point it at a
# mountable volume so a redeploy does not re-download the local model stack.
ENV RYU_DIR=/data
# Default listen port. Render/Railway/DigitalOcean/Fly inject their own $PORT;
# the entrypoint maps it onto RYU_BIND. Gateway stays on loopback (Core-managed).
ENV PORT=7980

VOLUME ["/data"]
EXPOSE 7980

# Core's liveness endpoint, for platform health checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD ["/bin/sh", "-c", "curl -fsS \"http://127.0.0.1:${PORT:-7980}/api/health\" || exit 1"]

ENTRYPOINT ["docker-entrypoint.sh"]

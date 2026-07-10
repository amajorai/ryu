# syntax=docker/dockerfile:1
#
# Standalone build of ryu-gateway (AGPL-3.0, :7981) as the hosted, multi-tenant
# managed-cloud DATA PLANE. Unlike the repo-root Dockerfile (which builds Core +
# Gateway into one image and runs Core), this image builds and runs ONLY the
# gateway, so a Dokploy/fleet deploy never compiles Core.
#
# Built by Dokploy with buildType=dockerfile, build context = REPO ROOT (`.`),
# dockerfile path apps/gateway/Dockerfile — matching every other app in the
# project. apps/gateway is its own Cargo workspace (own Cargo.lock, zero path
# deps), so we COPY only that crate; the rest of the monorepo is never needed.
#
# Boot requirements (see docs/deploy-gateway-fleet.md): on a public (non-loopback)
# bind the gateway HARD-REFUSES to start without GATEWAY_MASTER_KEY (which also
# flips require_auth on). Behind a load balancer also set RYU_GATEWAY_FLEET=1 so
# co-located proxy peers appearing as 127.0.0.1 cannot reach the admin surface
# (/v1/config, /v1/audit) without the master key.

# ---- builder ------------------------------------------------------------------
FROM rust:1-bookworm AS builder

# Gateway-only build deps: build-essential + libssl-dev for native-tls, and the C
# toolchain for rusqlite's bundled SQLite (the audit store). cmake / protobuf are
# Core-only and intentionally omitted here to keep the build fast.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      pkg-config \
      libssl-dev \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Context is the repo root; copy only the self-contained gateway crate. The root
# .dockerignore already excludes **/target, so no build output is transferred.
COPY apps/gateway ./
# Build the release binary against the committed lockfile for reproducibility.
# BuildKit cache mounts keep the crates.io registry and target dir warm across
# rebuilds so redeploys are incremental, not cold.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked \
 && cp target/release/ryu-gateway /usr/local/bin/ryu-gateway

# ---- runtime ------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/ryu-gateway /usr/local/bin/ryu-gateway

# Optional persistence for the audit SQLite store and a mounted gateway.toml.
# Not required to boot; mount a volume here and set GATEWAY_CONFIG=/data/gateway.toml
# if you want per-tenant static api_keys to survive redeploys.
ENV RYU_DIR=/data
VOLUME ["/data"]

EXPOSE 7981

# Unauthenticated liveness endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["/bin/sh", "-c", "curl -fsS http://127.0.0.1:7981/health || exit 1"]

# This image IS the gateway. `--bind=` (with the equals sign) is how ryu-gateway
# takes its listen address. Bind all interfaces so Dokploy's proxy can reach it.
ENTRYPOINT ["ryu-gateway", "--bind=0.0.0.0:7981"]

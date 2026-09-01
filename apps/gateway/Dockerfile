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
FROM rust:1-trixie AS builder

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
# Context is the repo root. `apps/gateway` is its own Cargo workspace (own
# Cargo.lock), but it is NOT dependency-free: since the decomposition it carries
# ~12 path deps into `crates/gateway/*` plus `crates/core/tool-registry`, and
# those crates in turn depend on their siblings. Copying `apps/gateway` alone
# built fine until 2026-07-16 and has failed ever since with
# `failed to read /crates/gateway/audit/Cargo.toml`, which is a BUILD-time error
# no test catches — the gateway simply stopped being redeployable while the
# already-running container kept serving, so nothing looked broken.
#
# `crates/` is copied whole rather than crate-by-crate deliberately: an
# enumerated list is what rotted last time, and a new path dep would silently
# reintroduce the same failure. The root .dockerignore excludes **/target, so no
# build output is transferred.
COPY apps/gateway ./apps/gateway
COPY crates ./crates
WORKDIR /src/apps/gateway
# Build the release binary against the committed lockfile for reproducibility.
# BuildKit cache mounts keep the crates.io registry and target dir warm across
# rebuilds so redeploys are incremental, not cold.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/apps/gateway/target \
    cargo build --release --locked \
 && cp target/release/ryu-gateway /usr/local/bin/ryu-gateway

# ---- runtime ------------------------------------------------------------------
FROM debian:trixie-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      libssl3 \
    && rm -rf /var/lib/apt/lists/*

# A gateway process can spend provider credentials and tenant credits, but it
# must never be a host administrator. Keep its runtime UID rootless even when a
# deployment omits the orchestrator security profile.
RUN groupadd --gid 10001 ryu \
    && useradd --uid 10001 --gid 10001 --home-dir /data \
      --no-create-home --shell /usr/sbin/nologin ryu \
    && install -d -o 10001 -g 10001 -m 0750 /data

COPY --from=builder /usr/local/bin/ryu-gateway /usr/local/bin/ryu-gateway

# Optional persistence for the audit SQLite store and a mounted gateway.toml.
# Not required to boot; mount a volume here and set GATEWAY_CONFIG=/data/gateway.toml
# if you want per-tenant static api_keys to survive redeploys.
ENV RYU_DIR=/data
ENV HOME=/data
VOLUME ["/data"]

EXPOSE 7981

# Unauthenticated liveness endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["/bin/sh", "-c", "curl -fsS http://127.0.0.1:7981/health || exit 1"]

# This image IS the gateway. `--bind=` (with the equals sign) is how ryu-gateway
# takes its listen address. Bind all interfaces so Dokploy's proxy can reach it.
ENTRYPOINT ["ryu-gateway", "--bind=0.0.0.0:7981"]
USER 10001:10001

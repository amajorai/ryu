# syntax=docker/dockerfile:1
#
# Standalone build of ryu-gateway (AGPL-3.0, :7981) as the hosted, multi-tenant
# managed-cloud DATA PLANE. Unlike the repo-root Dockerfile (which builds Core +
# Gateway into one image and runs Core), this image builds and runs ONLY the
# gateway, so a Dokploy/fleet deploy never compiles Core.
#
# Built by Dokploy with buildType=dockerfile, build context = REPO ROOT (`.`),
# dockerfile path apps/gateway/Dockerfile — matching every other app in the
# project:
#
#   docker build -f apps/gateway/Dockerfile .
#
# apps/gateway is NOT self-contained: it has path deps into crates/core,
# crates/gateway and vendor/genai, so an `apps/gateway`-only context cannot build.
#
# Boot posture (see docs/deploy-gateway-fleet.md): auth.require_auth defaults ON.
# Without GATEWAY_MASTER_KEY the gateway still boots on a public bind, but it
# generates its own administrator key (gateway-admin.key, `gwadm_…`) and inference
# key (gateway-relay.key, `gwrelay_…`) beside gateway.toml under the /data volume
# (sealed when RYU_MASTER_KEY is set; read one with `ryu-gateway print-key admin`).
# Set GATEWAY_MASTER_KEY (24+ characters) for a known, operator-controlled admin
# key. Startup is refused only when auth is DISABLED on a non-loopback bind or in
# fleet mode. Behind a load balancer also set RYU_GATEWAY_FLEET=1 so co-located
# proxy peers appearing as 127.0.0.1 cannot reach the admin surface (/v1/config,
# /v1/audit) without the master key. RYU_GATEWAY_FLEET is exposure hardening
# only; a hosted Ryu replica is marked by its provider vault (CONTROL_PLANE_URL
# with RYU_VAULT_INTERNAL_SECRET, or RYU_PROVIDER_VAULT_REQUIRED=1).

# ---- builder ------------------------------------------------------------------
FROM rust:1-trixie AS builder

# Gateway-only build deps: build-essential + libssl-dev for native-tls, and the C
# toolchain for rusqlite's bundled SQLite (the audit store). cmake / protobuf and
# libdbus-1-dev are Core-only and intentionally omitted here to keep the build
# fast: the gateway reaches ryu-crypto only through ryu-composio, which turns off
# its OS-keychain feature, so keyring/libdbus-sys are not in this build graph.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      pkg-config \
      libssl-dev \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Context is the repo root, copied whole (the root .dockerignore drops .git,
# **/target, **/node_modules and env files). Building by manifest path then
# resolves the same way in both shapes this file ships in:
#
# * the private monorepo: apps/gateway is a MEMBER of the root virtual workspace,
#   so cargo uses the root Cargo.toml (its `[patch.crates-io]` for vendor/genai)
#   and the maintained root Cargo.lock that CI tests against;
# * the public mirror (no root Cargo.toml): apps/gateway is its own root package
#   and uses apps/gateway/Cargo.lock, which is pruned from the root lock so the
#   versions match.
#
# Copying only `apps/gateway` + `crates` used to break twice: first on the
# missing crates/gateway path deps, then on the missing vendor/genai path dep and
# a stale standalone lock that `--locked` rejects. A whole-tree copy cannot rot
# that way when a new path dep appears. Only the gateway's own dependency graph
# is compiled; Core is never built here.
#
# CARGO_TARGET_DIR pins the output to /src/target in both shapes (a workspace
# member would build into the workspace root, a standalone package into
# apps/gateway/target). BuildKit cache mounts keep the crates.io registry and
# target dir warm across rebuilds so redeploys are incremental, not cold.
COPY . .
ENV CARGO_TARGET_DIR=/src/target
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --manifest-path apps/gateway/Cargo.toml \
 && cp /src/target/release/ryu-gateway /usr/local/bin/ryu-gateway

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

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
#
# TRIXIE, not bookworm, and the runtime stage must move with it.
#
# `voice-parakeet` links ONNX Runtime through `ort`/`ort-sys`, and the prebuilt ORT
# archive `ort-sys` downloads is compiled against a NEWER glibc than Debian 12
# ships (bookworm is glibc 2.36). Linking it on bookworm fails at the very last
# step of a ~34-minute build with:
#
#   rust-lld: error: undefined symbol: __isoc23_strtoll
#   rust-lld: error: undefined symbol: __isoc23_strtoull
#   rust-lld: error: undefined symbol: __isoc23_strtol
#
# Those `__isoc23_*` entry points are glibc 2.38+ (the C23 strtol family); on 2.36
# they simply do not exist, so every ORT object referencing them is unresolvable.
# Nothing in this repo can fix that from the Rust side — the symbols are baked into
# a binary we download — so the builder has to be at least as new as whatever built
# it. Trixie (Debian 13) is glibc 2.41.
#
# The runtime stage below is trixie-slim for the matching reason and must stay in
# lockstep: a binary linked against 2.41 will not start on a 2.36 image, so
# downgrading either stage alone converts a build failure into a container that
# builds fine and then dies on exec.
FROM rust:1-trixie AS builder

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

# apps/core and apps/gateway are MEMBERS of the root virtual workspace (see the
# root Cargo.toml — every crate shares ONE ./target, which is why that file exists
# at all). They are still built by manifest path, matching the release workflow, but
# the artifacts land in the WORKSPACE root /src/target/release — NOT
# apps/<app>/target/release, which is where this stage used to copy from and does not
# exist, so the build failed at the `cp`. Same note as release.yml's staging step.
#
# Core also needs its three shipped-but-not-default features: they are off in
# `[features] default` to keep `cargo test`/`cargo check` lean, so a bare
# `cargo build --release` yields a Core with NO WASM sandbox, NO parakeet STT
# inference and NO Silero VAD — each of which degrades silently at runtime. Mirrors
# apps/core/package.json (`build`), release.yml and release-local.sh; keep all four
# in sync. (Docker cannot reuse the package.json script: bun is not in this image.)
RUN cargo build --locked --release --manifest-path apps/gateway/Cargo.toml \
 && cargo build --locked --release --manifest-path apps/core/Cargo.toml \
      --features sandbox-wasmtime,voice-parakeet,voice-vad \
 && cp target/release/ryu-gateway /usr/local/bin/ryu-gateway \
 && cp target/release/ryu-core /usr/local/bin/ryu-core

# ---- runtime ------------------------------------------------------------------
FROM debian:trixie-slim AS runtime

# libstdc++6 is defensive cover for the `voice-parakeet` feature, which links ONNX
# Runtime (C++) in. `ort` links its prebuilt copy STATICALLY — verified on macOS
# aarch64, where `otool -L` on a feature-built ryu-core shows no libonnxruntime — so
# no ORT .so needs copying, but a statically linked C++ library still resolves the
# C++ runtime dynamically. NOT verified: whether trixie-slim already carries
# libstdc++6 (it may, making this a no-op) and whether the Linux ORT static bundle
# actually needs it. Listed anyway because the failure mode if it is missing is the
# container refusing to start at all, and one apt name is cheap insurance.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      libssl3 \
      libdbus-1-3 \
      libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# The application is never a host administrator. Keep the runtime UID
# rootless even when the image is started without an orchestrator security
# profile; persistent state is the only writable application-owned path.
RUN groupadd --gid 10001 ryu \
    && useradd --uid 10001 --gid 10001 --home-dir /data \
      --no-create-home --shell /usr/sbin/nologin ryu \
    && install -d -o 10001 -g 10001 -m 0750 /data

COPY --from=builder /usr/local/bin/ryu-core /usr/local/bin/ryu-core
COPY --from=builder /usr/local/bin/ryu-gateway /usr/local/bin/ryu-gateway
COPY config/node-config.example.json /usr/share/ryu/node-config.example.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Core persists everything (models, state, keys) under RYU_DIR; point it at a
# mountable volume so a redeploy does not re-download the local model stack.
ENV RYU_DIR=/data
# Keep the structured node config on the same persistent volume as Core state.
ENV XDG_CONFIG_HOME=/data/.config
ENV HOME=/data
# Default listen port. Render/Railway/DigitalOcean/Fly inject their own $PORT;
# the entrypoint maps it onto RYU_BIND. Gateway stays on loopback (Core-managed).
ENV PORT=7980

VOLUME ["/data"]
EXPOSE 7980

# Core's liveness endpoint, for platform health checks. First boot can spend
# several minutes materializing the verified official package set before the
# listener binds; give that bounded startup path room, then keep probing normally.
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=5 \
  CMD ["/bin/sh", "-c", "curl -fsS \"http://127.0.0.1:${PORT:-7980}/api/health\" || exit 1"]

ENTRYPOINT ["docker-entrypoint.sh"]

# Do not run Core as root. Docker Compose additionally drops all Linux
# capabilities and enables a read-only root filesystem.
USER 10001:10001

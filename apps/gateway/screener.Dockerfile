# syntax=docker/dockerfile:1
#
# Hosted fleet hazard screener (managed guardrails screener addendum section
# 10, build step G7): a local closed-choice decision model on the TypeSafe
# `systemone` wire, served by Ollaya on CPU. It runs as its own container next
# to the fleet gateway on an internal network (apps/gateway/docker-compose.fleet.yml)
# and is never inside the gateway image, which stays slim and rootless.
#
# Nothing here is a floating reference:
#
# * OLLAYA_IMAGE must name the upstream image by digest
#   (ghcr.io/ollaya-dev/ollaya@sha256:<digest>, the CPU variant). There is no
#   default; a build without it fails.
# * SCREENER_MODEL is the Ollaya model name the gateway sends as `model`
#   (RYU_SCREENER_DECISION_MODEL), always with a tag (`name:tag`): Ollaya stores
#   an untagged digest pull as `name@sha256:<hex>`, which the gateway's model
#   name would not match. SCREENER_MODEL_SHA256 is its manifest
#   digest as 64 hex characters without a `sha256:` prefix
#   (RYU_SCREENER_DECISION_SHA256). The model is pulled by that digest, so
#   Ollaya checks the manifest and every layer's sha256 before storing
#   anything. The gateway pins the same value, and a platform-floor
#   qualification record must name it before the screener may decide the hard
#   codes.
# * SCREENER_EXTRA_PINS lists any further `name@sha256:<hex>` models the served
#   model needs, for example the sub-models behind a router alias such as
#   `laya`. Pin each one, or the router may resolve to unpinned weights.
#
# The weights are baked into the image at build time, so the running container
# needs no egress (its network is internal) and starts without a download.
#
#   docker build -f apps/gateway/screener.Dockerfile \
#     --build-arg OLLAYA_IMAGE=ghcr.io/ollaya-dev/ollaya@sha256:<digest> \
#     --build-arg SCREENER_MODEL=<name> \
#     --build-arg SCREENER_MODEL_SHA256=<64 hex> \
#     apps/gateway
#
# UNVERIFIED in this repository (no Docker on the authoring host): the upstream
# image layout (a POSIX shell, the `ollaya` binary on PATH, the `ollaya` user),
# that `ollaya pull` needs a running server, the model names and digests, and
# CPU latency against the chat deadline. Check each against the pinned build.

# No default: an empty base name fails the build.
ARG OLLAYA_IMAGE
FROM ${OLLAYA_IMAGE}

ARG SCREENER_MODEL
ARG SCREENER_MODEL_SHA256
ARG SCREENER_EXTRA_PINS=""

# The model store lives outside HOME, so the tmpfs the compose file mounts over
# HOME (for anything the server writes at runtime) never hides the baked models.
ENV OLLAYA_MODELS=/opt/ollaya/models \
    OLLAYA_HOST=127.0.0.1:11435 \
    OLLAYA_DEVICE=cpu

USER root
RUN mkdir -p /opt/ollaya/models && chown -R ollaya:ollaya /opt/ollaya
USER ollaya

# Pull by digest with a short-lived server bound to loopback inside the build.
# Every argument is checked first so a missing pin fails the build instead of
# pulling whatever a tag points at today.
RUN set -eu; \
    printf '%s' "${SCREENER_MODEL}" | grep -Eq '^[^:@[:space:]]+:[^:@[:space:]]+$' \
      || { echo "SCREENER_MODEL must be name:tag; an untagged digest pull is stored under name@sha256 and the gateway's model name would not match" >&2; exit 1; }; \
    printf '%s' "${SCREENER_MODEL_SHA256}" | grep -Eq '^[0-9a-f]{64}$' \
      || { echo "SCREENER_MODEL_SHA256 must be 64 lowercase hex characters, no prefix" >&2; exit 1; }; \
    ollaya serve >/tmp/ollaya-build.log 2>&1 & server=$!; \
    ready=0; for _ in $(seq 1 60); do \
      if ollaya list >/dev/null 2>&1; then ready=1; break; fi; sleep 1; \
    done; \
    test "$ready" = 1 || { cat /tmp/ollaya-build.log >&2; exit 1; }; \
    ollaya pull "${SCREENER_MODEL}@sha256:${SCREENER_MODEL_SHA256}"; \
    for pin in ${SCREENER_EXTRA_PINS}; do \
      printf '%s' "$pin" | grep -Eq '@sha256:[0-9a-f]{64}$' \
        || { echo "SCREENER_EXTRA_PINS entry is not name@sha256:<64 hex>: $pin" >&2; exit 1; }; \
      ollaya pull "$pin"; \
    done; \
    ollaya list; \
    kill "$server"; wait "$server" || true; \
    rm -f /tmp/ollaya-build.log

# Inside the container network only; the compose file publishes no port.
ENV OLLAYA_HOST=0.0.0.0:11435
EXPOSE 11435

# Liveness only, for container restarts. The gateway's own probe (a fixed
# canary that must parse) decides readiness and feeds its breaker, and the
# gateway's /health never depends on this container.
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD ["ollaya", "list"]

ENTRYPOINT ["ollaya", "serve"]

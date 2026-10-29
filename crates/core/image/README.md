# ryu-image

Image-generation modality primitive for Ryu: local or Gateway-routed image
generation and image-to-image edits behind a swappable engine seam.

## Role in the decomposition

An extracted Core capability crate — **in-process by default** and consumed as a
**non-optional path dependency**: the `POST /api/images/generate` data path reaches
it unconditionally. It owns the image-gen abstraction + routing — prompt
validation, default-count, local-vs-cloud dispatch, and the media proxy /
gateway-forward mechanics. It carries **zero dependency on `apps/core`**. Host
couplings it cannot own (the local sd-server base-url, the Gateway url/token, and
lazy-starting the sd.cpp sidecar) inject via the narrow `ImageHost` trait.

## Key API (`src/lib.rs`)

- `ImageHost` — supplies local sd-server base-url, Gateway url/token, sidecar start.
- `generate(host, body) -> MediaResponse` — the entry point (validate → dispatch).
- `cloud_provider(body)` — reads the `"provider"` field to pick a cloud provider,
  else local.
- `forward_to_gateway` / `proxy` — cloud-via-Gateway and local-proxy mechanics.
- `MediaResponse = (u16, Value)` — status + JSON body; Core maps it back to axum.

## Swap seam

- **stable-diffusion.cpp** — local default (lazy-started sidecar), with text-to-image
  routed through `/v1/images/generations` and inline image edits through
  `/sdapi/v1/img2img`.
- **OpenRouter / Replicate / fal** — cloud providers, routed through the Gateway's
  `/v1/images/generations`, selected by the request `"provider"` field.

## Local image editing

Ryu's editor sends one inline `input_images` data URL, an optional `input_mask`,
and a `WIDTHxHEIGHT` size. Core validates that image inputs are local inline raster
data, adapts the request to stable-diffusion.cpp's img2img JSON contract, and
normalizes the returned `images` field to the shared `data[].b64_json` response.
The desktop's default resize engine is local; Gateway generation is an explicit
alternate.

## Consumed as

Compiled-into-Core crate (default path dependency); no optional features.

---
name: ryu-local-model
description: Search, download, and serve a local GGUF model on a Ryu node via Core's models and engines REST surface. Covers catalog search and device-fit, installing a specific quantization, activating a model, and listing engines (the engine is derived from the model format). Use when a user wants to get a local model running on their node.
---

# Local models on Ryu

This skill manages local models on a Ryu node. If Ryu is not running, do [[setup-ryu]] first. Over MCP the same actions are `ryu_search_models`, `ryu_get_active_model`, `ryu_set_active_model`, and `ryu_list_engines` from [[ryu-mcp]].

Base URL is the Core node, default `http://127.0.0.1:7980`. The catalog is Hugging Face GGUF by default. The engine is derived from the model format, so for GGUF you normally just pick a model and Core runs it on the matching engine.

## Search the catalog

`GET /api/models/catalog` with query params:

- `query` - free-text search.
- `format` - `gguf` (default), `safetensors`, or `mlx`.
- `sort` - `trending`, `downloads`, `likes`, or `recent`.
- `limit` - max results.
- `task` - Hugging Face pipeline tag (for example `text-generation`, `image-text-to-text`).
- `author` - filter by org.
- `installed_only` - `true` to show only installed models.
- `cursor` - pagination cursor for the next page.

```sh
curl -s "http://127.0.0.1:7980/api/models/catalog?query=llama&format=gguf&sort=trending&limit=10"
```

Each card carries `compatible`, `needsEngine`, params, context length, and tags so you can tell what will run on this node.

## Inspect quantizations and device-fit

```sh
curl -s "http://127.0.0.1:7980/api/models/catalog/detail?id=<repo_id>&format=gguf"
```

This returns each downloadable GGUF file with a fit verdict (`too_big`, `cpu`, `partial`, `ok`, `great`, or `unknown`), human size, and quant label, computed against the node's detected hardware. Prefer `ok` or `great` for a responsive local experience.

## Install a model file

Download one specific GGUF quantization through Core's verified downloader:

```sh
curl -s -X POST http://127.0.0.1:7980/api/models/catalog/install \
  -H 'content-type: application/json' \
  -d '{"id":"<repo_id>","file":"<filename.gguf>","format":"gguf"}'
```

To remove a downloaded file:

```sh
curl -s -X POST http://127.0.0.1:7980/api/models/catalog/uninstall \
  -H 'content-type: application/json' \
  -d '{"id":"<repo_id>","file":"<filename.gguf>"}'
```

## Activate (serve) a model

`POST /api/models/active` switches the model the local chat stack serves. `id` is the local stem or HF repo id of an already-installed model; pass `engine` only to override the format-derived engine.

```sh
curl -s -X POST http://127.0.0.1:7980/api/models/active \
  -H 'content-type: application/json' \
  -d '{"id":"<repo_id_or_stem>"}'
```

Read the current selection:

```sh
curl -s http://127.0.0.1:7980/api/models/active
```

## Engines

- `GET /api/engines` - list runnable engines on this node.
- `GET /api/engine/active` - the active engine.
- `GET /api/models/engines` - engine availability keyed for the catalog.

Because the engine is derived from the model format, you rarely set it by hand: GGUF runs on the llama.cpp-class engine, while safetensors and MLX map to their own engines and may show `compatible: false` with a `needsEngine` label if that engine is not runnable here.

## End-to-end

1. `GET /api/models/catalog?query=...&format=gguf` to find a model.
2. `GET /api/models/catalog/detail?id=...&format=gguf` to pick a quant that fits.
3. `POST /api/models/catalog/install` with that file.
4. `POST /api/models/active` with the model id.
5. Confirm with `GET /api/models/active`.

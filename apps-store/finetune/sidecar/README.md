# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; Ryu Unsloth Sidecar

> A Core-managed runtime for LoRA/QLoRA fine-tuning. Part of [Ryu](../../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](../../../README.md#repository-layout--licensing)
[![Stack](https://shieldcn.dev/badge/Python-FastAPI-3776AB.svg?logo=python&logoColor=white)](../../../README.md)

A Core-managed Python runtime that wraps the Apache-2.0 [`unsloth`](https://github.com/unslothai/unsloth) library (+ TRL `SFTTrainer`) to run LoRA/QLoRA fine-tuning behind one small HTTP contract. Ryu Core owns lifecycle, persistence, routing, and the desktop UI, so this process only trains. It uses the library, not Unsloth's AGPL-3.0 Studio UI. Same shape as `apps-store/voice/sidecar`: a pure runtime Core spawns and health-checks, fenced out of the bun/turbo workspace, on its own Python toolchain.

**Tier:** OSS, Apache-2.0

## Run

```bash
bun run dev:unsloth          # from repo root → python -m ryu_unsloth on 127.0.0.1:8086
```

Install deps into a venv first:

```bash
cd apps-store/finetune/sidecar
python -m venv .venv && . .venv/Scripts/activate   # Windows; use bin/ on *nix
pip install -e .            # server only (boots anywhere)
pip install -e ".[train]"   # + the training stack (needs a CUDA GPU to train)
```

## What it provides

- **Fine-tune jobs over HTTP:** `POST /finetune` starts a job; `GET /finetune[/{id}]` lists/inspects snapshots; `GET /finetune/{id}/stream` is SSE progress; `DELETE /finetune/{id}` cancels cooperatively.
- **Dataset formats:** `chat`, `alpaca`, or `text` samples, with configurable `lora` and `training` blocks (epochs, learning rate, batch size, 4-bit load, …).
- **Hardware honesty:** `GET /health` reports `can_finetune`/`backend`/`gpu`/`vram_bytes`; Core gates local training on it and falls back to a remote node. Training needs an NVIDIA CUDA GPU (compute ≥ 7.0); CPU/Apple-Silicon machines can run the server but not train.
- **Adapter output:** a LoRA adapter under `RYU_UNSLOTH_OUTPUT_DIR` (Core points this at `~/.ryu/models`; defaults to `./outputs` in dev).

## Env

| Var | Default | Meaning |
|---|---|---|
| `RYU_UNSLOTH_HOST` | `127.0.0.1` | bind host |
| `RYU_UNSLOTH_PORT` | `8086` | bind port |
| `RYU_UNSLOTH_OUTPUT_DIR` | `./outputs` | where adapters are written |
| `HF_HOME` | (HF default) | model cache (Core points it into `~/.ryu`) |

## License

Apache-2.0. See [LICENSE](../../../README.md#repository-layout--licensing). © 2026 A Major Pte. Ltd.

"""Ryu TTS sidecar — a thin, universal HTTP front over many TTS engines.

One normalized contract for every engine:

    GET  /health             -> { ok, engines: [...ids that can run...] }
    GET  /engines            -> [ EngineInfo ]   (catalog Core mirrors for the picker)
    POST /generate           -> audio/wav        (body: GenerateRequest)
    POST /unload             -> { unloaded }      (free a model's memory)

Core owns lifecycle, routing, downloads, and the `?engine=` selector on
`/api/voice/speak`; this process is a pure inference runtime. Adding an engine is
one registry row + one backend file — no change here.
"""

from __future__ import annotations

import anyio
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import registry
from .audio import to_wav_bytes

app = FastAPI(title="Ryu TTS Sidecar", version="0.1.0")


class GenerateRequest(BaseModel):
    text: str = Field(..., description="The words to speak.")
    engine: str = Field(..., description="Engine id from /engines (e.g. 'kitten').")
    voice: str | None = Field(None, description="Voice id; defaults to engine default.")
    speed: float = Field(1.0, description="Speaking-rate multiplier where supported.")
    language: str = Field("en")
    reference_audio: str | None = Field(
        None, description="Wav path/URL for cloning engines (ignored otherwise)."
    )
    seed: int | None = None


def _engine_info(cfg: registry.EngineConfig) -> dict:
    return {
        "id": cfg.id,
        "display_name": cfg.display_name,
        "description": cfg.description,
        "voices": cfg.voices,
        "default_voice": cfg.default_voice,
        "sample_rate": cfg.sample_rate,
        "supports_cloning": cfg.supports_cloning,
        "languages": cfg.languages,
        "size_mb": cfg.size_mb,
        "pip_packages": cfg.pip_packages,
        "installed": registry.is_installed(cfg),
        "loaded": cfg.id in registry.loaded_ids(),
    }


@app.get("/health")
def health() -> dict:
    runnable = [c.id for c in registry.ENGINES if registry.is_installed(c)]
    return {"ok": True, "engines": runnable, "total": len(registry.ENGINES)}


@app.get("/engines")
def engines() -> list[dict]:
    return [_engine_info(c) for c in registry.ENGINES]


@app.get("/models")
def models() -> list[dict]:
    """The curated, installable TTS model catalog (voicebox-style) — every
    engine's known-good model variants, each bound to its engine + cache state.
    Core mirrors this for the desktop's curated TTS lane."""
    return registry.all_models()


class InstallRequest(BaseModel):
    engine: str = Field(..., description="Engine id the model belongs to.")
    model_name: str = Field(..., description="Curated model_name from /models.")


@app.post("/models/install")
async def models_install(req: InstallRequest) -> dict:
    """Download a curated model into the (Core-managed) HF cache via
    `huggingface_hub.snapshot_download`. Idempotent: a cache hit returns fast.
    Core wraps this in a DownloadCenter entry for progress visibility."""
    variant = registry.find_model(req.engine, req.model_name)
    if variant is None:
        return JSONResponse(
            {"error": f"unknown model '{req.model_name}' for engine '{req.engine}'"},
            status_code=404,
        )
    try:
        from huggingface_hub import snapshot_download

        path = await anyio.to_thread.run_sync(
            lambda: snapshot_download(repo_id=variant.hf_repo_id)
        )
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            {"error": f"downloading {variant.hf_repo_id} failed: {exc}"},
            status_code=502,
        )
    return {
        "installed": True,
        "engine": req.engine,
        "model_name": req.model_name,
        "hf_repo_id": variant.hf_repo_id,
        "path": str(path),
    }


@app.post("/unload")
def unload(body: dict) -> dict:
    engine_id = str(body.get("engine", ""))
    cfg = registry.get_config(engine_id)
    if cfg is None:
        return JSONResponse({"error": f"unknown engine '{engine_id}'"}, status_code=404)
    backend = registry.get_backend(engine_id)
    was_loaded = backend.is_loaded()
    backend.unload()
    return {"unloaded": was_loaded, "engine": engine_id}


@app.post("/generate")
async def generate(req: GenerateRequest) -> Response:
    text = req.text.strip()
    if not text:
        return JSONResponse({"error": "missing `text`"}, status_code=400)

    cfg = registry.get_config(req.engine)
    if cfg is None:
        available = [c.id for c in registry.ENGINES]
        return JSONResponse(
            {"error": f"unknown engine '{req.engine}'", "available": available},
            status_code=404,
        )

    if not registry.is_installed(cfg):
        hint = " ".join(cfg.pip_packages) or cfg.backend_module
        return JSONResponse(
            {
                "error": f"engine '{cfg.id}' is not installed",
                "hint": f"pip install {hint}",
            },
            status_code=503,
        )

    try:
        backend = registry.get_backend(req.engine)
        # Inference is blocking (CPU/GPU); run it off the event loop.
        samples, sample_rate = await anyio.to_thread.run_sync(
            lambda: backend.generate(
                text,
                voice=req.voice,
                speed=req.speed,
                language=req.language,
                reference_audio=req.reference_audio,
                seed=req.seed,
            )
        )
    except Exception as exc:  # noqa: BLE001 — surface any engine error to the caller
        return JSONResponse(
            {"error": f"synthesis failed in '{req.engine}': {exc}"}, status_code=502
        )

    wav = to_wav_bytes(samples, sample_rate)
    if not wav:
        return JSONResponse({"error": "engine produced empty audio"}, status_code=502)
    return Response(content=wav, media_type="audio/wav")

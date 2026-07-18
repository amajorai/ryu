"""Ryu Unsloth sidecar — a thin HTTP front over the Unsloth training loop.

One small contract Core drives:

    GET    /health               -> { ok, can_finetune, gpu, vram_bytes, ... }
    POST   /finetune             -> { job_id, state }   (starts a job)
    GET    /finetune             -> [ JobSnapshot ]
    GET    /finetune/{id}        -> JobSnapshot
    GET    /finetune/{id}/stream -> text/event-stream of progress events
    DELETE /finetune/{id}        -> { cancelling }       (cooperative cancel)

Core owns persistence (Unit 2), the adapter catalog (Unit 3), merge→GGUF (Unit 4),
remote routing (Unit 5), and the desktop UI. This process only trains.
"""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any, Optional

import anyio
from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import __version__, device
from .jobs import STORE, TERMINAL, Job
from .trainer import run_job

app = FastAPI(title="Ryu Unsloth Sidecar", version=__version__)


class LoraConfig(BaseModel):
    r: Optional[int] = None
    alpha: Optional[int] = None
    dropout: Optional[float] = None
    target_modules: Optional[list[str]] = None


class TrainingConfig(BaseModel):
    epochs: Optional[float] = None
    max_steps: Optional[int] = None
    learning_rate: Optional[float] = None
    batch_size: Optional[int] = None
    grad_accum: Optional[int] = None
    max_seq_length: Optional[int] = None
    load_in_4bit: Optional[bool] = None
    seed: Optional[int] = None


class FinetuneRequest(BaseModel):
    base_model_id: str = Field(..., description="HF repo id (ideally an unsloth/*-bnb-4bit).")
    dataset: dict[str, Any] = Field(..., description="See ryu_unsloth.dataset for shapes.")
    output_name: Optional[str] = Field(None, description="Stem for the saved adapter dir.")
    lora: Optional[LoraConfig] = None
    training: Optional[TrainingConfig] = None


def _flatten(req: FinetuneRequest) -> dict[str, Any]:
    config: dict[str, Any] = {
        "base_model_id": req.base_model_id,
        "dataset": req.dataset,
        "output_name": req.output_name,
    }
    if req.lora:
        config.update(
            lora_r=req.lora.r,
            lora_alpha=req.lora.alpha,
            lora_dropout=req.lora.dropout,
            target_modules=req.lora.target_modules,
        )
    if req.training:
        config.update(
            epochs=req.training.epochs,
            max_steps=req.training.max_steps,
            learning_rate=req.training.learning_rate,
            batch_size=req.training.batch_size,
            grad_accum=req.training.grad_accum,
            max_seq_length=req.training.max_seq_length,
            load_in_4bit=req.training.load_in_4bit,
            seed=req.training.seed,
        )
    return {k: v for k, v in config.items() if v is not None}


@app.get("/health")
def health() -> dict:
    probe = device.probe()
    return {"ok": True, "version": __version__, **probe}


@app.post("/finetune")
def finetune(req: FinetuneRequest) -> JSONResponse:
    if not str(req.base_model_id).strip():
        return JSONResponse({"error": "missing base_model_id"}, status_code=400)
    if not (req.dataset.get("samples") or req.dataset.get("path")):
        return JSONResponse(
            {"error": "dataset needs `samples` or a `path`"}, status_code=400
        )
    job = STORE.create(_flatten(req))
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return JSONResponse({"job_id": job.id, "state": job.state})


class MergeRequest(BaseModel):
    adapter_name: Optional[str] = Field(None, description="Adapter dir under the output dir.")
    adapter_path: Optional[str] = Field(None, description="Absolute path to an adapter dir.")
    output_name: Optional[str] = Field(None, description="Stem for the merged .gguf.")
    base_model_id: Optional[str] = Field(None, description="Provenance (recorded by Core).")
    quantization_method: str = Field("q4_k_m", description="GGUF quant, e.g. q4_k_m / q8_0 / f16.")
    max_seq_length: Optional[int] = None


@app.post("/finetune/merge")
async def merge(req: MergeRequest) -> JSONResponse:
    if not (req.adapter_name or req.adapter_path):
        return JSONResponse(
            {"error": "need `adapter_name` or `adapter_path`"}, status_code=400
        )
    from .merge import run_merge

    try:
        # Merging loads + converts weights (heavy, blocking) — run off the loop.
        result = await anyio.to_thread.run_sync(lambda: run_merge(req.model_dump()))
    except Exception as exc:  # noqa: BLE001 — surface any merge error to Core
        return JSONResponse({"error": f"merge failed: {exc}"}, status_code=502)
    return JSONResponse(result)


@app.get("/finetune")
def list_jobs() -> list[dict]:
    return [j.snapshot() for j in STORE.list()]


@app.get("/finetune/{job_id}")
def get_job(job_id: str) -> JSONResponse:
    job = STORE.get(job_id)
    if job is None:
        return JSONResponse({"error": f"unknown job '{job_id}'"}, status_code=404)
    return JSONResponse(job.snapshot())


@app.delete("/finetune/{job_id}")
def cancel_job(job_id: str) -> JSONResponse:
    job = STORE.get(job_id)
    if job is None:
        return JSONResponse({"error": f"unknown job '{job_id}'"}, status_code=404)
    if job.state in TERMINAL:
        return JSONResponse({"cancelling": False, "state": job.state})
    job.request_cancel()
    return JSONResponse({"cancelling": True, "state": job.state})


@app.get("/finetune/{job_id}/stream")
async def stream_job(job_id: str) -> StreamingResponse:
    job = STORE.get(job_id)
    if job is None:
        return JSONResponse({"error": f"unknown job '{job_id}'"}, status_code=404)
    return StreamingResponse(_sse(job), media_type="text/event-stream")


async def _sse(job: Job):
    """Stream progress events by index, then terminate once the job is terminal
    and the event log is fully drained. Polling keeps it cross-thread-safe (the
    trainer appends events from a worker thread)."""
    # Replay anything already recorded, then a current snapshot.
    yield _frame("snapshot", job.snapshot())
    index = 0
    while True:
        new = job.events_since(index)
        for ev in new:
            yield _frame("event", ev)
        index += len(new)
        if job.state in TERMINAL and index >= len(job.events):
            yield _frame("end", job.snapshot())
            return
        await asyncio.sleep(0.5)


def _frame(kind: str, payload: Any) -> str:
    return f"event: {kind}\ndata: {json.dumps(payload)}\n\n"

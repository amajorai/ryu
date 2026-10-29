from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import laya
from laya import Router
from ryu_laya.decision import parse_computer_use_result


LOGGER = logging.getLogger("ryu_laya")
MODEL_ROOT = Path(os.environ.get("RYU_LAYA_MODEL_ROOT", "")).expanduser()
MAX_REQUEST_BYTES = 512 * 1024
MAX_QUESTIONS = 64
MAX_STATE_BYTES = 256 * 1024
SUPPORTED_MODELS = ("router", "english", "multilingual", "typed-decisions")

app = FastAPI(
    title="Ryu Laya",
    version="0.1.0",
    description="Local typed-decision inference using the Apache-2.0 Laya checkpoints.",
)
_router: Router | None = None
_router_lock = asyncio.Lock()
_inference_lock = asyncio.Lock()


def _model_directory(name: str) -> Path:
    if name == "english":
        return MODEL_ROOT
    return MODEL_ROOT / name


def _model_ready(name: str) -> bool:
    model_dir = _model_directory(name)
    return all(
        (
            (model_dir / "model.safetensors").is_file(),
            (model_dir / "rl_agent_config.json").is_file(),
            (model_dir / "tokenizer" / "tokenizer.json").is_file(),
        )
    )


def _model_specs() -> dict[str, str | tuple[str, str]]:
    # Every profile is bundled by the manifest. Keeping the map local means the
    # sidecar can run offline after install and never silently fall back to the Hub.
    specs: dict[str, str | tuple[str, str]] = {}
    for name in SUPPORTED_MODELS[1:]:
        if _model_ready(name):
            specs[name] = str(_model_directory(name))
    return specs


def _new_router() -> Router:
    specs = _model_specs()
    if not specs:
        raise RuntimeError(
            "no Laya checkpoint is installed; enable the plugin again to provision its model bundle"
        )
    return Router(models=specs, max_loaded=1, auto_task_detection=False, preload=False)


async def _get_router() -> Router:
    global _router
    if _router is not None:
        return _router
    async with _router_lock:
        if _router is None:
            _router = await asyncio.to_thread(_new_router)
    return _router


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _validate_request(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("request body must be an object")
    if "state" not in body or "questions" not in body:
        raise ValueError("state and questions are required")
    if _json_size(body) > MAX_REQUEST_BYTES:
        raise ValueError("request body is too large")
    if _json_size(body["state"]) > MAX_STATE_BYTES:
        raise ValueError("state is too large")
    questions = body["questions"]
    if not isinstance(questions, dict) or not questions:
        raise ValueError("questions must be a non-empty object")
    if len(questions) > MAX_QUESTIONS:
        raise ValueError(f"questions may contain at most {MAX_QUESTIONS} entries")
    for question_id, question in questions.items():
        if not isinstance(question_id, str) or not question_id.strip():
            raise ValueError("question ids must be non-empty strings")
        if not isinstance(question, dict):
            raise ValueError(f"question '{question_id}' must be an object")
    model = body.get("model")
    if model is not None and model not in SUPPORTED_MODELS:
        raise ValueError(f"model must be one of {', '.join(SUPPORTED_MODELS)}")
    task = body.get("task")
    if task is not None and (not isinstance(task, str) or len(task) > 64):
        raise ValueError("task must be a short string")
    lang = body.get("lang")
    if lang is not None and (not isinstance(lang, str) or len(lang) > 32):
        raise ValueError("lang must be a short string")
    return body


def _safe_error(error: Exception) -> str:
    message = str(error).strip().replace("\n", " ")
    return message[:400] or "local Laya inference failed"


@app.middleware("http")
async def authenticate(request: Request, call_next):
    if request.method == "GET" and request.url.path == "/health":
        return await call_next(request)
    expected = os.environ.get("RYU_EXT_TOKEN", "")
    supplied = request.headers.get("authorization", "")
    if not expected or not supplied.startswith("Bearer ") or not hmac.compare_digest(
        supplied[7:].strip(), expected
    ):
        return JSONResponse(
            status_code=401,
            content={"error": {"code": "unauthorized", "message": "sidecar authorization required"}},
        )
    return await call_next(request)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "service": "ryu-laya", "models": list(_model_specs())}


@app.get("/capability")
async def capability() -> dict[str, Any]:
    return {
        "available": bool(_model_specs()),
        "library": "laya",
        "version": getattr(laya, "__version__", "unknown"),
        "license": "Apache-2.0",
        "source": "convaiinnovations/laya",
        "models": list(_model_specs()),
        "primitives": ["choice", "score", "noul"],
        "generates_text": False,
    }


@app.get("/models")
async def models() -> dict[str, Any]:
    return {
        "models": [
            {"id": name, "installed": name == "router" or _model_ready(name)}
            for name in SUPPORTED_MODELS
        ]
    }


@app.post("/predict")
async def predict(request: Request) -> JSONResponse:
    try:
        body = _validate_request(await request.json())
    except (ValueError, json.JSONDecodeError) as error:
        return JSONResponse(status_code=400, content={"error": {"code": "invalid_request", "message": str(error)}})

    model = body.get("model")
    model_arg = None if model in (None, "router") else model
    try:
        await asyncio.wait_for(_inference_lock.acquire(), timeout=0.25)
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=429,
            content={
                "error": {
                    "code": "inference_busy",
                    "message": "another local Laya inference is still running",
                }
            },
        )
    try:
        router = await _get_router()
        result = await asyncio.to_thread(
            router.predict,
            body["state"],
            body["questions"],
            model_arg,
            body.get("task"),
            body.get("lang"),
        )
    except Exception as error:
        LOGGER.exception("laya prediction failed")
        return JSONResponse(status_code=503, content={"error": {"code": "inference_unavailable", "message": _safe_error(error)}})
    finally:
        _inference_lock.release()
    return JSONResponse(content=result)


@app.post("/computer-use")
async def computer_use(request: Request) -> JSONResponse:
    try:
        incoming = await request.json()
        if not isinstance(incoming, dict):
            raise ValueError("request body must be an object")
        body = _validate_request(
            {
                "model": incoming.get("model_id"),
                "state": incoming.get("state"),
                "questions": incoming.get("questions"),
            }
        )
    except (ValueError, json.JSONDecodeError) as error:
        return JSONResponse(status_code=400, content={"error": {"code": "invalid_request", "message": str(error)}})

    try:
        await asyncio.wait_for(_inference_lock.acquire(), timeout=0.25)
    except TimeoutError:
        return JSONResponse(
            status_code=429,
            content={"error": {"code": "inference_busy", "message": "another local Laya inference is still running"}},
        )
    try:
        router = await _get_router()
        result = await asyncio.to_thread(
            router.predict,
            body["state"],
            body["questions"],
            None if body.get("model") in (None, "router") else body["model"],
            None,
            None,
        )
        decision = parse_computer_use_result(result, body["questions"])
    except Exception as error:
        LOGGER.exception("Laya computer-use decision failed")
        return JSONResponse(status_code=503, content={"error": {"code": "inference_unavailable", "message": _safe_error(error)}})
    finally:
        _inference_lock.release()
    return JSONResponse(content=decision)


def run() -> None:
    logging.basicConfig(level=os.environ.get("RYU_LAYA_LOG_LEVEL", "INFO"))
    host = os.environ.get("RYU_LAYA_HOST", "127.0.0.1")
    port = int(os.environ.get("RYU_LAYA_PORT", "8098"))
    uvicorn.run(app, host=host, port=port, log_level="info")

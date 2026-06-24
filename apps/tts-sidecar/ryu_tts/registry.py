"""Universal TTS engine registry — the "voicebox way", Ryu-shaped.

The whole point of this module: adding a new TTS engine is **one new backend
file + one registry row**. The HTTP layer (`server.py`) never grows a per-engine
branch — it looks an engine up here, asks the factory for its backend, and calls
the same `TtsBackend` protocol on every engine.

This mirrors `jamiepine/voicebox`'s `backends/__init__.py` design (MIT licensed):
a declarative `EngineConfig` registry + a lazy factory. The difference is that in
Ryu *Core* owns lifecycle/routing/downloads — this process is a pure inference
runtime, the same way Core treats whisper.cpp's `whisper-server` and
stable-diffusion.cpp's `sd-server` as managed external runtimes.
"""

from __future__ import annotations

import importlib
import importlib.util
import pathlib
import threading
from dataclasses import dataclass, field
from typing import Optional, Protocol, runtime_checkable

import numpy as np


@dataclass(frozen=True)
class ModelVariant:
    """One curated, installable model an engine can serve — voicebox's
    `ModelConfig`. The `hf_repo_id` is the Hugging Face repo; Core downloads it
    into the engine's HF cache (under a Core-managed `HF_HOME`) so the engine
    loads it as a cache hit. This is the *known-good* set, distinct from the raw
    HF `pipeline_tag=text-to-speech` firehose (which Core surfaces as discovery)."""

    model_name: str  # stable id, e.g. "kitten-tts-mini-0.8"
    display_name: str
    hf_repo_id: str
    size_mb: int = 0
    languages: list[str] = field(default_factory=lambda: ["en"])
    default: bool = False  # the engine's default model variant


@dataclass(frozen=True)
class EngineConfig:
    """Declarative description of one TTS engine.

    Everything the API and Core's catalog need to know *about* an engine without
    importing its (heavy, optional) inference dependencies.
    """

    id: str  # stable identifier used by `?engine=` end to end (e.g. "kitten")
    display_name: str
    description: str
    backend_module: str  # dotted path under `ryu_tts.backends`, e.g. "kitten"
    backend_class: str  # class name implementing `TtsBackend`
    import_name: str  # top-level module proving the engine's deps exist (e.g. "kittentts")
    default_voice: str
    voices: list[str]
    sample_rate: int  # nominal output rate (an engine may override at generate time)
    supports_cloning: bool  # True if `reference_audio` (a wav path/url) is honoured
    languages: list[str] = field(default_factory=lambda: ["en"])
    size_mb: int = 0
    pip_packages: list[str] = field(default_factory=list)  # for the install hint
    # Curated installable model variants for this engine (the voicebox registry).
    models: list[ModelVariant] = field(default_factory=list)


@runtime_checkable
class TtsBackend(Protocol):
    """The single contract every engine implements. Synchronous on purpose —
    inference is CPU/GPU-bound and `server.py` runs it in a threadpool."""

    config: EngineConfig

    def load(self) -> None:
        """Load weights into memory (idempotent; called before first generate)."""
        ...

    def generate(
        self,
        text: str,
        *,
        voice: Optional[str] = None,
        speed: float = 1.0,
        language: str = "en",
        reference_audio: Optional[str] = None,
        seed: Optional[int] = None,
    ) -> tuple[np.ndarray, int]:
        """Synthesize speech. Returns ``(samples, sample_rate)`` where ``samples``
        is a 1-D float32 (or int16) mono array. `reference_audio` is a local wav
        path or URL used only by cloning-capable engines."""
        ...

    def unload(self) -> None:
        """Release model memory."""
        ...

    def is_loaded(self) -> bool:
        ...


# ---------------------------------------------------------------------------
# The registry. Add an engine = append one EngineConfig row here + drop a
# `backends/<module>.py` implementing `TtsBackend`. Nothing else changes.
# ---------------------------------------------------------------------------

ENGINES: list[EngineConfig] = [
    EngineConfig(
        id="kitten",
        display_name="KittenTTS",
        description="Ultra-light (15-80M) ONNX TTS · CPU-only · fixed expressive voices",
        backend_module="kitten",
        backend_class="KittenBackend",
        import_name="kittentts",
        default_voice="Jasper",
        voices=["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"],
        sample_rate=24000,
        supports_cloning=False,
        languages=["en"],
        size_mb=80,
        pip_packages=["kittentts"],
        models=[
            ModelVariant(
                model_name="kitten-tts-mini-0.8",
                display_name="KittenTTS Mini (80M)",
                hf_repo_id="KittenML/kitten-tts-mini-0.8",
                size_mb=80,
                default=True,
            ),
            ModelVariant(
                model_name="kitten-tts-nano-0.1",
                display_name="KittenTTS Nano (15M)",
                hf_repo_id="KittenML/kitten-tts-nano-0.1",
                size_mb=25,
            ),
        ],
    ),
    EngineConfig(
        id="pocket",
        display_name="Pocket TTS (Kyutai)",
        description="100M CPU TTS · ~6x realtime · ~200ms first audio · voice cloning",
        backend_module="pocket",
        backend_class="PocketBackend",
        import_name="pocket_tts",
        default_voice="alba",
        voices=[
            "alba", "giovanni", "lola", "juergen", "rafael", "estelle", "anna",
            "azelma", "charles", "cosette", "eve", "fantine", "george", "jane",
            "jean", "javert", "marius", "mary", "michael", "paul", "vera",
        ],
        sample_rate=24000,
        supports_cloning=True,
        languages=["en"],
        size_mb=100,
        pip_packages=["pocket-tts"],
        models=[
            ModelVariant(
                model_name="pocket-tts",
                display_name="Pocket TTS (100M)",
                hf_repo_id="kyutai/pocket-tts-without-voice-cloning",
                size_mb=100,
                default=True,
            ),
        ],
    ),
]

_BY_ID: dict[str, EngineConfig] = {e.id: e for e in ENGINES}

# Cached backend instances, created lazily and reused (one model load per engine).
_instances: dict[str, TtsBackend] = {}
_lock = threading.Lock()


def get_config(engine_id: str) -> Optional[EngineConfig]:
    return _BY_ID.get(engine_id)


def is_installed(cfg: EngineConfig) -> bool:
    """Whether the engine can actually run — i.e. its heavy inference dependency
    is importable. We check `import_name` (the engine's own package) via
    `find_spec`, not the thin backend wrapper, because backends defer their heavy
    imports to `load()` so the wrapper imports even when the engine is absent."""
    if not cfg.import_name:
        return True
    try:
        return importlib.util.find_spec(cfg.import_name) is not None
    except Exception:
        return False


def get_backend(engine_id: str) -> TtsBackend:
    """Lazily instantiate (and cache) the backend for an engine.

    Imports happen here, not at module load, so a missing optional dependency for
    one engine never breaks the whole server — only that engine fails."""
    if engine_id in _instances:
        return _instances[engine_id]

    cfg = _BY_ID.get(engine_id)
    if cfg is None:
        raise ValueError(
            f"unknown TTS engine '{engine_id}'. Available: {sorted(_BY_ID)}"
        )

    with _lock:
        if engine_id in _instances:
            return _instances[engine_id]
        module = importlib.import_module(f"ryu_tts.backends.{cfg.backend_module}")
        backend_cls = getattr(module, cfg.backend_class)
        instance: TtsBackend = backend_cls()
        _instances[engine_id] = instance
        return instance


def loaded_ids() -> set[str]:
    return {eid for eid, b in _instances.items() if b.is_loaded()}


def is_model_cached(hf_repo_id: str) -> bool:
    """Whether a model repo is present in the engine's HF cache (the same cache
    every huggingface_hub-based engine reads, relocated by Core via `HF_HOME`).
    Mirrors voicebox's `is_model_cached`: a `models--<org>--<repo>` dir with a
    non-empty `snapshots/` means it is downloaded."""
    try:
        from huggingface_hub import constants as hf_constants

        repo_cache = (
            pathlib.Path(hf_constants.HF_HUB_CACHE)
            / f"models--{hf_repo_id.replace('/', '--')}"
        )
        snapshots = repo_cache / "snapshots"
        if not snapshots.exists():
            return False
        # A pending download leaves `.incomplete` blobs.
        blobs = repo_cache / "blobs"
        if blobs.exists() and any(blobs.glob("*.incomplete")):
            return False
        return any(snapshots.iterdir())
    except Exception:
        return False


def all_models() -> list[dict]:
    """Flatten every engine's curated model variants into installable rows, each
    bound to its engine and tagged with cache (installed) state."""
    rows: list[dict] = []
    for cfg in ENGINES:
        for m in cfg.models:
            rows.append(
                {
                    "model_name": m.model_name,
                    "display_name": m.display_name,
                    "engine": cfg.id,
                    "engine_display_name": cfg.display_name,
                    "hf_repo_id": m.hf_repo_id,
                    "size_mb": m.size_mb,
                    "languages": m.languages,
                    "default": m.default,
                    "installed": is_model_cached(m.hf_repo_id),
                }
            )
    return rows


def find_model(engine_id: str, model_name: str) -> Optional[ModelVariant]:
    cfg = _BY_ID.get(engine_id)
    if cfg is None:
        return None
    for m in cfg.models:
        if m.model_name == model_name:
            return m
    return None

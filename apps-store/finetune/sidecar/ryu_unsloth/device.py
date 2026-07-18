"""Hardware probe — what this machine can actually train on.

Training with Unsloth effectively requires an NVIDIA CUDA GPU (compute
capability >= 7.0). We report the truth so Core can gate local training and fall
back to a remote node. All imports are deferred and failures are swallowed: a box
without torch/CUDA simply reports ``can_finetune = False`` instead of crashing.
"""

from __future__ import annotations

from typing import Any


def probe() -> dict[str, Any]:
    """Return a hardware summary safe to expose over ``/health``.

    Keys: ``can_finetune`` (bool), ``backend`` ("cuda"|"mps"|"cpu"|"none"),
    ``gpu`` (name or None), ``vram_bytes`` (int), ``compute_capability`` (str|None),
    ``torch_available`` (bool), ``unsloth_available`` (bool), ``reason`` (str).
    """
    info: dict[str, Any] = {
        "can_finetune": False,
        "backend": "none",
        "gpu": None,
        "vram_bytes": 0,
        "compute_capability": None,
        "torch_available": False,
        "unsloth_available": _module_present("unsloth"),
        "reason": "",
    }

    try:
        import torch
    except Exception:  # noqa: BLE001 — torch absent is a normal, reportable state
        info["reason"] = "PyTorch is not installed"
        return info

    info["torch_available"] = True

    try:
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            cc = f"{props.major}.{props.minor}"
            info.update(
                backend="cuda",
                gpu=props.name,
                vram_bytes=int(props.total_memory),
                compute_capability=cc,
            )
            # Unsloth requires CUDA compute capability >= 7.0.
            if props.major >= 7:
                info["can_finetune"] = info["unsloth_available"]
                info["reason"] = (
                    "" if info["unsloth_available"] else "unsloth is not installed"
                )
            else:
                info["reason"] = (
                    f"GPU compute capability {cc} < 7.0 (Unsloth minimum)"
                )
            return info

        # Apple Silicon: inference works, training is unreliable/unsupported today.
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            info.update(backend="mps", reason="Apple MPS: Unsloth training is unsupported")
            return info
    except Exception as exc:  # noqa: BLE001
        info["reason"] = f"GPU probe failed: {exc}"
        return info

    info.update(backend="cpu", reason="No CUDA GPU detected (CPU cannot train)")
    return info


def _module_present(name: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except Exception:  # noqa: BLE001
        return False

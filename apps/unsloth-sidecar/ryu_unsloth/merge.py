"""Merge a trained LoRA adapter into a single GGUF for serving.

llama.cpp serves one merged GGUF — it cannot load a LoRA adapter at serve time —
so this is how a fine-tune becomes a runnable model. Unsloth's
``save_pretrained_gguf`` merges the adapter into the base and converts to GGUF in
one step, preserving the training chat template + EOS (critical: a mismatched
template yields gibberish/runaway generation).

Heavy imports are deferred so the server boots without the training stack.
"""

from __future__ import annotations

import pathlib
import shutil
from typing import Any

from .trainer import output_root


def run_merge(req: dict[str, Any]) -> dict[str, Any]:
    """Load an adapter dir, merge + export to ``<output_dir>/<output_name>.gguf``.

    Returns ``{ gguf_path, stem, size_bytes, base_model }`` for Core to register
    as an installed model. The adapter dir carries its base model in
    ``adapter_config.json`` so Unsloth resolves it automatically.
    """
    from unsloth import FastLanguageModel  # noqa: PLC0415 — order-sensitive, heavy

    adapter = req.get("adapter_path") or str(output_root() / req["adapter_name"])
    adapter_dir = pathlib.Path(adapter)
    if not adapter_dir.exists():
        raise ValueError(f"adapter not found: {adapter_dir}")

    quant = str(req.get("quantization_method") or "q4_k_m")
    output_name = str(req.get("output_name") or f"{adapter_dir.name}-merged")
    max_seq_length = int(req.get("max_seq_length") or 2048)

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=str(adapter_dir),
        max_seq_length=max_seq_length,
        dtype=None,
        load_in_4bit=False,
    )

    # save_pretrained_gguf writes into a directory; export there then flatten the
    # produced .gguf into Core's flat models layout (~/.ryu/models/<stem>.gguf).
    tmp = output_root() / f".gguf-{output_name}"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        model.save_pretrained_gguf(str(tmp), tokenizer, quantization_method=quant)
        ggufs = sorted(tmp.glob("*.gguf"), key=lambda p: p.stat().st_size, reverse=True)
        if not ggufs:
            raise ValueError("merge produced no .gguf file")
        dest = output_root() / f"{output_name}.gguf"
        shutil.move(str(ggufs[0]), str(dest))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    return {
        "gguf_path": str(dest),
        "stem": output_name,
        "size_bytes": dest.stat().st_size,
        "base_model": req.get("base_model_id") or "",
        "quantization_method": quant,
    }

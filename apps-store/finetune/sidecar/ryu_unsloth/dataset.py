"""Dataset normalization — turn the request's dataset into rendered text rows.

We accept three shapes so callers/UI can stay simple, and render each to a single
``text`` field that ``SFTTrainer`` trains on:

  - ``chat``    : {"format":"chat", "samples":[{"messages":[{role,content}, ...]}]}
                  rendered via the tokenizer's chat template (preserves EOS).
  - ``alpaca``  : {"format":"alpaca", "samples":[{instruction,input?,output}]}
  - ``text``    : {"format":"text", "samples":[{"text":"..."}]}  (passthrough)

A ``path`` to a .json/.jsonl file with the same row shapes is also accepted.
"""

from __future__ import annotations

import json
import pathlib
from typing import Any, Optional

_ALPACA_WITH_INPUT = (
    "Below is an instruction that describes a task, paired with an input that "
    "provides further context. Write a response that appropriately completes the "
    "request.\n\n### Instruction:\n{instruction}\n\n### Input:\n{input}\n\n"
    "### Response:\n{output}"
)
_ALPACA_NO_INPUT = (
    "Below is an instruction that describes a task. Write a response that "
    "appropriately completes the request.\n\n### Instruction:\n{instruction}\n\n"
    "### Response:\n{output}"
)


def _load_rows(dataset: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    fmt = str(dataset.get("format", "chat")).lower()
    path = dataset.get("path")
    if path:
        rows = _read_file(str(path))
    else:
        rows = list(dataset.get("samples") or [])
    if not rows:
        raise ValueError("dataset has no samples")
    return fmt, rows


def _read_file(path: str) -> list[dict[str, Any]]:
    p = pathlib.Path(path)
    if not p.exists():
        raise ValueError(f"dataset path not found: {path}")
    raw = p.read_text(encoding="utf-8")
    if p.suffix == ".jsonl":
        return [json.loads(line) for line in raw.splitlines() if line.strip()]
    data = json.loads(raw)
    if isinstance(data, dict) and "samples" in data:
        return list(data["samples"])
    if isinstance(data, list):
        return data
    raise ValueError("json dataset must be a list or {samples:[...]}")


def render_texts(dataset: dict[str, Any], tokenizer: Optional[Any]) -> list[str]:
    """Render every row to a training string, appending EOS where we control it."""
    fmt, rows = _load_rows(dataset)
    eos = getattr(tokenizer, "eos_token", "") or "" if tokenizer else ""
    texts: list[str] = []

    for row in rows:
        if fmt == "text":
            texts.append(str(row["text"]))
        elif fmt == "alpaca":
            instruction = str(row.get("instruction", "")).strip()
            output = str(row.get("output", "")).strip()
            inp = str(row.get("input", "")).strip()
            tmpl = _ALPACA_WITH_INPUT if inp else _ALPACA_NO_INPUT
            texts.append(
                tmpl.format(instruction=instruction, input=inp, output=output) + eos
            )
        elif fmt == "chat":
            messages = row.get("messages")
            if not messages:
                raise ValueError("chat rows must have a `messages` array")
            if tokenizer is not None and hasattr(tokenizer, "apply_chat_template"):
                texts.append(
                    tokenizer.apply_chat_template(
                        messages, tokenize=False, add_generation_prompt=False
                    )
                )
            else:
                # Fallback rendering when no tokenizer template is available.
                joined = "\n".join(
                    f"{m.get('role', 'user')}: {m.get('content', '')}" for m in messages
                )
                texts.append(joined + eos)
        else:
            raise ValueError(f"unknown dataset format '{fmt}'")

    if not texts:
        raise ValueError("dataset rendered to zero training rows")
    return texts

"""In-process fine-tune job registry.

A job carries its config, a coarse status, an append-only list of progress events
(consumed by the SSE endpoint by index — no cross-thread queue needed), and a
cooperative cancel flag the training callback polls. Core persists the durable
record of these jobs (Unit 2); here they live only for the life of the process.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

JobState = Literal["queued", "running", "succeeded", "failed", "cancelled"]
TERMINAL: set[str] = {"succeeded", "failed", "cancelled"}


@dataclass
class Job:
    id: str
    config: dict[str, Any]
    state: JobState = "queued"
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    step: int = 0
    max_steps: int = 0
    loss: Optional[float] = None
    eta_secs: Optional[float] = None
    output_dir: Optional[str] = None
    error: Optional[str] = None
    # Append-only event log; the SSE endpoint streams new entries by index.
    events: list[dict[str, Any]] = field(default_factory=list)
    _cancel: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    # -- progress -----------------------------------------------------------
    def emit(self, etype: str, **data: Any) -> None:
        with self._lock:
            self.events.append({"type": etype, "ts": time.time(), **data})

    def update_progress(
        self,
        *,
        step: int,
        max_steps: int,
        loss: Optional[float],
        eta_secs: Optional[float],
    ) -> None:
        with self._lock:
            self.step = step
            self.max_steps = max_steps
            self.loss = loss
            self.eta_secs = eta_secs
        self.emit("progress", step=step, max_steps=max_steps, loss=loss, eta_secs=eta_secs)

    def mark_running(self) -> None:
        self.state = "running"
        self.started_at = time.time()
        self.emit("state", state="running")

    def mark_done(self, *, output_dir: str) -> None:
        self.state = "succeeded"
        self.output_dir = output_dir
        self.finished_at = time.time()
        self.emit("state", state="succeeded", output_dir=output_dir)

    def mark_failed(self, error: str) -> None:
        self.state = "failed"
        self.error = error
        self.finished_at = time.time()
        self.emit("state", state="failed", error=error)

    def mark_cancelled(self) -> None:
        self.state = "cancelled"
        self.finished_at = time.time()
        self.emit("state", state="cancelled")

    # -- cancellation -------------------------------------------------------
    def request_cancel(self) -> None:
        self._cancel.set()

    def cancel_requested(self) -> bool:
        return self._cancel.is_set()

    # -- views --------------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "id": self.id,
                "state": self.state,
                "created_at": self.created_at,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "step": self.step,
                "max_steps": self.max_steps,
                "loss": self.loss,
                "eta_secs": self.eta_secs,
                "output_dir": self.output_dir,
                "error": self.error,
                "base_model": self.config.get("base_model_id"),
                "output_name": self.config.get("output_name"),
            }

    def events_since(self, index: int) -> list[dict[str, Any]]:
        with self._lock:
            return self.events[index:]


class JobStore:
    """Thread-safe map of job id -> Job."""

    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self, config: dict[str, Any]) -> Job:
        job = Job(id=uuid.uuid4().hex, config=config)
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)


STORE = JobStore()

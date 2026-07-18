"""Smoke test: server boots without the training stack and runs the job lifecycle.

Verifies the Unit-0 acceptance criteria that DON'T need a CUDA GPU:
  - /health returns a probe (can_finetune reflects torch absence)
  - POST /finetune starts a job and returns a job_id
  - the job fails CLEANLY (unsloth missing) instead of crashing the server
  - GET /finetune/{id} reflects the terminal state
  - the SSE stream yields frames and terminates

Live training (a real adapter on disk) needs an NVIDIA GPU and is out of scope here.
"""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from ryu_unsloth.server import app

client = TestClient(app)


def main() -> None:
    # 1. health
    h = client.get("/health").json()
    assert h["ok"] is True, h
    assert "can_finetune" in h and "backend" in h, h
    print(f"health: backend={h['backend']} can_finetune={h['can_finetune']} "
          f"torch={h['torch_available']} unsloth={h['unsloth_available']}")

    # 2. start a tiny job
    body = {
        "base_model_id": "unsloth/tinyllama-bnb-4bit",
        "output_name": "smoke",
        "dataset": {"format": "text", "samples": [{"text": "hello world"}]},
        "training": {"max_steps": 1},
    }
    r = client.post("/finetune", json=body).json()
    job_id = r["job_id"]
    assert job_id, r
    print(f"started job {job_id} state={r['state']}")

    # 3. it must reach a terminal state (failed, since unsloth/torch absent here)
    deadline = time.time() + 20
    snap = {}
    while time.time() < deadline:
        snap = client.get(f"/finetune/{job_id}").json()
        if snap["state"] in {"succeeded", "failed", "cancelled"}:
            break
        time.sleep(0.3)
    assert snap.get("state") in {"succeeded", "failed", "cancelled"}, snap
    print(f"terminal state: {snap['state']} error={snap.get('error')}")

    # 4. SSE stream yields frames and ends
    frames = 0
    with client.stream("GET", f"/finetune/{job_id}/stream") as resp:
        assert resp.status_code == 200
        for line in resp.iter_lines():
            if line.startswith("event:"):
                frames += 1
            if "\"end\"" in line or "end" == line.split(":", 1)[-1].strip():
                break
            if frames > 50:
                break
    assert frames >= 1, "no SSE frames"
    print(f"sse frames: {frames}")

    # 5. validation: bad request rejected
    bad = client.post("/finetune", json={"base_model_id": "x", "dataset": {}})
    assert bad.status_code == 400, bad.text
    print("validation: empty dataset -> 400 OK")

    # 6. 404 for unknown job
    nf = client.get("/finetune/does-not-exist")
    assert nf.status_code == 404
    print("unknown job -> 404 OK")

    print("\nSMOKE_OK")


if __name__ == "__main__":
    main()

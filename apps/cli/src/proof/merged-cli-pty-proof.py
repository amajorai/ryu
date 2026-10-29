#!/usr/bin/env python3
"""Real compiled CLI PTY + strict HTTP proof, not native terminal/screen proof.

Presence waits use ONLY bytes emitted after each input boundary. ANSI stripping
is for presence markers, never absence/current-screen assertions. No VT model is
claimed. Conservative terminal query replies advertise no advanced capabilities;
DSR uses a fixed origin because this driver has no screen/cursor model.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time

BOUNDARY = "Real compiled PTY keyboard + strict synthetic HTTP outcomes; excludes native Terminal pixels/focus/resize and complete screen-state proof."
ROOT = Path(__file__).resolve().parents[4]
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


def external_file(raw, label):
    path = Path(raw)
    if not path.is_absolute() or not path.is_file() or path.resolve().is_relative_to(ROOT):
        raise ValueError(f"{label} must be an existing absolute artifact outside checkout")
    return path.resolve()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--launch", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()
    binary = external_file(args.binary, "binary")
    launch_path = external_file(args.launch, "launch")
    output = Path(args.output)
    if not output.is_absolute() or output.resolve().is_relative_to(ROOT):
        raise ValueError("output must be fresh absolute directory outside checkout")
    if not args.token.startswith("fixture-"):
        raise ValueError("only synthetic fixture token is allowed")
    launch = json.loads(launch_path.read_text())
    origin = launch["origin"]
    if not re.fullmatch(r"http://127\.0\.0\.1:[0-9]+", origin):
        raise ValueError("launch origin must be explicit IPv4 loopback")
    expected_source = ROOT / "apps/cli/src/proof/merged-cli-core-fixture.ts"
    if Path(launch["source"]).resolve() != expected_source:
        raise ValueError("launch must be produced by canonical strict fixture")
    fixture_pid = launch["pid"]
    if not isinstance(fixture_pid, int) or fixture_pid <= 1:
        raise ValueError("invalid fixture process identity")
    command = subprocess.check_output(["ps", "-p", str(fixture_pid), "-o", "command="], text=True)
    if "merged-cli-core-fixture.ts" not in command:
        raise ValueError("fixture PID no longer identifies canonical fixture process")
    proof = launch_path.parent
    if (proof / "summary.json").exists():
        raise ValueError("fixture already stopped; require a fresh active launch artifact")
    if Path(launch["cliConfigDir"]).resolve() != proof / "cli-config" or Path(launch["data"]).resolve() != proof / "data":
        raise ValueError("launch state directories must belong to its isolated proof")
    output.mkdir()
    env = {key: value for key, value in os.environ.items() if not key.startswith("RYU_") and key not in ("OPENCODE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY")}
    env.update(RYU_CLI_CONFIG_DIR=str(proof / "cli-config"), RYU_PROFILE="dev", RYU_KEYCHAIN="off", RYU_DIR=str(proof / "data"), RYU_CORE_URL=origin, RYU_CORE_TOKEN=args.token, RYU_AUTH_URL=origin, RYU_TUI_NO_BOOTSTRAP="1", TERM="xterm-256color", COLORTERM="truecolor")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    # Ctrl+Q must reach the application, not the terminal flow-control layer.
    attributes = termios.tcgetattr(slave)
    attributes[0] &= ~(termios.IXON | termios.IXOFF)
    termios.tcsetattr(slave, termios.TCSANOW, attributes)
    process = None
    raw = bytearray()
    started = time.monotonic()
    keys = (output / "keys.jsonl").open("w")
    raw_file = (output / "pty.raw").open("wb")
    queries = bytearray()

    def event(label, data):
        keys.write(json.dumps({"seconds": round(time.monotonic() - started, 6), "label": label, "bytesHex": data.hex(), "outputOffset": len(raw)}) + "\n")
        keys.flush()

    def send(label, data):
        boundary = len(raw)
        event(label, data)
        os.write(master, data)
        return boundary

    def pump():
        if select.select([master], [], [], 0.05)[0]:
            chunk = os.read(master, 65536)
            if not chunk:
                raise RuntimeError("PTY closed before completion")
            raw.extend(chunk)
            raw_file.write(chunk)
            raw_file.flush()
            queries.extend(chunk)
            for request, reply in [(b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[c", b"\x1b[?1;2c"), (b"\x1b[>c", b"\x1b[>0;0;0c")]:
                while request in queries:
                    end = queries.index(request) + len(request)
                    del queries[:end]
                    event("conservative-terminal-query-response", reply)
                    os.write(master, reply)
            if len(queries) > 128:
                del queries[:-128]
        if process.poll() is not None:
            raise RuntimeError(f"CLI exited prematurely: {process.returncode}")

    def wait(label, predicate, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            pump()
        tail = ANSI.sub(b"", bytes(raw[-1200:])).decode("utf-8", "replace")
        raise RuntimeError(f"Timed out: {label}; bounded output tail={tail!r}")

    def presence(boundary, *markers):
        # Observed OpenTUI writes position text cells using cursor moves instead
        # of emitting spaces: "ACP command ready." arrives as "ACPcommandready.".
        # Normalize whitespace symmetrically for presence only; punctuation and
        # character order remain exact, and only fresh boundary bytes count.
        fresh_text = ANSI.sub(b"", bytes(raw[boundary:])).decode("utf-8", "replace")
        compact_text = re.sub(r"\s+", "", fresh_text)
        return any(re.sub(r"\s+", "", marker) in compact_text for marker in markers)

    def logs():
        path = proof / "requests.jsonl"
        # Fixture append is synchronous; retry an incomplete final line only.
        lines = path.read_text().splitlines() if path.exists() else []
        return [json.loads(line) for line in lines if line.endswith("}")]

    def posts():
        # Chat turns only: Stop's `POST /api/chat/cancel` is asserted separately.
        return [entry for entry in logs() if entry.get("event") == "request" and entry.get("method") == "POST" and entry.get("route") == "/api/chat/stream"]

    def prompt(text, marker, count):
        send("clear-composer", b"\x15")
        boundary = send("prompt:" + text, text.encode() + b"\r")
        wait(marker, lambda: presence(boundary, marker) and len(posts()) == count)
        (output / f"turn-{count}-presence.txt").write_text(ANSI.sub(b"", bytes(raw[boundary:])).decode("utf-8", "replace"))

    try:
        process = subprocess.Popen([str(binary), "tui"], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        os.close(slave)
        slave = None
        wait("initial chat", lambda: presence(0, "Chat", "chat"))
        boundary = send("open-agent-picker", b"\x01")
        wait("real agent picker", lambda: presence(boundary, "Select agent") and presence(boundary, "Review Agent"))
        boundary = send("select-review-agent", b"\r")
        wait("agent selected", lambda: presence(boundary, "Agent: Review Agent"))
        # A server-side agent guard validates the selected route on every turn.
        prompt("advertise commands", "ACP command ready.", 1)
        send("clear-composer", b"\x15")
        boundary = send("503-command", b"/acp-review check staged changes\r")
        wait("visible command refusal", lambda: presence(boundary, "503", "temporary ACP route failure") and len(posts()) == 2)
        prompt("/acp-review check staged changes", "Review complete. Commands replaced.", 3)
        prompt("clear commands", "ACP commands cleared.", 4)
        prompt("hold stream", "Held stream active; queue then clear and press Escape.", 5)
        send("clear-composer", b"\x15")
        boundary = send("queue-discard", b"queued discard\r")
        wait("queue acknowledgement", lambda: presence(boundary, "Queued prompt (1)"))
        boundary = send("focus-queue", b"\x11")
        wait("focused queue hints", lambda: presence(boundary, "↑↓ move"))
        boundary = send("open-queue", b"\r")
        wait("queue overlay", lambda: presence(boundary, "Queued prompts") and presence(boundary, "queued discard"))
        boundary = send("clear-queue", b"c")
        # Production clearQueuedMessages closes the overlay AND queue focus,
        # then notifies "Queue cleared". Observed differential cell writes emit
        # only "O cleared" over the previous toast, so the fresh event suffix
        # plus authoritative HTTP count is the honest presence boundary.
        wait("queue clear notification suffix", lambda: presence(boundary, "cleared") and len(posts()) == 5)
        (output / "queue-clear-presence.txt").write_text(ANSI.sub(b"", bytes(raw[boundary:])).decode("utf-8", "replace"))
        # The overlay is already closed by c; one Escape now stops this turn.
        send("stop-stream", b"\x1b")
        wait("fixture observed Stop", lambda: any(entry.get("event") == "held-stream-cancelled" for entry in logs()))
        # Core keeps a persisted turn running after its stream is aborted, so Stop
        # must also cancel it on Core for the held turn's conversation.
        wait("fixture observed Core cancel", lambda: any(entry.get("event") == "held-turn-cancel-requested" for entry in logs()))
        if len(posts()) != 5:
            raise RuntimeError("Queued user turn reached HTTP during clear/Stop")
        prompt("after stop", "Same-conversation retry completed after Stop.", 6)
        actual = posts()
        expected = ["advertise commands", "/acp-review check staged changes", "/acp-review check staged changes", "clear commands", "hold stream", "after stop"]
        observed = [entry["body"]["messages"][-1]["text"] for entry in actual]
        if observed != expected:
            raise RuntimeError(f"Exact six POST sequence mismatch: {observed!r}")
        if any(message["text"] == "other" for entry in actual for message in entry["body"]["messages"] if message["role"] == "user"):
            raise RuntimeError("Unexpected or queued user turn reached HTTP")
        if any(entry.get("event") in ("refused", "held-stream-timeout") for entry in logs()):
            raise RuntimeError("Strict fixture recorded refusal or timeout")
        os.kill(fixture_pid, signal.SIGTERM)
        deadline = time.monotonic() + 10
        while not (proof / "summary.json").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        summary = json.loads((proof / "summary.json").read_text())
        if not summary.get("complete") or summary.get("rejected") != 0 or summary.get("commandAttempts") != 2 or not summary.get("heldCancelled") or not summary.get("cancelRequested") or not summary.get("resumed"):
            raise RuntimeError(f"Fixture incomplete: {summary!r}")
        (output / "result.json").write_text(json.dumps({"complete": True, "boundary": BOUNDARY, "postTurns": observed, "fixtureSummary": summary}, indent=2) + "\n")
    except Exception as error:
        (output / "result.json").write_text(json.dumps({"complete": False, "boundary": BOUNDARY, "error": str(error)[:2000]}, indent=2) + "\n")
        raise
    finally:
        # Fixture was externally launched but ownership/identity was validated.
        # Stop it on failure as well, so its held response cannot leak.
        if not (proof / "summary.json").exists():
            try:
                os.kill(fixture_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=3)
        if slave is not None:
            os.close(slave)
        os.close(master)
        keys.close()
        raw_file.close()


if __name__ == "__main__":
    main()

"""End-to-end pipeline proof for the Ryu Python binding.

This does NOT hit the network. It exercises the SHARED Rust rules through the
UniFFI-generated `ryu_sdk` module, proving the full pipeline works:

    crates/ryu-sdk-uniffi (cdylib)
        -> uniffi-bindgen generate --language python
        -> import ryu_sdk
        -> the same egress / manifest / plugin-id rules every binding enforces.

Run after the CI step that generates `ryu_sdk/` and places the compiled library
beside it (see .github/workflows/sdk-bindings.yml). Exits non-zero on any failure
so the CI job goes red if the generated surface drifts.
"""

import sys

import ryu_sdk


def main() -> int:
    # 1. Plugin id validation: the path-traversal-safe rule.
    ryu_sdk.validate_plugin_id("io.ryu.ok")
    try:
        ryu_sdk.validate_plugin_id("../evil")
    except ryu_sdk.RyuError:
        pass
    else:
        print("FAIL: '../evil' should have been rejected", file=sys.stderr)
        return 1

    # 2. Gateway egress blocklist: the moat invariant — direct providers blocked.
    ryu_sdk.assert_allowed_egress("http://127.0.0.1:7981")
    try:
        ryu_sdk.assert_allowed_egress("https://api.openai.com")
    except ryu_sdk.RyuError:
        pass
    else:
        print("FAIL: api.openai.com egress should be blocked", file=sys.stderr)
        return 1

    # 3. Manifest validation: a good manifest round-trips, a bad semver errors.
    good = (
        '{"id":"com.example.x","name":"X","version":"1.0.0",'
        '"runnables":[{"id":"t","name":"T","kind":"tool","config":{"slug":"s"}}]}'
    )
    normalized = ryu_sdk.parse_and_validate_manifest(good)
    assert "com.example.x" in normalized, "normalized manifest lost its id"

    bad = '{"id":"com.example.x","name":"X","version":"nope","runnables":[]}'
    try:
        ryu_sdk.parse_and_validate_manifest(bad)
    except ryu_sdk.RyuError:
        pass
    else:
        print("FAIL: invalid semver should have errored", file=sys.stderr)
        return 1

    # 4. ModelClient construction rejects a direct-provider base URL, accepts the
    #    gateway. (No `.chat()` call — that needs a live gateway.)
    try:
        ryu_sdk.ModelClient("gpt-4o", "https://api.openai.com", None)
    except ryu_sdk.RyuError:
        pass
    else:
        print("FAIL: ModelClient should reject api.openai.com", file=sys.stderr)
        return 1

    ryu_sdk.ModelClient("gemma4", "http://127.0.0.1:7981", None)

    print("ryu_sdk Python binding smoke test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

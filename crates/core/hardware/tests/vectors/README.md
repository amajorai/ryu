# RHP v1.1 golden vectors

Shared, committed test vectors for the Ryu Hardware Protocol v1.1 secure channel
(Noise XX), pairing, BLE segmentation, and device capabilities. Every implementation
(Rust here, C firmware, TypeScript) tests against these same files. Nobody derives
the values by hand, and nobody edits them by hand: they are produced by
`tools/hardware/gen-rhp-vectors.py` at the repository root.

They live in this crate because `crates/core` and `packages/protocol` are mirrored
publicly and `apps/hardware` is not.

## Files

- `noise_cacophony_xx_25519_aesgcm_sha256.json`: the third-party cacophony
  `Noise_XX_25519_AESGCM_SHA256` vector (keys, prologue, handshake hash, and all 6 messages).
- `rhp_v1_1_noise.json`: the RHP Noise handshake (HS1 to HS3), split and rekey keys, and the
  encrypted transport records (CONTROL, audio, rekey, keepalive, and blob fragments).
- `rhp_v1_1_pairing.json`: pairing commitment, transcript hash, SAS, HKDF outputs, the confirm
  tag, sealed credentials, the exact BLE JSON wire strings, and the node-key substitution case.
- `rhp_v1_1_ble.json`: link-control codes, segmentation of messages at several MTUs (including
  sequence wrap), reassembly rejection cases, and first-byte classification.
- `rhp_v1_1_capabilities.json`: a valid `capabilities_register` message, invalid descriptors with
  their error codes, argument validation cases, and the tool-name rule with examples.

## Provenance

The generator is an independent oracle written in Python with the `cryptography` package. It
is deterministic: every key is `SHA256("ryu-rhp-v1.1 test " + label)`, and every other input is
fixed. At design time the outputs were cross-checked against the cacophony vector and against
snow 0.10.0, which reproduced the handshake messages, the handshake hash, and every transport
record byte for byte.

## Licence

- `noise_cacophony_xx_25519_aesgcm_sha256.json` is a subset of the cacophony test vectors, which
  are public domain. It was taken from snow 0.10.0 `tests/vectors/cacophony.txt`.
- All other files are original and licensed Apache-2.0, like this crate.

## Regenerate and check

Run from the repository root (Python 3.10 or later with `cryptography` 42 or later):

```sh
# Rewrite every file. PATH is snow 0.10.0 tests/vectors/cacophony.txt
python3 -I tools/hardware/gen-rhp-vectors.py --out crates/core/hardware/tests/vectors --cacophony PATH

# The repository's format gate (Biome) puts short arrays on one line
bun x biome format --write crates/core/hardware/tests/vectors

# Recompute the four rhp_v1_1_*.json files and compare them with the committed files as
# parsed JSON; exits non-zero on drift
python3 -I tools/hardware/gen-rhp-vectors.py --check crates/core/hardware/tests/vectors

# Also compare the cacophony subset against snow's cacophony.txt
python3 -I tools/hardware/gen-rhp-vectors.py --check crates/core/hardware/tests/vectors --cacophony PATH
```

`--check` compares parsed JSON, not bytes, because the committed files are Biome-formatted
and the generator writes `json.dumps(indent=2)` layout. Whitespace and object key order are
not drift. A changed value, a missing or extra key, a different array order or length, or a
different scalar type (`true` is not `1`, `1` is not `1.0`) is drift, and the failing file
and JSON path are printed. Formatting the generator's output with Biome reproduces the
committed bytes exactly.

Without `--cacophony`, `--check` does not compare
`noise_cacophony_xx_25519_aesgcm_sha256.json` with its source. It only replays the handshake
and transport messages of each entry in its `vectors` list, so an edited `source` field or an
empty `vectors` list still passes. Pass `--cacophony PATH` to check that file in full.

The Hardware workflow job `rhp-vectors` installs `cryptography`, runs
`python3 -m unittest tools/hardware/test_gen_rhp_vectors.py`, and runs the `--check` command
above, so the vectors cannot drift from the oracle unnoticed. The Rust unit tests also
recompute the values from fixed inputs and compare them with these files.

## Consumers

- Rust: `include_str!("../tests/vectors/<file>")` from `src/*.rs` in this crate.
- C: host tests read the files from the directory given by `RHP_VECTORS_DIR`.
- TypeScript: tests read the files with `node:fs`.

# ryu-core dependency and feature notes

This is the rationale that used to live as comments in [`Cargo.toml`](./Cargo.toml). The manifest
keeps only short load-bearing notes (exact pins, advisories, feature caveats); the reasoning lives
here so the manifest stays small enough for the repository file-size limit.

| File | Covers |
| --- | --- |
| This file | `[lints]`, `[features]` (including the shipped feature set and its build sites), target-specific and dev dependencies |
| [docs/dependencies-third-party.md](./docs/dependencies-third-party.md) | External crates (TLS, crypto, vault engines, audio, rendering, ACP, OpenTelemetry, Sentry, ...) |
| [docs/dependencies-core-crates.md](./docs/dependencies-core-crates.md) | Extracted Core capability crates under `crates/core/*` and other in-tree path dependencies |
| [docs/dependencies-out-of-process-apps.md](./docs/dependencies-out-of-process-apps.md) | Apps that moved out of process and are deliberately NOT dependencies, plus retired cargo features |

When you add, pin, or remove a dependency or feature, update the matching section here in the same
change. Other manifests (for example `crates/core/*/Cargo.toml` and `apps/gateway/Cargo.toml`) say
their versions are matched to `apps/core/Cargo.toml`; keep that true.

## `[lints.rust]`

`voice-parakeet` and `voice-vad` are opt-in features (see below). The `check-cfg` entry tells the
compiler those cfg values are expected, so the dormant gated code does not trip the
`unexpected_cfgs` lint in default builds that omit them.

## `[features]`

### `default = ["js-sandbox"]` and `js-sandbox`

Programmatic tool calling (PTC, #476), plugin hooks, adapters and inline tools, and JS code
evaluators all run in ONE sandbox. `js-sandbox` is QuickJS (Javy) compiled to WebAssembly and run
in-process by Wasmtime (`ryu-tool-exec`'s `js_backend.rs`). It replaced the Deno-subprocess and
secure-exec backends when Deno's runtime lost its maintainer; nothing is downloaded or spawned to
run a program. It is default ON. With it OFF the sandbox reports itself unavailable and those
surfaces degrade. The feature forwards to `ryu-tool-exec/js-sandbox` and `ryu-eval-code/js-sandbox`,
which is why both crates are declared with `default-features = false`.

### The three "off in default, ON in every shipped binary" features

`sandbox-wasmtime`, `voice-parakeet` and `voice-vad` are off in `default` on purpose (spike 0188):
a `cargo test` or `cargo check` run then pulls neither wasmtime/cranelift nor ONNX Runtime, which
saves minutes of CI time per job.

Off in `default` does NOT mean off in the product. Every binary a human runs must carry all three,
and SEVEN build sites are responsible for passing
`--features sandbox-wasmtime,voice-parakeet,voice-vad`.

In THIS repo:

1. `apps/core/package.json` - `dev`, `dev:watch`, `build`.
2. `.github/workflows/release.yml` - the `binaries` job (published assets: what the desktop's
   `core/install.rs` downloads AND the one-liner installer).
3. `scripts/release/release-local.sh` - `build_binaries`.
4. `Dockerfile` - the builder stage (every deploy button).

In `mirror/overlay/.github/workflows/`, which is published INTO the public `amajorai/ryu` repo and
therefore builds Core with the public tree's own copies of `crates/core/{sandbox,stt,vad}` (all
three are mirrored wholesale, so the features resolve there):

5. `release.yml` - the `build` job; fires on a `v*` tag pushed directly to the public repo. Rare,
   but it uploads with `--clobber`, so it can OVERWRITE a correctly-featured asset that
   `mirror-releases.yml` copied under that tag.
6. `nightly.yml` - the `build` job. Runs every 3 hours on the public repo.
7. `canary.yml` - the `build` job. Runs on EVERY push to public main.

(6) and (7) are not hypothetical: `apps/core/src/update/mod.rs` has first-class channel support, so
a node on the nightly or canary channel installs exactly what those two jobs produce.

Adding a feature to this list means adding it to all seven. The list was verified EXHAUSTIVE by a
tree-wide grep for `cargo build` across
`.github/ mirror/ scripts/ tools/ Dockerfile* apps/core/{package.json,scripts}`. The other hits build
something else (the SDK cdylib, satellite app backends, the gateway image) or build Core in DEBUG
for checks-only jobs that publish nothing: `mirror/overlay/.github/workflows/ci.yml` and
`scripts/integration-tests.sh`. That second pair is a knowingly lean Core, so the headless
integration suite exercises a binary with no WASM sandbox. This is deliberate (it keeps the suite
fast, the same rationale as `default`) and stated here so nobody reads suite coverage as coverage of
the shipped configuration.

History, kept because it explains the shape of the checks. The manifest comment used to say only
(1) mattered ("the dev and release binaries the user actually runs DO enable it"). That was half
true, and the false half was the shipping half: (2) through (7) each ran a bare
`cargo build --release`, so every Core a user ever downloaded had NO WASM sandbox
(`detect_backend("wasmtime")` false), NO parakeet inference (STT silently fell back to whisper) and
NO Silero VAD, while every developer had all three and could not reproduce any of it. It was then
corrected to "FOUR build sites", which was the same defect one layer down: (5), (6) and (7) were
still bare, so the enumeration a reader would trust to be exhaustive silently excluded the two
channels that publish most often. Do not restate the count elsewhere without re-reading this list;
the `voice-vad` note once said "four" for a round after this block was corrected to seven.

(2), (5), (6) and (7) now assert the resolved feature graph after the build. They read cargo's own
`bin-ryu-core.json` fingerprint, so a dropped flag fails the release instead of shipping a lean
binary that lies about its capabilities. The fingerprint PATH differs between the two repos and the
assertions differ with it:

- Here the build is a workspace member, so it is `target/release/.fingerprint/*/bin-ryu-core.json`.
- The public mirror ships NO root `Cargo.toml` (every manifest is its own workspace), so there it is
  `apps/core/target/release/.fingerprint/*/bin-ryu-core.json`.

(5) through (7) also drop any restored fingerprint before building, because those jobs use
Swatinem/rust-cache and an assertion that might be grading last week's artifact is not an
assertion. If you touch that assertion, it must match the fingerprint's `features` key
SPECIFICALLY. The same file also carries `declared_features`, which lists all three names on a
completely featureless build; the first version of the check grepped the whole file and was
therefore vacuous. Each site's step comment carries the full argument.

### `sandbox-wasmtime`

Forwards to `ryu-sandbox/sandbox-wasmtime`. The wasmtime backend moved into the extracted
`ryu-sandbox` crate; Core's feature only forwards.

### `voice-parakeet`

Parakeet STT inference, the default STT engine. The in-process ONNX engine lives in the extracted
`ryu-stt` crate; this feature forwards to the crate's own `voice-parakeet` (which pulls
transcribe-rs and once_cell there). Without it the parakeet sidecar refuses to start and reports
`Unhealthy` naming this feature (it used to report "Running" and return 500 for every
transcription), and `default_stt_engine()` resolves to whisper.

### `voice-vad`

Neural VAD for voice mode (the default). The endpointing/barge-in state machine and an energy-based
probability backend are always compiled, so voice mode works without this feature. Enabling
`voice-vad` swaps in the noise-robust Silero VAD ONNX model via transcribe-rs's tested `SileroVad`
(forwarded to `ryu-vad/voice-vad`). The original plan was TEN VAD, but its ONNX model is not usable
standalone (its feature extraction lives in a closed precompiled native lib), so Silero (fully open)
is used instead. It is off in `default` on purpose (see the shipped feature set above; all seven
build sites enable it). Any inference error falls back per hop to the always-compiled energy VAD, so
this is the one of the three whose absence degrades quietly by design.

### transcribe-rs is not a direct dependency

transcribe-rs (the ONNX Runtime dependency) is no longer a direct Core dependency. The parakeet STT
engine moved to `ryu-stt` and the Silero VAD engine moved to `ryu-vad`, each carrying its own copy
at the same version behind its own feature. Core reaches both only through those crates' forwarded
features, so nothing in `apps/core/src` uses `transcribe_rs` directly. (An older note claimed the
Parakeet optional deps lived in the main `[dependencies]` table; that stopped being true when the
engines were extracted.)

## Target-specific dependencies

- `[target.'cfg(unix)'.dependencies]` `nix` with `signal`, for Unix process signalling.
- `[target.'cfg(target_os = "windows")'.dependencies]` `winreg` and `winapi` are used by
  `sidecar/path_manager.rs` (Windows PATH management), not crypto. The at-rest master-key OS
  keychain dependencies moved to `crates/core/crypto` (`ryu-crypto`) with the crypto primitive.

## `[dev-dependencies]`

- `ctor` - `crypto_host::install_for_tests` installs `CoreCryptoHost` once for the whole ryu-core
  test binary, so every test that builds a sealing store has a host.
- `ryu-vault` with `test-support` - the identity-governance tests
  (`src/identity/{consult,elicitation,governed}.rs`) drive the extracted vault's
  `IdentityStore::open_in_memory()` and cipher seeding, which are gated behind ryu-vault's
  `test-support` feature. Cargo unifies this with the regular `ryu-vault` dep, so the feature is on
  only for test builds.
- `tower` with `util` - `tower::ServiceExt::oneshot`, to drive a Router in-process from a test (the
  App route-gate tests in `server/mod.rs`). It is listed as a dev-dependency so the test need is
  explicit and does not depend on the production feature set.

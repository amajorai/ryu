# Hub workflow scripts

The release, canary and nightly workflows in `.github/workflows/` call these
scripts instead of carrying long inline `run:` blocks. Each script's header
explains what it does, the environment it reads, and why. Steps call them as
`bash .github/scripts/<name>.sh` from the repository root after checkout, so
they do not depend on the executable bit.

| Script | Used by | Purpose |
| --- | --- | --- |
| `version-guard.sh` | release | Fail when the tag differs from the source version. |
| `stable-release-notes.sh` | release | Write notes and create the prerelease. |
| `rolling-prerelease.sh` | canary, nightly | Create this build's prerelease and prune old ones. |
| `nightly-gate.sh` | nightly | Skip a scheduled nightly when nothing changed. |
| `compile-tui.sh` | release | Compile the `ryu-cli` terminal client natively. |
| `collect-desktop-installers.sh` | all three | Gather, arch-stamp and rename Tauri bundles. |
| `collect-island-installers.sh` | all three | Gather the Island installers. |
| `build-cargo-target.sh` | all three | `cargo build --release` with the row's features. |
| `assert-feature-set.sh` | all three | Prove the shipped feature set was built. |
| `package-binary.sh` | all three | Name the binary by asset contract and checksum it. |
| `upload-release-assets.sh` | all three | Upload a directory through the assets endpoint. |
| `stable-updater-feed.sh` | release | Publish `latest.json` and `latest-beta.json`. |

## Workflow notes

These notes describe the workflow files themselves.

### Two `release.yml` files

The hub's `release.yml` is published into the public repository and fires only
on a `v*` tag pushed directly to it, or on a manual dispatch. The authoritative
producer is the private monorepo's own `release.yml`. That workflow builds
everything here plus the hub headless assets and the apps-store sidecar
binaries into a draft release, and `mirror-releases.yml` copies the hub assets
into this repository.

They are not copies and must not be kept in sync job for job. The difference is
forced by source availability: the public mirror carries `apps/desktop`,
`apps/island` and `crates/ghost`, which is why the desktop and Island jobs exist
here at all, but not `apps/ghost`, `apps/shadow` or the `apps-store/*` packages.
This workflow therefore cannot build those artifacts. Do not copy the private
`binaries` job here; the code it compiles is not in this repository.

As a result, a `v*` tag pushed here yields a release with no app sidecar
binaries. Ghost and Shadow archives are owned by the `amajorai/ghost` and
`amajorai/shadow` satellite releases, so Core's downloaders resolve
independently of this hub release. Tag the private repository for the complete
train.

The headless set is core and gateway (Rust) plus the TUI (Bun, shipped under the
`ryu-cli` asset name) for linux-x86_64, macos-aarch64, macos-x86_64 and
windows-x86_64. The feature-app backends build in their own satellite
repositories. Asset names match Core's updater and installer contract
(`apps/desktop/src-tauri/src/core/install.rs` `OPTIONAL_SIDECARS`,
`release-local.sh`): `<asset>-<os>-<arch>[.exe]`, each with a sibling
`<asset>.sha256` that the installers verify. The public mirror ships no root
`Cargo.toml`, so every manifest builds as its own workspace and its binary lands
in `<manifest-dir>/target/release/`.

The `build` and `notes` jobs check out the requested tag, so they run the
scripts from that tag's tree. To dispatch a tag whose tree predates these
scripts, run the workflow from that tag so its own inline steps are used:
`gh workflow run release.yml --ref <tag> -f tag=<tag>`.

### Desktop signing is optional

The desktop source is source-available here (see `LICENSE-COMMERCIAL.md`), so
it builds on free public runners. Signing is secret-gated: with
`TAURI_SIGNING_PRIVATE_KEY` set on this repository the artifacts are signed and
the updater accepts them; without it the installers still build and download,
they just carry no update signature.

### Signing-key scope during `bun install`

`bun install` is a separate step with no signing key in its environment, so a
malicious dependency `postinstall` script cannot read
`TAURI_SIGNING_PRIVATE_KEY`. The key is introduced only on the tauri-action
step. Residual risk: tauri-action runs the app's `beforeBuildCommand` (the Vite
build), so build-time dependencies still execute with the key in their
environment. The action offers no hook to run that in a key-free step, so the
workflow layer cannot close this.

### Channel branding order

`scripts/release/channel-brand.mjs` stamps the release channel onto the bundle's
OS-registered identity: `productName` becomes "Ryu (Nightly)", "(Canary)",
"(Beta)" or "(Research Preview)", and the icon is re-tinted per channel. It is
derived from the version already stamped into the tree. It runs after
`bun install`, because the icon expansion shells out to the Tauri CLI from
`node_modules`, and before tauri-action, because bundle names are read at bundle
time. It never touches `version`, `mainBinaryName` or `identifier`; the script
header explains why each is off-limits.

### Island runners and Linux headers

The Island's Windows leg is pinned to `windows-2022`, not `windows-latest`.
`windows-latest` is now `windows-2025-vs2026`, which ships only Visual Studio
2026; node-gyp 11 (through electron-rebuild, for `uiohook-napi`) cannot find a
2022 toolchain there and fails with "Could not find any Visual Studio
installation to use". `GYP_MSVS_VERSION` and `npm_config_msvs_version` match
that image. Desktop stays on `windows-latest` because it builds Rust, not
node-gyp natives.

On Linux, `uiohook-napi` compiles libuiohook from source and needs the X11
development headers; without them node-gyp fails with "X11/keysym.h: No such
file". Each missing header only surfaces after the previous one is satisfied, so
the package set was derived from the `src/x11/*.c` includes in one pass:
`Intrinsic.h` (libxt-dev), `Xlib-xcb.h` (libx11-xcb-dev), `Xrandr.h`
(libxrandr-dev), `XKBrules.h` (libxkbfile-dev), `XTest.h` and `record.h`
(libxtst-dev), `Xinerama.h` (libxinerama-dev). The xf86misc headers it also
names are behind a disabled `#ifdef`.

### Rust build dependencies

The `build` jobs install `pkg-config` and `libssl-dev` for `openssl-sys`, and
`libdbus-1-dev` (Linux) or `dbus` (macOS) for `libdbus-sys`. They install no
system Opus library: `opus` 0.4 builds its bundled libopus from source through
`opusic-sys` (CMake 3.16 or newer) and links it statically, so `ryu-core` needs
no libopus to build or to run. `CMAKE_POLICY_VERSION_MINIMUM=3.5` stays as a
guard for other vendored CMake projects, because CMake 4 refuses projects that
declare a minimum below 3.5.

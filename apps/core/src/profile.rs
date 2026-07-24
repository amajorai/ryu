//! `RYU_PROFILE` — backend-stack isolation on a single machine.
//!
//! A *profile* lets a dev backend stack (Core + Gateway + every managed sidecar)
//! run FULLY ISOLATED from a release stack on one machine: distinct ports, a
//! distinct data dir (`~/.ryu-dev`), a distinct gateway config, and a distinct
//! master-key keychain slot, so the two never bleed state into each other.
//!
//! `RYU_PROFILE` defaults to `"release"`, which is **byte-identical to having no
//! profile at all**: port offset 0, `~/.ryu`, the `ryu/master-key` keychain slot,
//! the original ports. Any other value (e.g. `"dev"`) shifts every base port by
//! [`DEV_PORT_OFFSET`] and suffixes the data dir / config dir / keychain account
//! with `-<profile>`.
//!
//! Design rule (the one that prevents the "adopt-and-share" bug where a spawn
//! side and the client that dials it disagree): **there is exactly one offset
//! source — [`port`] — and every port computation on every side calls it.** Never
//! hardcode a shifted port anywhere.
//!
//! The file boundary means some *client* readers of a sidecar's port live outside
//! `sidecar/**` (the RAG registry, the Shadow clients, the gateway-config reader).
//! Those all resolve an env var at call time, so [`apply_env_defaults`] (invoked
//! once at the top of `main`) seeds those env vars from the profile when the user
//! did not already set them — steering the out-of-boundary readers without editing
//! them. The in-boundary spawn/client code threads [`port`] directly.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Env var naming the active profile. Unset / empty ⇒ `"release"`.
pub const RYU_PROFILE_ENV: &str = "RYU_PROFILE";

/// The canonical release profile — the zero-offset, no-suffix default.
pub const RELEASE_PROFILE: &str = "release";

/// Port offset applied to every base port for any non-release profile. release=0.
pub const DEV_PORT_OFFSET: u16 = 1000;

// ── Pure resolvers (test these; they take the profile explicitly) ────────────────

/// Port offset for a given profile name (already lowercased/trimmed). release ⇒ 0,
/// anything else ⇒ [`DEV_PORT_OFFSET`].
pub fn port_offset_for(profile: &str) -> u16 {
    if profile == RELEASE_PROFILE {
        0
    } else {
        DEV_PORT_OFFSET
    }
}

/// `base + offset(profile)`, saturating (a base near `u16::MAX` never wraps).
pub fn port_for(base: u16, profile: &str) -> u16 {
    base.saturating_add(port_offset_for(profile))
}

/// Data-dir / config-dir / keychain-account suffix for a profile. `""` for
/// release (byte-identical to today), `-<profile>` otherwise (e.g. `-dev`).
pub fn suffix_for(profile: &str) -> String {
    if profile == RELEASE_PROFILE {
        String::new()
    } else {
        format!("-{profile}")
    }
}

/// The env-default resolver used everywhere in [`apply_env_defaults`]: an explicit
/// value the user already set MUST win over the profile-derived default, so this
/// returns `Some(default)` **only** when `current` is absent/empty. `None` means
/// "leave the env var alone" (the user's explicit value stands).
pub fn dev_default_if_unset(current: Option<String>, profile_default: String) -> Option<String> {
    match current {
        Some(v) if !v.trim().is_empty() => None,
        _ => Some(profile_default),
    }
}

// ── Cached process-wide accessors (production) ───────────────────────────────────

fn resolve() -> String {
    std::env::var(RYU_PROFILE_ENV)
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| RELEASE_PROFILE.to_owned())
}

static PROFILE: OnceLock<String> = OnceLock::new();

/// The active profile, resolved once from `RYU_PROFILE` and cached for the process
/// lifetime. Always lowercase; `"release"` when unset/empty.
pub fn profile() -> &'static str {
    PROFILE.get_or_init(resolve)
}

/// True when running the default release profile (zero offset, no suffix).
pub fn is_release() -> bool {
    profile() == RELEASE_PROFILE
}

/// The active port offset (0 for release, [`DEV_PORT_OFFSET`] otherwise).
pub fn port_offset() -> u16 {
    port_offset_for(profile())
}

/// **The single offset source.** Every port on every side (spawn, client,
/// env-default, gateway) computes its concrete port via this. `base` is the
/// canonical release port (e.g. `8080`); the return is `base + offset`.
pub fn port(base: u16) -> u16 {
    port_for(base, profile())
}

/// The active data-dir / config-dir / keychain-account suffix.
pub fn suffix() -> String {
    suffix_for(profile())
}

/// The profile-default gateway config path: `<os-config>/ryu{suffix}/gateway.toml`.
/// Matches both the gateway binary's own `config_path()` fallback and Core's
/// `gateway_config_path()` reader, so all three agree per profile.
fn default_gateway_config() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(format!("ryu{}", suffix())).join("gateway.toml"))
}

/// Seed the profile-derived defaults into the process environment **once**, at the
/// very top of `main`, before anything caches a path/port. Only touches an env var
/// the user did NOT already set (explicit wins), and is a complete no-op on the
/// release profile so release behaviour is untouched.
///
/// These env vars are the seams the out-of-boundary client readers already honour:
///   - `RYU_DIR`            — data dir (`paths::resolve`), inherited by children.
///   - `RYU_BIND`           — Core's listener (`main.rs`).
///   - `RYU_GATEWAY_URL`    — the gateway base URL Core forwards to + spawns at.
///   - `GATEWAY_CONFIG`     — the gateway config path (child + Core's own reader).
///   - `RYU_SHADOW_URL`     — every Shadow client (`clips`, `mcp/shadow`, `meetings`).
///   - `RYU_EMBED_BASE_URL` / `RYU_RERANKER_BASE_URL` — the RAG registry clients.
///   - `RYU_RESEARCH_UPSTREAM` — the `ryu_research` crate's `research_base_url`
///     (the proxy + `research__*` tools), whose port const lives out of boundary.
///
/// The matching *spawn* sides (llama.cpp chat/embed/rerank, Shadow, the SDK app,
/// and the research sidecar) are threaded directly through [`port`] in
/// `sidecar/**`, so both sides shift together.
pub fn apply_env_defaults() {
    if is_release() {
        return;
    }
    tracing_note();

    set_if_unset(
        crate::paths::RYU_DIR_ENV,
        crate::paths::default_ryu_dir()
            .to_string_lossy()
            .into_owned(),
    );
    set_if_unset("RYU_BIND", format!("127.0.0.1:{}", port(7980)));
    set_if_unset(
        "RYU_GATEWAY_URL",
        format!("http://127.0.0.1:{}", port(7981)),
    );
    if let Some(cfg) = default_gateway_config() {
        set_if_unset("GATEWAY_CONFIG", cfg.to_string_lossy().into_owned());
    }
    set_if_unset("RYU_SHADOW_URL", format!("http://127.0.0.1:{}", port(3030)));
    set_if_unset(
        "RYU_EMBED_BASE_URL",
        format!("http://127.0.0.1:{}", port(8081)),
    );
    set_if_unset(
        "RYU_RERANKER_BASE_URL",
        format!("http://127.0.0.1:{}", port(8082)),
    );
    set_if_unset(
        "RYU_RESEARCH_UPSTREAM",
        format!("http://127.0.0.1:{}", port(8087)),
    );
}

/// Set `key` to `value` only when it is currently unset/empty (explicit wins).
fn set_if_unset(key: &str, value: String) {
    let current = std::env::var(key).ok();
    if let Some(v) = dev_default_if_unset(current, value) {
        std::env::set_var(key, v);
    }
}

fn tracing_note() {
    // `apply_env_defaults` runs before tracing is initialised, so this is a plain
    // stderr breadcrumb (mirrors the pre-tracing convention in `main`).
    eprintln!(
        "ryu profile: '{}' active — isolated stack (ports +{}, data dir {})",
        profile(),
        port_offset(),
        crate::paths::default_ryu_dir().display()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    // All tests use the PURE `*_for(profile)` helpers so they never touch the
    // `OnceLock`-cached `profile()` (which would pollute the cache across the
    // parallel test binary).

    #[test]
    fn dev_profile_shifts_the_base_ports_by_1000() {
        // The four sidecar ports named in the spec, plus core + gateway.
        assert_eq!(port_for(8080, "dev"), 9080); // llamacpp chat
        assert_eq!(port_for(8081, "dev"), 9081); // llamacpp embed
        assert_eq!(port_for(8082, "dev"), 9082); // llamacpp rerank
        assert_eq!(port_for(8083, "dev"), 9083); // sdcpp media
        assert_eq!(port_for(8084, "dev"), 9084); // mlx-vlm
        assert_eq!(port_for(8086, "dev"), 9086); // mlx-lm
        assert_eq!(port_for(8087, "dev"), 9087); // research sidecar
        assert_eq!(port_for(8090, "dev"), 9090); // whisper stt
        assert_eq!(port_for(3030, "dev"), 4030); // shadow
        assert_eq!(port_for(3200, "dev"), 4200); // sdk app
        assert_eq!(port_for(7980, "dev"), 8980); // core bind
        assert_eq!(port_for(7981, "dev"), 8981); // gateway
    }

    #[test]
    fn release_profile_is_byte_identical_to_today() {
        assert_eq!(port_offset_for(RELEASE_PROFILE), 0);
        assert_eq!(port_for(8080, RELEASE_PROFILE), 8080);
        assert_eq!(port_for(8081, RELEASE_PROFILE), 8081);
        assert_eq!(port_for(8082, RELEASE_PROFILE), 8082);
        assert_eq!(port_for(3030, RELEASE_PROFILE), 3030);
        assert_eq!(port_for(3200, RELEASE_PROFILE), 3200);
        assert_eq!(port_for(7980, RELEASE_PROFILE), 7980);
        assert_eq!(port_for(7981, RELEASE_PROFILE), 7981);
        // No suffix ⇒ the exact original data dir + keychain slot.
        assert_eq!(suffix_for(RELEASE_PROFILE), "");
    }

    #[test]
    fn dev_profile_suffixes_data_dir_and_key_slot() {
        assert_eq!(suffix_for("dev"), "-dev");
        // The key slot is `master-key` + suffix, so dev ≠ release DB key.
        assert_eq!(format!("master-key{}", suffix_for("dev")), "master-key-dev");
        assert_eq!(
            format!("master-key{}", suffix_for(RELEASE_PROFILE)),
            "master-key"
        );
    }

    #[test]
    fn explicit_env_value_beats_the_profile_default() {
        // User already set the var → leave it alone (explicit wins).
        assert_eq!(
            dev_default_if_unset(Some("user-value".to_owned()), "profile-default".to_owned()),
            None
        );
        // Unset (or empty) → fall back to the profile-derived default.
        assert_eq!(
            dev_default_if_unset(None, "profile-default".to_owned()),
            Some("profile-default".to_owned())
        );
        assert_eq!(
            dev_default_if_unset(Some("   ".to_owned()), "profile-default".to_owned()),
            Some("profile-default".to_owned())
        );
    }
}

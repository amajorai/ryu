//! Child-process environment scrubbing (security, defense-in-depth).
//!
//! Core spawns untrusted-ish subprocesses (the Deno PTC sandbox, per-request MCP
//! stdio servers). By default `std::process::Command` / `tokio::process::Command`
//! inherit Core's **entire** environment, which can carry provider API keys,
//! gateway tokens, credits secrets, and other credentials. A subprocess has no
//! business seeing those, so this module builds a scrubbed env to hand the child.
//!
//! Two strategies:
//!   - [`scrub_child_env`] (deny-list): drop any var whose KEY looks secret-like
//!     (contains `KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`PASSWD`/`CREDENTIAL`/`AUTH`,
//!     case-insensitive), keeping everything else. Used for the Deno sandbox,
//!     which needs a mostly-normal env (PATH, DENO_DIR, HOME, ...) minus secrets.
//!   - [`mcp_safe_env`] (allow-list): pass ONLY a small fixed set of benign vars
//!     ([`MCP_SAFE_ALLOWLIST`]) plus any `XDG_*` var. Used for MCP stdio servers,
//!     where the server config declares its own env explicitly, so the inherited
//!     env should be minimal.
//!
//! Both are pure functions over an iterator of `(key, value)` pairs so callers
//! pass `std::env::vars()` and the result is fed to `Command::envs(...)` **after**
//! `Command::env_clear()` (clearing first is load-bearing — without it the child
//! still inherits the full parent env and the scrub is a no-op).

/// Case-insensitive substrings that mark an env KEY as secret-like. Matched as an
/// uppercase-contains check so we never compile a regex per call.
const SENSITIVE_MARKERS: [&str; 7] = [
    "KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "AUTH",
];

/// The exact env-var names an MCP stdio server may inherit from Core. Everything
/// else (except `XDG_*`) is dropped; the server config's declared env is layered
/// on top by the spawn site. Compared case-insensitively.
///
/// Includes the Windows essentials (`SYSTEMROOT`, `APPDATA`, `PATHEXT`, ...): an
/// `npx`/`node` MCP server cannot launch on Windows without them, and none carry
/// credentials. This project is Windows-first, so omitting them would break MCP.
pub const MCP_SAFE_ALLOWLIST: &[&str] = &[
    // POSIX essentials.
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "TERM",
    "SHELL",
    "TMPDIR",
    // Windows essentials: required for a Windows `npx`/`node` MCP server to
    // launch and resolve modules. None are secret-like.
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "COMSPEC",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "TEMP",
    "TMP",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "OS",
];

/// Whether an env KEY is secret-like (contains any [`SENSITIVE_MARKERS`] token,
/// case-insensitive).
fn is_sensitive_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    SENSITIVE_MARKERS.iter().any(|m| upper.contains(m))
}

/// Deny-list scrub: drop every var whose KEY matches (case-insensitive) any of
/// `KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`PASSWD`/`CREDENTIAL`/`AUTH`, UNLESS the key
/// is in `extra_allow` (exact, case-insensitive). Everything non-secret-like is
/// kept, so the child gets a normal-looking env minus credentials.
pub fn scrub_child_env(
    base: impl IntoIterator<Item = (String, String)>,
    extra_allow: &[&str],
) -> Vec<(String, String)> {
    base.into_iter()
        .filter(|(key, _)| {
            if !is_sensitive_key(key) {
                return true;
            }
            // Secret-like, but the caller explicitly re-allows it (a var the child
            // genuinely needs whose name happens to trip a marker).
            extra_allow
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(key))
        })
        .collect()
}

/// Allow-list scrub for MCP stdio servers: pass ONLY [`MCP_SAFE_ALLOWLIST`] vars
/// (exact, case-insensitive) plus any key starting with `XDG_`. Everything else
/// is dropped. The server config's declared env is applied on top by the caller.
pub fn mcp_safe_env(base: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    base.into_iter()
        .filter(|(key, _)| is_mcp_safe_key(key))
        .collect()
}

/// Whether an env KEY is allowed through to an MCP stdio server: an exact
/// (case-insensitive) member of [`MCP_SAFE_ALLOWLIST`], or an `XDG_*` var.
fn is_mcp_safe_key(key: &str) -> bool {
    if key.to_ascii_uppercase().starts_with("XDG_") {
        return true;
    }
    MCP_SAFE_ALLOWLIST
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(kv: &[(&str, &str)]) -> Vec<(String, String)> {
        kv.iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    fn has(env: &[(String, String)], key: &str) -> bool {
        env.iter().any(|(k, _)| k == key)
    }

    #[test]
    fn scrub_child_env_drops_secret_like_keys() {
        let base = pairs(&[
            ("PATH", "/usr/bin"),
            ("OPENAI_API_KEY", "sk-secret"),
            ("ANTHROPIC_API_KEY", "sk-ant"),
            ("RYU_GATEWAY_TOKEN", "tok"),
            ("MY_SECRET", "shh"),
            ("DB_PASSWORD", "pw"),
            ("SUDO_PASSWD", "pw2"),
            ("AWS_CREDENTIAL_FILE", "cred"),
            ("HTTP_AUTHORIZATION", "bearer"),
            ("HOME", "/home/u"),
            ("DENO_DIR", "/cache/deno"),
        ]);
        let out = scrub_child_env(base, &[]);
        // Non-secret vars survive.
        assert!(has(&out, "PATH"));
        assert!(has(&out, "HOME"));
        assert!(has(&out, "DENO_DIR"));
        // Every secret-like key is dropped (KEY/TOKEN/SECRET/PASSWORD/PASSWD/
        // CREDENTIAL/AUTH).
        for dropped in [
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "RYU_GATEWAY_TOKEN",
            "MY_SECRET",
            "DB_PASSWORD",
            "SUDO_PASSWD",
            "AWS_CREDENTIAL_FILE",
            "HTTP_AUTHORIZATION",
        ] {
            assert!(!has(&out, dropped), "{dropped} should be scrubbed");
        }
    }

    #[test]
    fn scrub_child_env_keeps_allowlisted_secret_key() {
        // A secret-like key the child genuinely needs is re-allowed by exact,
        // case-insensitive compare.
        let base = pairs(&[
            ("SSH_AUTH_SOCK", "/tmp/agent.sock"),
            ("OPENAI_API_KEY", "sk-secret"),
        ]);
        let out = scrub_child_env(base, &["ssh_auth_sock"]);
        assert!(
            has(&out, "SSH_AUTH_SOCK"),
            "extra_allow keeps a secret-like key (case-insensitive)"
        );
        assert!(
            !has(&out, "OPENAI_API_KEY"),
            "non-allowed secret still dropped"
        );
    }

    #[test]
    fn mcp_safe_env_is_an_exact_allowlist() {
        let base = pairs(&[
            ("PATH", "/usr/bin"),
            ("HOME", "/home/u"),
            ("XDG_CONFIG_HOME", "/home/u/.config"),
            ("XDG_DATA_DIRS", "/usr/share"),
            ("FOO_TOKEN", "secret"),
            ("RANDOM_VAR", "x"),
            ("OPENAI_API_KEY", "sk"),
        ]);
        let out = mcp_safe_env(base);
        // Allowlisted + XDG_* pass.
        assert!(has(&out, "PATH"));
        assert!(has(&out, "HOME"));
        assert!(has(&out, "XDG_CONFIG_HOME"));
        assert!(has(&out, "XDG_DATA_DIRS"));
        // Everything else is dropped, including a secret-like FOO_TOKEN and a
        // benign-but-unlisted RANDOM_VAR.
        assert!(!has(&out, "FOO_TOKEN"));
        assert!(!has(&out, "RANDOM_VAR"));
        assert!(!has(&out, "OPENAI_API_KEY"));
    }

    #[test]
    fn mcp_safe_env_key_match_is_case_insensitive() {
        let base = pairs(&[("Path", "/usr/bin"), ("xdg_runtime_dir", "/run/u")]);
        let out = mcp_safe_env(base);
        assert!(has(&out, "Path"));
        assert!(has(&out, "xdg_runtime_dir"));
    }

    #[test]
    fn mcp_safe_env_keeps_windows_essentials() {
        // A Windows npx/node MCP server needs these to launch; none are secrets.
        let base = pairs(&[
            ("SystemRoot", "C:/Windows"),
            ("APPDATA", "C:/Users/u/AppData/Roaming"),
            ("LOCALAPPDATA", "C:/Users/u/AppData/Local"),
            ("PATHEXT", ".COM;.EXE;.CMD"),
            ("ComSpec", "C:/Windows/System32/cmd.exe"),
            ("USERPROFILE", "C:/Users/u"),
            ("TEMP", "C:/Users/u/AppData/Local/Temp"),
            // Still dropped: a secret-like var must not ride through.
            ("GITHUB_TOKEN", "ghp_x"),
        ]);
        let out = mcp_safe_env(base);
        for kept in [
            "SystemRoot",
            "APPDATA",
            "LOCALAPPDATA",
            "PATHEXT",
            "ComSpec",
            "USERPROFILE",
            "TEMP",
        ] {
            assert!(has(&out, kept), "{kept} should pass the MCP allowlist");
        }
        assert!(!has(&out, "GITHUB_TOKEN"), "secret-like var stays dropped");
    }
}

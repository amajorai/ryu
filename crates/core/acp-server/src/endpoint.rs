//! Command-line options and Core endpoint/credential resolution.
//!
//! Credential precedence mirrors `packages/core-client/src/node-token.ts` so the
//! ACP server can never disagree with the CLI about which bearer to present:
//! `RYU_CORE_TOKEN` > `RYU_TOKEN` > the node-auth token file Core minted — and
//! that last, machine-local secret is only ever sent to a loopback Core.

use std::path::Path;

/// Usage text for `ryu-core acp --help` (and `ryu acp --help`).
pub const USAGE: &str = "\
Run Ryu as an Agent Client Protocol (ACP) agent over stdio.

Usage: ryu-core acp [--agent <id>] [--core-url <url>]

Options:
  --agent <id>       Ryu agent to start new sessions with (default: Core's default agent)
  --core-url <url>   Ryu node to connect to (default: the local node)
  -h, --help         Show this help

An ACP editor launches this command and talks JSON-RPC on stdin/stdout. Ryu must
already be running; logs are written to stderr.
";

/// Parsed `acp` subcommand arguments.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CliOptions {
    pub agent: Option<String>,
    pub core_url: Option<String>,
    pub help: bool,
}

impl CliOptions {
    /// Parse the arguments AFTER the `acp` token. Value flags accept both
    /// `--flag value` and `--flag=value`; unknown arguments are rejected so a
    /// typo in an editor config fails loudly instead of being silently ignored.
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let mut options = Self::default();
        let mut iter = args.iter();
        while let Some(arg) = iter.next() {
            let (name, inline) = match arg.split_once('=') {
                Some((name, value)) if name.starts_with("--") => (name, Some(value.to_owned())),
                _ => (arg.as_str(), None),
            };
            match name {
                "-h" | "--help" => options.help = true,
                "--agent" | "--core-url" => {
                    let value = match inline {
                        Some(value) => value,
                        None => iter
                            .next()
                            .cloned()
                            .ok_or_else(|| format!("{name} requires a value"))?,
                    };
                    let value = value.trim().to_owned();
                    if value.is_empty() {
                        return Err(format!("{name} requires a value"));
                    }
                    if name == "--agent" {
                        options.agent = Some(value);
                    } else {
                        options.core_url = Some(value);
                    }
                }
                other => return Err(format!("unknown argument '{other}'")),
            }
        }
        Ok(options)
    }
}

/// Where the ACP server reaches Core, and the bearer it presents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreEndpoint {
    /// Base URL without a trailing slash, e.g. `http://127.0.0.1:7980`.
    pub url: String,
    pub token: Option<String>,
}

impl CoreEndpoint {
    /// Resolve from the process environment.
    ///
    /// * `flag_url` — `--core-url`, highest precedence.
    /// * `default_bind` — Core's own listener address for the active profile
    ///   (`RYU_BIND` semantics, e.g. `127.0.0.1:7980`), used when neither the flag
    ///   nor `RYU_CORE_URL` names a node.
    /// * `token_file` — the node-auth token file Core minted.
    pub fn resolve(flag_url: Option<&str>, default_bind: &str, token_file: &Path) -> Self {
        Self::resolve_with(flag_url, default_bind, token_file, |key| {
            std::env::var(key).ok()
        })
    }

    /// [`Self::resolve`] with an injectable environment, for tests.
    pub fn resolve_with(
        flag_url: Option<&str>,
        default_bind: &str,
        token_file: &Path,
        env: impl Fn(&str) -> Option<String>,
    ) -> Self {
        let non_empty = |value: Option<String>| {
            value
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let url = flag_url
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| non_empty(env("RYU_CORE_URL")))
            .unwrap_or_else(|| bind_to_url(default_bind));
        let url = url.trim_end_matches('/').to_owned();
        let token = non_empty(env("RYU_CORE_TOKEN"))
            .or_else(|| non_empty(env("RYU_TOKEN")))
            .or_else(|| {
                if !is_loopback_url(&url) {
                    return None;
                }
                std::fs::read_to_string(token_file)
                    .ok()
                    .map(|raw| raw.trim().to_owned())
                    .filter(|raw| !raw.is_empty())
            });
        Self { url, token }
    }
}

/// Turn a listener address into a client URL. A wildcard bind (`0.0.0.0`, `::`)
/// is reachable on loopback, which also keeps the minted token on this machine.
fn bind_to_url(bind: &str) -> String {
    let bind = bind.trim();
    if bind.contains("://") {
        return bind.to_owned();
    }
    let bind = if let Some(port) = bind.strip_prefix("0.0.0.0:") {
        format!("127.0.0.1:{port}")
    } else if let Some(port) = bind.strip_prefix("[::]:") {
        format!("[::1]:{port}")
    } else {
        bind.to_owned()
    };
    format!("http://{bind}")
}

/// True when `url` addresses THIS machine. Parsed with a real URL parser so
/// userinfo tricks (`http://localhost:80@evil.example/`) cannot leak the token.
pub(crate) fn is_loopback_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    match parsed.host() {
        Some(url::Host::Domain(domain)) => domain
            .trim_end_matches('.')
            .eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn parses_value_flags_in_both_forms() {
        let parsed = CliOptions::parse(&args(&["--agent", "coder", "--core-url=http://h:1"]))
            .expect("valid args");
        assert_eq!(parsed.agent.as_deref(), Some("coder"));
        assert_eq!(parsed.core_url.as_deref(), Some("http://h:1"));
        assert!(!parsed.help);
    }

    #[test]
    fn rejects_unknown_and_valueless_flags() {
        assert!(CliOptions::parse(&args(&["--nope"])).is_err());
        assert!(CliOptions::parse(&args(&["--agent"])).is_err());
        assert!(CliOptions::parse(&args(&["--agent="])).is_err());
        assert!(CliOptions::parse(&args(&["-h"])).expect("help").help);
    }

    #[test]
    fn token_file_is_only_sent_to_loopback() {
        let dir = std::env::temp_dir().join(format!("ryu-acp-token-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("node-auth.token");
        std::fs::write(&file, "minted\n").expect("write token");
        let no_env = |_: &str| None;

        let local = CoreEndpoint::resolve_with(None, "0.0.0.0:7980", &file, no_env);
        assert_eq!(local.url, "http://127.0.0.1:7980");
        assert_eq!(local.token.as_deref(), Some("minted"));

        let remote = CoreEndpoint::resolve_with(
            Some("http://localhost:80@evil.example/"),
            "",
            &file,
            no_env,
        );
        assert_eq!(remote.token, None);

        let explicit = CoreEndpoint::resolve_with(None, "127.0.0.1:1", &file, |key| {
            (key == "RYU_CORE_TOKEN").then(|| "operator".to_owned())
        });
        assert_eq!(explicit.token.as_deref(), Some("operator"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn env_url_beats_bind_and_flag_beats_env() {
        let env = |key: &str| (key == "RYU_CORE_URL").then(|| "http://127.0.0.1:9/".to_owned());
        let missing = Path::new("/nonexistent/ryu/token");
        assert_eq!(
            CoreEndpoint::resolve_with(None, "127.0.0.1:1", missing, env).url,
            "http://127.0.0.1:9"
        );
        assert_eq!(
            CoreEndpoint::resolve_with(Some("http://[::1]:5"), "127.0.0.1:1", missing, env).url,
            "http://[::1]:5"
        );
    }
}

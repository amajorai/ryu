//! Allowlisted environment for provider CLI subprocesses.

/// Parent variables a provider CLI needs to find its own install, config and login.
/// Everything else is dropped.
const ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TZ",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    // Where the user keeps each CLI's own config (and so its own sign-in).
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    // Corporate proxies and CA bundles the user configured for these tools.
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    // `claude --cloud` bundles the local repository with git.
    "SSH_AUTH_SOCK",
    "GIT_SSH_COMMAND",
    // Windows.
    "SystemRoot",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "PATHEXT",
    "ComSpec",
];

/// Variables that must never reach a provider CLI, even if a future edit widens the
/// allowlist. They would bill an API key, inject a token, or route the CLI through Ryu.
pub(in crate::server::subscription_cloud) const ENV_DENYLIST: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_API_KEY",
];

/// The child environment for a provider CLI: the allowlisted part of `parent`, never a
/// denylisted or `RYU_*` name.
pub(in crate::server::subscription_cloud) fn child_env<I>(parent: I) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    parent
        .into_iter()
        .filter(|(name, _)| {
            ENV_ALLOWLIST.contains(&name.as_str())
                && !ENV_DENYLIST.contains(&name.as_str())
                && !name.starts_with("RYU_")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_env_keeps_allowlist_and_drops_denylist_and_ryu() {
        let env = child_env(vec![
            ("PATH".into(), "/bin".into()),
            ("ANTHROPIC_API_KEY".into(), "secret".into()),
            ("RYU_FOO".into(), "bar".into()),
        ]);
        assert_eq!(env, vec![("PATH".to_owned(), "/bin".to_owned())]);
    }
}

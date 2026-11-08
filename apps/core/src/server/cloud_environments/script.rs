//! The prepared environment and its setup script, built without secret values for a Box.

use super::policy::{governed_spec, quote};
use super::*;

/// Which provider a prepared environment's cloud task runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::server) enum TaskBackend {
    Docker,
    Governed,
    Vpn,
    Box,
}
impl TaskBackend {
    /// The wire label used by the cloud task status and binding projections.
    pub(in crate::server) fn label(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Governed => "opensandbox",
            Self::Vpn => "vpn",
            Self::Box => "box",
        }
    }
}
pub(in crate::server) struct PreparedEnvironment {
    pub owner: String,
    pub environment_id: String,
    pub environment_name: String,
    pub revision: u64,
    pub start_instructions: String,
    pub working_directory: String,
    pub repository_directories: Vec<String>,
    pub script: String,
    pub task_preamble: String,
    pub secrets: Vec<String>,
    pub task_redactions: Vec<String>,
    pub governed_spec: ryu_sandbox::governed::GovernedWorkspaceSpec,
    pub vpn_backend: Option<ryu_sandbox::governed_vpn::GovernedVpnDocker>,
    pub vpn_key: Option<String>,
    pub governed: bool,
    pub network: bool,
    pub backend_label: &'static str,
    pub backend: TaskBackend,
    pub executor: String,
    pub lifetime_seconds: u64,
    /// Box arm only: per-command env. Values never enter a script.
    pub box_env: Vec<(String, String)>,
    /// Box arm only: the egress policy and the network secrets it substitutes.
    pub box_network: Option<super::box_secrets::BoxNetworkPlan>,
    /// Box arm only: the GitHub credential Core uses for a clean-room push.
    pub git_push_token: Option<GitPushCredential>,
    /// First repository as `owner/repo`.
    pub primary_repository: Option<String>,
    /// Names in `box_env` that carry the GitHub credential.
    pub git_env_keys: Vec<String>,
}

pub(super) fn repository_name(repository: &str) -> &str {
    repository
        .strip_prefix("https://github.com/")
        .unwrap_or(repository)
        .trim_end_matches(".git")
}

/// Inputs to [`build_task_script`]; every value is already resolved.
pub(super) struct ScriptPlan<'a> {
    pub(super) root: &'a str,
    /// Box arm: `exports` become per-command env instead of `export` lines.
    pub(super) is_box: bool,
    /// `(name, value)` in order: the org token first, then vault bindings.
    /// For governed runtimes a network secret's value is its placeholder.
    pub(super) exports: Vec<(String, String)>,
    pub(super) repositories: &'a [String],
    pub(super) install_script: &'a str,
    pub(super) internet_enabled: bool,
    pub(super) github_token_key: Option<&'a str>,
}
pub(super) struct ScriptParts {
    pub(super) script: String,
    pub(super) task_preamble: String,
    pub(super) box_env: Vec<(String, String)>,
    pub(super) repository_directories: Vec<String>,
    pub(super) working_directory: String,
}
/// Assemble the setup script, task preamble and directories. Pure, so the
/// Box arm's guarantee that no value enters a script is unit-testable.
pub(super) fn build_task_script(plan: ScriptPlan<'_>) -> ScriptParts {
    let root = plan.root;
    let mut script = format!("set -eu\nmkdir -p {root}\ncd {root}\n");
    let mut box_env = vec![];
    for (key, value) in plan.exports {
        if plan.is_box {
            box_env.push((key, value));
        } else {
            script.push_str(&format!("export {key}={}\n", quote(&value)));
        }
    }
    let mut task_preamble = script.clone();
    for repository in plan.repositories {
        if repository == plan.repositories.first().unwrap_or(repository) {
            script.push_str("if ! command -v git >/dev/null 2>&1; then if command -v apk >/dev/null 2>&1; then apk add --no-cache git; else printf '%s\\n' 'The configured sandbox image must provide git.' >&2; exit 127; fi; fi\nexport GIT_TERMINAL_PROMPT=0\n");
        }
        let repo = repository_name(repository);
        let git = plan.github_token_key.map_or_else(
            || "git".into(),
            |key| {
                format!(
                    "git -c \"http.https://github.com/.extraHeader=Authorization: Bearer ${key}\""
                )
            },
        );
        script.push_str(&format!(
            "mkdir -p -- {}\n{git} clone -- {} {}\n",
            quote(repo.split('/').next().unwrap_or("owner")),
            quote(&format!("https://github.com/{repo}.git")),
            quote(repo)
        ));
    }
    if let Some(repository) = plan.repositories.first() {
        let repo = repository_name(repository);
        script.push_str(&format!("cd {}\n", quote(repo)));
        task_preamble.push_str(&format!("cd {}\n", quote(repo)));
    }
    let requires_bash = plan
        .install_script
        .lines()
        .next()
        .is_some_and(|line| line.starts_with("#!") && line.contains("bash"))
        || plan.install_script.contains("pipefail");
    if requires_bash {
        if plan.internet_enabled {
            script.push_str("if ! command -v bash >/dev/null 2>&1; then if command -v apk >/dev/null 2>&1; then apk add --no-cache bash; else printf '%s\\n' 'The configured sandbox image must provide bash.' >&2; exit 127; fi; fi\n");
        }
        script.push_str(&format!("bash -c {}\n", quote(plan.install_script)));
    } else {
        script.push_str(&format!("sh -c {}\n", quote(plan.install_script)));
    }
    let repository_directories: Vec<String> = plan
        .repositories
        .iter()
        .map(|repository| format!("{root}/{}", repository_name(repository)))
        .collect();
    let working_directory = repository_directories
        .first()
        .cloned()
        .unwrap_or_else(|| root.to_owned());
    ScriptParts {
        script,
        task_preamble,
        box_env,
        repository_directories,
        working_directory,
    }
}

/// The Box network policy for an environment's internet settings.
pub(super) fn box_network(internet: &Internet) -> ryu_sandbox::box_session::BoxNetwork {
    use ryu_sandbox::{box_session::BoxNetwork, governed::EgressPolicy};
    match governed_spec(internet, vec![]).egress {
        EgressPolicy::Denied => BoxNetwork::None,
        EgressPolicy::Unrestricted => BoxNetwork::Egress,
        EgressPolicy::AllowedHosts(hosts) => BoxNetwork::Allowlist(hosts),
    }
}

/// The GitHub credential behind a Box task's clean-room push and pull request.
#[derive(Clone, PartialEq, Eq)]
pub(in crate::server) struct GitPushCredential {
    /// The token Core itself sends to the GitHub API (pull requests). It
    /// never enters the Box for a network secret.
    pub api_token: String,
    /// What the clean-room push in the Box sends as the Basic password: the
    /// token for a plain variable, or a network secret's placeholder, which
    /// the Box egress proxy replaces with the token on the way to github.com.
    pub push_secret: String,
}

impl GitPushCredential {
    /// A token that is sent as itself, both by Core and inside the Box.
    pub(in crate::server) fn plain(token: impl Into<String>) -> Self {
        let token = token.into();
        Self {
            api_token: token.clone(),
            push_secret: token,
        }
    }

    /// A network secret: the Box only ever holds `placeholder`.
    pub(in crate::server) fn network_secret(token: String, placeholder: String) -> Self {
        Self {
            api_token: token,
            push_secret: placeholder,
        }
    }
}

/// Whether a vault key names the GitHub token the clean-room push may use.
pub(super) fn is_github_token_key(key: &str) -> bool {
    key == "GITHUB_TOKEN" || key == "GH_TOKEN"
}

/// The push credential a Box network secret supplies: a GitHub token whose
/// domains include github.com, so the egress proxy substitutes it there.
pub(in crate::server) fn network_secret_push_credential(
    key: &str,
    domains: &[String],
    value: &str,
    placeholder: &str,
) -> Option<GitPushCredential> {
    (is_github_token_key(key) && domains.iter().any(|domain| domain == "github.com"))
        .then(|| GitPushCredential::network_secret(value.to_owned(), placeholder.to_owned()))
}

impl From<&str> for GitPushCredential {
    fn from(token: &str) -> Self {
        Self::plain(token)
    }
}

/// The HTTP Basic credential git sends for a GitHub token.
pub(in crate::server) fn github_basic_credential(token: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"))
}

use super::*;

/// Whether the Pi config dir `stdio` reads is the one Ryu manages (its own, or
/// a limited agent's), with exactly one `PI_CODING_AGENT_DIR` declared.
pub(super) fn pi_config_dir_is_managed(stdio: &McpServerStdio) -> bool {
    let mut config_dirs = stdio
        .env
        .iter()
        .filter(|variable| variable.name == "PI_CODING_AGENT_DIR");
    config_dirs
        .next()
        .is_some_and(|variable| crate::pi_config::is_managed_agent_dir(Path::new(&variable.value)))
        && config_dirs.next().is_none()
}

/// Whether a managed-Pi launch runs with only Ryu's brokered tools active
/// ([`PI_ACTIVE_TOOLS_ENV`]): no shell or file tool that could read a store
/// the sandbox would have hidden.
pub(super) fn pi_runs_brokered_tools_only(stdio: &McpServerStdio) -> bool {
    let brokered = RYU_MCP_PI_TOOLS.join(",");
    stdio
        .env
        .iter()
        .any(|variable| variable.name == PI_ACTIVE_TOOLS_ENV && variable.value == brokered)
}

/// The paths the sandbox must leave visible for `stdio` to run at all: its
/// program, its working folders, and the home its harness signs in from (a
/// Kiro custody home, Claude Code's or Codex's config home, a Pi config dir).
/// Hiding the harness's own sign-in would sign the agent out; which vendor it
/// may use is decided before launch ([`crate::agent_access::self_called_provider_permitted`]).
pub(super) fn sandbox_keep_paths(
    stdio: &McpServerStdio,
    cwd: &Path,
    additional_directories: &[PathBuf],
    is_claude_code: bool,
) -> Vec<PathBuf> {
    const HARNESS_HOME_ENV: &[&str] = &[
        "HOME",
        "USERPROFILE",
        "KIRO_HOME",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "PI_CODING_AGENT_DIR",
        "GEMINI_CLI_HOME",
    ];
    let home = dirs::home_dir();
    let launches_gemini = crate::acp_agent_settings::launches_gemini_cli(
        &stdio.command,
        stdio.args.iter().map(String::as_str),
    );
    let launches_kiro = crate::acp_agent_settings::launches_kiro_cli(
        &stdio.command,
        stdio.args.iter().map(String::as_str),
    );
    let is_codex = crate::agent_sandbox::is_codex_stdio(stdio);
    // The sign-in homes this engine itself runs from. Only these may sit
    // inside one of the user's provider stores or home credential stores and
    // still be kept; the launch was already refused unless their vendor is
    // allowed.
    let mut own_sign_in: Vec<PathBuf> = Vec::new();
    if is_codex {
        own_sign_in.extend([
            crate::codex_config::codex_home(),
            crate::codex_config::safety_home(),
            crate::codex_config::user_codex_home(),
        ]);
    }
    if let Some(home) = home.as_ref() {
        if is_claude_code {
            own_sign_in.extend([home.join(".claude"), home.join(".claude.json")]);
        }
        if launches_gemini {
            own_sign_in.push(home.join(".gemini"));
        }
    }
    if launches_kiro {
        own_sign_in.extend(crate::agent_access::user_kiro_sign_in_paths());
    }
    // The user's provider sign-ins and the home credential stores (SSH, cloud
    // and package-registry keys, browser profiles) a confined agent never sees.
    let mut hidden_stores = crate::agent_access::user_provider_stores();
    hidden_stores.extend(crate::agent_sandbox::home_credential_masks(home.as_deref()));
    hidden_stores.extend(crate::agent_sandbox::keychain_masks(home.as_deref()));
    let in_foreign_hidden_store = |path: &Path| {
        hidden_stores.iter().any(|store| path.starts_with(store))
            && !own_sign_in.iter().any(|own| path.starts_with(own))
    };
    let ryu_dir = crate::paths::ryu_dir();
    let in_core_folder = |path: &Path, folders: &[&str]| {
        folders
            .iter()
            .any(|folder| path.starts_with(ryu_dir.join(folder)))
    };
    use ryu_sidecar_runtime::layout::top;
    // A working folder inside Core's tokens or databases, inside another
    // engine's provider sign-ins, or inside a home credential store, is never
    // kept: keeping it would un-hide it.
    let mut keep: Vec<PathBuf> = std::iter::once(cwd.to_path_buf())
        .chain(additional_directories.iter().cloned())
        .filter(|path| {
            let refused = in_core_folder(path, &[top::SECRETS, top::DB])
                || in_foreign_hidden_store(path);
            if refused {
                tracing::warn!(path = %path.display(), "agent sandbox: not keeping a working folder inside a hidden store");
            }
            !refused
        })
        .collect();
    if stdio.command.is_absolute() {
        keep.push(stdio.command.clone());
    }
    let declared = super::super::acp_direct_spawn::declared_environment(stdio);
    let env = |name: &str| {
        declared
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| PathBuf::from(value))
            .filter(|path| path.is_absolute())
    };
    // A harness home inside Core's own data folders is honoured only for
    // Ryu's native-account custody homes, and one inside the user's provider
    // or home credential stores only when it is this engine's own sign-in, so
    // a launch setting cannot point a "home" at a hidden store to un-hide it.
    let custody = ryu_dir.join(top::SECRETS).join("native-accounts");
    keep.extend(
        HARNESS_HOME_ENV
            .iter()
            .filter_map(|name| env(name))
            .filter(|path| {
                path.starts_with(&custody)
                    || !(in_core_folder(
                        path,
                        &[
                            top::SECRETS,
                            top::FILES,
                            top::DB,
                            top::STATE,
                            top::PLUGIN_DATA,
                            top::SERVICES,
                            top::LOGS,
                        ],
                    ) || in_foreign_hidden_store(path))
            }),
    );
    if is_claude_code && env("CLAUDE_CONFIG_DIR").is_none() {
        if let Some(home) = home.as_ref() {
            keep.push(home.join(".claude"));
            keep.push(home.join(".claude.json"));
        }
    }
    if is_codex && env("CODEX_HOME").is_none() {
        keep.push(crate::codex_config::user_codex_home());
    }
    // Gemini CLI, by the same match the account-access launch check uses to
    // require `provider:genai` for it.
    if launches_gemini && env("GEMINI_CLI_HOME").is_none() {
        if let Some(home) = home.as_ref() {
            keep.push(home.join(".gemini"));
        }
    }
    // Kiro CLI signed in from the user's own home, not a Ryu custody home
    // (which sets `HOME` and `KIRO_HOME` and is kept above).
    if launches_kiro && env("KIRO_HOME").is_none() && env("HOME").is_none() {
        keep.extend(crate::agent_access::user_kiro_sign_in_paths());
    }
    keep
}

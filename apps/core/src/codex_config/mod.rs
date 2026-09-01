//! Codex gateway-routing toggle (subscription-preserving egress governance).
//!
//! Codex (`acp:codex`) runs through Zed's `codex-acp` bridge. On a ChatGPT
//! Plus/Pro/Business **subscription** it authenticates with the user's own OAuth
//! credentials (`access_token` + `account_id` from `~/.codex/auth.json`) and hits
//! OpenAI's special backend `https://chatgpt.com/backend-api/codex/responses`
//! using the **Responses** wire API. That subscription egress is NOT governed by
//! the Ryu gateway: Codex ignores `OPENAI_BASE_URL` in ChatGPT-auth mode, so the
//! existing `codex_acp_cmd()` API-key injection only governs the *API-key* path,
//! not the subscription path.
//!
//! This module opts the user into routing the **subscription** egress through the
//! gateway's transparent passthrough proxy (`apps/gateway/src/passthrough`,
//! `/passthrough/openai-responses/*`), mirroring the Claude Code passthrough. The
//! mechanism (verified against the Codex config reference + the headroom proxy
//! design): point Codex at an **isolated `CODEX_HOME`** holding a `config.toml`
//! with a custom `model_provider` whose `base_url` is the gateway passthrough and
//! that has **no `env_key`**, so Codex delivers its subscription-auth request
//! (OAuth bearer + `ChatGPT-Account-ID` header) to the proxy untouched. The proxy
//! forwards both UNCHANGED to `chatgpt.com/backend-api/codex` while applying
//! request-side DLP + audit.
//!
//! **Subscription-preservation rule (same as Claude):** we never inject an API
//! key on this path. The isolated home reuses the user's real `~/.codex/auth.json`
//! (copied in) so the OAuth subscription credential is what reaches upstream. A
//! BYOK key would flip Codex onto API-key billing.
//!
//! On by default for a newly installed ACP agent, matching the governed baseline
//! for routable agents. Because this changes how the subscription credential
//! flows, the UI keeps a clear direct-egress opt-out.
//! The flag is a process-global seeded from the `codex-gateway-routing`
//! preference at startup and on change, read synchronously on the (sync) spawn
//! path; the isolated `CODEX_HOME` is (re)written lazily when the flag is on.
//!
//! Every Ryu-managed Codex spawn also gets a separate safety home: the safe
//! `workspace-write`/`on-request` defaults are applied only when absent, a
//! global deletion instruction and user-level forbidden rules are merged with
//! backups, and a synchronous `PreToolUse` hook denies deletion attempts. The
//! Core/Gateway guard is the load-bearing enforcement path if Codex skips the
//! non-managed hook.
//!
//! **Known caveat (auth.json refresh divergence):** we copy the user's
//! `~/.codex/auth.json` into the isolated home at spawn. OAuth access tokens
//! refresh over time. A refresh written into the isolated home does NOT propagate
//! back to the user's real `~/.codex`, and the next spawn re-copies the user's
//! (possibly older) token over the isolated one. This is fine within a session;
//! a follow-up could share the auth file (symlink) or skip the re-copy when the
//! isolated token is newer.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{bail, Context, Result};

/// Preferences key the desktop writes; Core loads it on startup and on change.
pub const CODEX_GATEWAY_ROUTING_PREF_KEY: &str = "codex-gateway-routing";

/// Shared default for ACP subscription egress: Gateway-governed traffic until
/// the user explicitly opts this agent out.
pub const DEFAULT_CODEX_GATEWAY_ROUTING: bool = crate::agent_routing::DEFAULT_GATEWAY_ROUTING;

/// The custom provider id written into the isolated `config.toml`. Arbitrary, but
/// stable so a re-write is idempotent.
const PROVIDER_ID: &str = "ryu-gateway";

/// In-process flag, populated from preferences. Defaults to `true`; an explicit
/// preference value of `false` is the user's direct-egress opt-out.
static GATEWAY_ROUTING: AtomicBool = AtomicBool::new(DEFAULT_CODEX_GATEWAY_ROUTING);

/// CLI argument used by the Ryu-managed Codex `PreToolUse` hook. The hook is a
/// fast, local process invocation so it does not need to start the Core server
/// or touch any durable state.
pub const CODEX_SAFE_DELETE_HOOK_ARG: &str = "--codex-safe-delete-hook";

const SAFETY_BLOCK_START: &str = "<!-- RYU_CODEX_SAFE_DELETE_START -->";
const SAFETY_BLOCK_END: &str = "<!-- RYU_CODEX_SAFE_DELETE_END -->";
const SAFETY_RULES_START: &str = "# RYU_CODEX_SAFE_DELETE_START";
const SAFETY_RULES_END: &str = "# RYU_CODEX_SAFE_DELETE_END";

/// Set the in-process flag from a preferences value. Accepts the common truthy
/// string forms the desktop may persist (`"true"`, `"1"`, `"on"`).
pub fn set_enabled(value: &str) {
    let on = match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => true,
        "false" | "0" | "off" | "no" => false,
        _ => DEFAULT_CODEX_GATEWAY_ROUTING,
    };
    GATEWAY_ROUTING.store(on, Ordering::Relaxed);
}

/// Whether Codex should route its subscription egress through the Ryu gateway
/// passthrough proxy. Read on the synchronous spawn path.
pub fn is_gateway_routing() -> bool {
    GATEWAY_ROUTING.load(Ordering::Relaxed)
}

/// Run the Ryu-managed Codex `PreToolUse` hook when Core was invoked with the
/// hook argument. Returns `true` when the caller must exit immediately.
///
/// This path is intentionally before Core boot: it reads one JSON request from
/// stdin, writes either the Codex deny envelope or nothing, and never opens a
/// database, starts a sidecar, or executes the inspected command.
pub fn run_safe_delete_hook_if_requested() -> bool {
    if !std::env::args().any(|arg| arg == CODEX_SAFE_DELETE_HOOK_ARG) {
        return false;
    }

    let mut input = Vec::new();
    let result = std::io::stdin().read_to_end(&mut input);
    let reason = match result {
        Ok(_) => match serde_json::from_slice::<serde_json::Value>(&input) {
            Ok(payload) => safe_delete_hook_reason(&payload),
            Err(error) => Some(format!(
                "Ryu could not parse the Codex PreToolUse payload ({error}); refusing the tool call"
            )),
        },
        Err(error) => Some(format!(
            "Ryu could not read the Codex PreToolUse payload ({error}); refusing the tool call"
        )),
    };

    if let Some(reason) = reason {
        let response = serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        });
        // Codex reads stdout as the hook result. If stdout itself fails, exit
        // non-zero so the command hook's fail-closed behavior still applies.
        if serde_json::to_writer(std::io::stdout(), &response).is_err() {
            std::process::exit(2);
        }
        println!();
    }
    true
}

/// Return the Codex hook's deny reason for a simulated or real tool payload.
/// `None` means the hook allows the call to continue with the normal Codex
/// permission flow.
fn safe_delete_hook_reason(payload: &serde_json::Value) -> Option<String> {
    let Some(tool_name) = payload
        .get("tool_name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
    else {
        return Some(
            "Ryu could not identify the Codex tool in the PreToolUse payload; refusing the tool call"
                .to_owned(),
        );
    };
    if ryu_deletion_guard::is_filesystem_delete_tool(&tool_name) {
        return Some(format!(
            "Ryu blocked filesystem tool '{tool_name}' because permanent deletion is disabled. Use {} instead; do not silently rewrite the request.",
            trash_command_hint()
        ));
    }

    let tool_input = payload
        .get("tool_input")
        .unwrap_or(&serde_json::Value::Null);
    if matches!(
        tool_name.to_ascii_lowercase().as_str(),
        "apply_patch" | "edit"
    ) {
        let patch_text = hook_commands(tool_input).join("\n");
        if ryu_deletion_guard::patch_deletes_file(&patch_text) {
            return Some(format!(
                "Ryu blocked file deletion through apply_patch because permanent deletion is disabled. Use {} instead; do not silently rewrite the request.",
                trash_command_hint()
            ));
        }
    }

    for command in hook_commands(tool_input) {
        if let Some(rule) = ryu_deletion_guard::detect_command(&command) {
            return Some(format!(
                "Ryu blocked permanent file deletion ({rule}) before shell execution. Use {} instead; do not silently rewrite the request.",
                trash_command_hint()
            ));
        }
    }
    None
}

/// Extract command-shaped fields from the Codex hook payload without treating
/// arbitrary file content as a shell command. Nested `rawInput`/`input` shapes
/// are supported because ACP adapters expose both spellings across versions.
fn hook_commands(value: &serde_json::Value) -> Vec<String> {
    const COMMAND_KEYS: &[&str] = &[
        "command",
        "cmd",
        "script",
        "shellCommand",
        "code",
        "patch",
        "diff",
    ];
    const NESTED_KEYS: &[&str] = &["rawInput", "raw_input", "input"];
    let mut commands = Vec::new();
    fn collect(
        value: &serde_json::Value,
        commands: &mut Vec<String>,
        command_keys: &[&str],
        nested_keys: &[&str],
    ) {
        match value {
            serde_json::Value::String(text) => {
                if !text.trim().is_empty() {
                    commands.push(text.clone());
                }
            }
            serde_json::Value::Object(object) => {
                for key in command_keys {
                    if let Some(value) = object.get(*key) {
                        match value {
                            serde_json::Value::String(text) if !text.trim().is_empty() => {
                                commands.push(text.clone());
                            }
                            serde_json::Value::Array(items) => {
                                let words = items
                                    .iter()
                                    .filter_map(serde_json::Value::as_str)
                                    .collect::<Vec<_>>();
                                if !words.is_empty() {
                                    commands.push(words.join(" "));
                                }
                            }
                            _ => {}
                        }
                    }
                }
                for key in nested_keys {
                    if let Some(value) = object.get(*key) {
                        collect(value, commands, command_keys, nested_keys);
                    }
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    collect(item, commands, command_keys, nested_keys);
                }
            }
            _ => {}
        }
    }
    collect(value, &mut commands, COMMAND_KEYS, NESTED_KEYS);
    commands
}

/// The isolated `CODEX_HOME` for the gateway-routed Codex. Override with
/// `RYU_CODEX_HOME` (the "nothing hardcoded" knob); defaults to
/// `~/.ryu/codex-home`. Kept separate from the user's `~/.codex` so enabling the
/// toggle never mutates their own Codex config.
pub fn codex_home() -> PathBuf {
    if let Ok(custom) = std::env::var("RYU_CODEX_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    crate::sidecar::download_manager::ryu_dir().join("codex-home")
}

/// The user's real `CODEX_HOME` (where their OAuth `auth.json` lives). Honours the
/// `CODEX_HOME` env override Codex itself uses; defaults to `~/.codex`.
fn user_codex_home() -> PathBuf {
    if let Ok(custom) = std::env::var("CODEX_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
}

/// The Ryu-owned Codex home used by the API-key route. It is separate from the
/// subscription home because the latter contains a generated `model_provider`
/// entry and must not change the provider semantics of an API-key invocation.
pub fn safety_home() -> PathBuf {
    if let Ok(custom) = std::env::var("RYU_CODEX_SAFETY_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    crate::sidecar::download_manager::ryu_dir().join("codex-safety-home")
}

/// Materialize Ryu's safe Codex instruction/config/hook/rules layer without
/// touching the user's normal `~/.codex` directory. Existing files in the
/// Ryu-owned home are read-modify-written, preserving unrelated settings and
/// leaving a one-time adjacent backup before the first change.
pub fn ensure_safety_home() -> Result<String> {
    let home = safety_home();
    ensure_safety_files(&home)?;
    Ok(home.to_string_lossy().into_owned())
}

/// Return the verified recoverable deletion command for this host. The string
/// is a template: replace `<absolute-path>` with the quoted absolute target.
/// No command is rewritten or run by this function.
pub fn verified_trash_command() -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        let path = Path::new("/usr/bin/trash");
        if !is_executable_file(path) {
            bail!("macOS recoverable Trash command /usr/bin/trash is unavailable")
        }
        // Do not add `--`: macOS /usr/bin/trash treats it as a filename.
        return Ok("/usr/bin/trash <absolute-path>".to_owned());
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(gio) = executable_on_path(&["gio"]) {
            if command_succeeds(&gio, &["help", "trash"]) {
                return Ok("gio trash <absolute-path>".to_owned());
            }
        }
        if let Some(trash_put) = executable_on_path(&["trash-put"]) {
            if command_succeeds(&trash_put, &["--help"]) {
                return Ok("trash-put <absolute-path>".to_owned());
            }
        }
        bail!(
            "no reliable Linux Trash command is installed; install GLib's `gio` or `trash-cli` (`trash-put`)"
        )
    }

    #[cfg(target_os = "windows")]
    {
        let probe = r#"Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin | Out-Null"#;
        if let Some(powershell) = executable_on_path(&["powershell.exe", "pwsh.exe"]) {
            if command_succeeds(
                &powershell,
                &["-NoProfile", "-NonInteractive", "-Sta", "-Command", probe],
            ) {
                let program = shell_quote_windows(&powershell.to_string_lossy());
                let script = r#"& { param([string]$p); $item = Get-Item -LiteralPath $p; if ($item.PSIsContainer) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($item.FullName, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin) } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($item.FullName, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin) } } '<absolute-path>'"#;
                return Ok(format!(
                    "{program} -NoProfile -NonInteractive -Sta -Command \"{script}\""
                ));
            }
        }
        bail!(
            "no reliable Windows Recycle Bin command is available; enable PowerShell with Microsoft.VisualBasic.FileIO"
        )
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        bail!("Ryu has no verified recoverable Trash or Recycle Bin integration for this OS")
    }
}

/// A non-failing hint used in deny messages, including when the host has no
/// installed recoverable mechanism. `ensure_safety_files` still fails closed in
/// that situation before Ryu launches its managed Codex subprocess.
pub fn trash_command_hint() -> String {
    verified_trash_command()
        .unwrap_or_else(|_| "a configured host Trash or Recycle Bin command".to_owned())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn executable_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        for name in names {
            let candidate = directory.join(name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn command_succeeds(program: &Path, args: &[&str]) -> bool {
    std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn ensure_safety_files(home: &Path) -> Result<()> {
    fs::create_dir_all(home)
        .with_context(|| format!("creating Ryu Codex safety home at {}", home.display()))?;
    set_private_directory_permissions(home)?;
    let trash = verified_trash_command()?;
    ensure_codex_config(home)?;
    ensure_instruction(home, &trash)?;
    ensure_rules(home, &trash)?;
    ensure_hooks(home)?;
    Ok(())
}

fn ensure_codex_config(home: &Path) -> Result<()> {
    let path = home.join("config.toml");
    let mut root = read_toml_table(&path)?;
    let table = root
        .as_table_mut()
        .context("Codex config root must be a TOML table")?;
    if !table.contains_key("sandbox_mode") {
        table.insert(
            "sandbox_mode".to_owned(),
            toml::Value::String("workspace-write".to_owned()),
        );
    }
    if !table.contains_key("approval_policy") {
        table.insert(
            "approval_policy".to_owned(),
            toml::Value::String("on-request".to_owned()),
        );
    }
    let features = table
        .entry("features".to_owned())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    let features = features
        .as_table_mut()
        .context("Codex config [features] must be a TOML table")?;
    features
        .entry("hooks".to_owned())
        .or_insert(toml::Value::Boolean(true));
    write_if_changed(&path, &toml::to_string_pretty(&root)?)
}

fn read_toml_table(path: &Path) -> Result<toml::Value> {
    match fs::read_to_string(path) {
        Ok(raw) => toml::from_str(&raw)
            .with_context(|| format!("parsing existing Codex config {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(toml::Value::Table(toml::map::Map::new()))
        }
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

fn ensure_instruction(home: &Path, trash: &str) -> Result<()> {
    let override_path = home.join("AGENTS.override.md");
    let path = if override_path.exists() {
        override_path
    } else {
        home.join("AGENTS.md")
    };
    let existing = read_optional_text(&path)?;
    let block = format!(
        "{SAFETY_BLOCK_START}\n## Ryu safe deletion policy\n\n- Never permanently delete a file or directory. Move removals to recoverable host Trash or the Recycle Bin.\n- The verified recoverable command for this node is `{trash}`. On macOS use `/usr/bin/trash <absolute-path>` without `--`; if the agent is confined, ask the host/user to run that command outside the confined process.\n- Do not use `rm`, `unlink`, `rmdir`, `shred`, Windows `del`/`erase`/`rd`, PowerShell `Remove-Item`, `find -delete`, `rsync --delete`, destructive Git cleanup/reset/checkout/restore, deletion APIs, or delete-like filesystem tools.\n- Permanent deletion is never authorized by Ryu. If the target cannot be moved to recoverable storage, stop and explain.\n{SAFETY_BLOCK_END}"
    );
    write_if_changed(
        &path,
        &merge_marked_block(&existing, &block, SAFETY_BLOCK_START, SAFETY_BLOCK_END),
    )
}

fn ensure_rules(home: &Path, _trash: &str) -> Result<()> {
    let path = home.join("rules").join("default.rules");
    let existing = read_optional_text(&path)?;
    let block = [
        SAFETY_RULES_START,
        "# Ryu marks direct permanent-deletion command prefixes forbidden. The PreToolUse hook and Core scanner cover compound/API forms.",
        "def _ryu_delete_justification():",
        "    return \"Ryu blocks permanent deletion. Use the verified host Trash or Recycle Bin command instead.\"",
        "",
        "prefix_rule(pattern = [\"rm\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"unlink\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"rmdir\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"shred\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"del\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"erase\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"rd\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"Remove-Item\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"remove-item\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"Remove-ItemProperty\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"remove-itemproperty\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"find\", \"-delete\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"find\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"rsync\", \"--delete\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"rsync\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"git\", \"clean\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"git\", \"reset\", \"--hard\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"git\", \"checkout\", \"--\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        "prefix_rule(pattern = [\"git\", \"restore\", \".\"], decision = \"forbidden\", justification = _ryu_delete_justification())",
        SAFETY_RULES_END,
        "",
    ]
    .join("\n");
    let merged = merge_marked_block(&existing, &block, SAFETY_RULES_START, SAFETY_RULES_END);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating Codex rules directory {}", parent.display()))?;
        set_private_directory_permissions(parent)?;
    }
    write_if_changed(&path, &merged)
}

fn ensure_hooks(home: &Path) -> Result<()> {
    let path = home.join("hooks.json");
    let mut root = match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
            .with_context(|| format!("parsing existing Codex hooks {}", path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    let object = root
        .as_object_mut()
        .context("Codex hooks root must be a JSON object")?;
    let hooks = object
        .entry("hooks".to_owned())
        .or_insert_with(|| serde_json::json!({}));
    let hooks = hooks
        .as_object_mut()
        .context("Codex hooks field must be a JSON object")?;
    let pre_tool_use = hooks
        .entry("PreToolUse".to_owned())
        .or_insert_with(|| serde_json::json!([]));
    let groups = pre_tool_use
        .as_array_mut()
        .context("Codex hooks.PreToolUse must be an array")?;
    let (command, command_windows) = safe_hook_commands()?;
    let mut found = false;
    for group in groups.iter_mut() {
        let Some(group_object) = group.as_object_mut() else {
            continue;
        };
        let Some(handlers) = group_object
            .get_mut("hooks")
            .and_then(|value| value.as_array_mut())
        else {
            continue;
        };
        for handler in handlers {
            let Some(handler_object) = handler.as_object_mut() else {
                continue;
            };
            let is_ryu_hook = handler_object
                .get("command")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| value.contains(CODEX_SAFE_DELETE_HOOK_ARG));
            if is_ryu_hook {
                handler_object.insert("command".to_owned(), command.clone().into());
                handler_object.insert("commandWindows".to_owned(), command_windows.clone().into());
                found = true;
            }
        }
    }
    if !found {
        groups.push(serde_json::json!({
            "matcher": "*",
            "hooks": [{
                "type": "command",
                "command": command,
                "commandWindows": command_windows,
                "timeout": 10,
                "statusMessage": "Ryu: blocking permanent file deletion"
            }]
        }));
    }
    write_if_changed(&path, &serde_json::to_string_pretty(&root)?)
}

fn safe_hook_commands() -> Result<(String, String)> {
    let executable = std::env::current_exe().context("resolving the Ryu Core executable")?;
    let path = executable.to_string_lossy();
    let posix = format!("{} {CODEX_SAFE_DELETE_HOOK_ARG}", shell_quote_posix(&path));
    let windows = format!(
        "{} {CODEX_SAFE_DELETE_HOOK_ARG}",
        shell_quote_windows(&path)
    );
    Ok((posix, windows))
}

fn shell_quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn shell_quote_windows(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn read_optional_text(path: &Path) -> Result<String> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

fn merge_marked_block(existing: &str, block: &str, start: &str, end: &str) -> String {
    if let Some(start_index) = existing.find(start) {
        if let Some(end_offset) = existing[start_index..].find(end) {
            let end_index = start_index + end_offset + end.len();
            return format!(
                "{}{}{}",
                &existing[..start_index],
                block,
                &existing[end_index..]
            );
        }
    }
    if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", existing.trim_end())
    }
}

fn write_if_changed(path: &Path, content: &str) -> Result<()> {
    let existing = read_optional_text(path)?;
    if existing == content {
        return Ok(());
    }
    if path.exists() {
        backup_once(path)?;
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating parent directory {}", parent.display()))?;
    }
    fs::write(path, content).with_context(|| format!("writing {}", path.display()))?;
    set_private_permissions(path);
    Ok(())
}

fn backup_once(path: &Path) -> Result<()> {
    let backup = PathBuf::from(format!("{}.ryu-safety-backup", path.display()));
    if backup.exists() {
        return Ok(());
    }
    fs::copy(path, &backup)
        .with_context(|| format!("creating recoverable safety backup {}", backup.display()))?;
    set_private_permissions(&backup);
    Ok(())
}

fn set_private_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn set_private_directory_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("restricting permissions on {}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// The gateway passthrough base URL Codex is pointed at via the custom provider's
/// `base_url`. Codex appends `/responses` (Responses wire API), which the
/// gateway's `/passthrough/openai-responses/*` proxy forwards upstream to
/// `chatgpt.com/backend-api/codex` with the caller's own subscription auth
/// unchanged.
pub fn passthrough_base_url() -> String {
    let base = crate::sidecar::gateway::gateway_url();
    format!(
        "{}/passthrough/openai-responses",
        base.trim_end_matches('/')
    )
}

/// Prepare the isolated `CODEX_HOME` for gateway routing: materialize Ryu's safe
/// instruction/config/hook/rules layer, copy the user's OAuth `auth.json`
/// (subscription credential) in, then merge a `config.toml` provider whose
/// default points the Responses traffic at the gateway passthrough with no
/// `env_key` (subscription-preserving). Returns the home dir as a string for the
/// `CODEX_HOME` env on the spawn command.
///
/// Idempotent: the generated provider values and safety block are reconciled on
/// each call; unrelated user values in the Ryu-owned home are preserved. A
/// user's real `~/.codex` is never edited. Best-effort on the `auth.json` copy:
/// if the user has not signed into Codex yet there is nothing to copy, and Codex
/// will prompt as usual.
pub fn ensure_gateway_home() -> Result<String> {
    let home = codex_home();
    fs::create_dir_all(&home)
        .with_context(|| format!("creating isolated CODEX_HOME at {}", home.display()))?;

    ensure_safety_files(&home)?;

    // Refresh the OAuth credential from the user's real Codex home so the
    // subscription bearer + account id reach the passthrough. Best-effort.
    let user_auth = user_codex_home().join("auth.json");
    if user_auth.exists() {
        copy_if_changed(&user_auth, &home.join("auth.json"))?;
    }

    let base_url = passthrough_base_url();
    // A custom provider with `wire_api = "responses"` and NO `env_key` makes
    // Codex deliver its subscription-auth request (OAuth bearer + ChatGPT
    // account id) to base_url untouched (verified: headroom proxy design).
    let path = home.join("config.toml");
    let mut config = read_toml_table(&path)?;
    let table = config
        .as_table_mut()
        .context("Codex config root must be a TOML table")?;
    table.insert(
        "model_provider".to_owned(),
        toml::Value::String(PROVIDER_ID.to_owned()),
    );
    let providers = table
        .entry("model_providers".to_owned())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    let providers = providers
        .as_table_mut()
        .context("Codex config [model_providers] must be a TOML table")?;
    let provider = providers
        .entry(PROVIDER_ID.to_owned())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    let provider = provider
        .as_table_mut()
        .context("Codex Ryu provider config must be a TOML table")?;
    provider.insert(
        "name".to_owned(),
        toml::Value::String("Ryu Gateway (subscription passthrough)".to_owned()),
    );
    provider.insert("base_url".to_owned(), toml::Value::String(base_url));
    provider.insert(
        "wire_api".to_owned(),
        toml::Value::String("responses".to_owned()),
    );
    write_if_changed(&path, &toml::to_string_pretty(&config)?)?;

    Ok(home.to_string_lossy().into_owned())
}

fn copy_if_changed(source: &Path, destination: &Path) -> Result<()> {
    let source_bytes = fs::read(source)
        .with_context(|| format!("reading Codex auth source {}", source.display()))?;
    if fs::read(destination).ok().as_deref() == Some(source_bytes.as_slice()) {
        return Ok(());
    }
    if destination.exists() {
        backup_once(destination)?;
    }
    fs::write(destination, source_bytes)
        .with_context(|| format!("writing Codex auth copy {}", destination.display()))?;
    set_private_permissions(destination);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_path(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("ryu-codex-{label}-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn toggle_parses_truthy_forms() {
        set_enabled("true");
        assert!(is_gateway_routing());
        set_enabled("false");
        assert!(!is_gateway_routing());
        set_enabled("  ON ");
        assert!(is_gateway_routing());
        set_enabled("0");
        assert!(!is_gateway_routing());
    }

    #[test]
    fn missing_or_unparseable_preference_keeps_governed_default() {
        set_enabled("");
        assert!(is_gateway_routing());
        set_enabled("not-a-boolean");
        assert!(is_gateway_routing());
    }

    #[test]
    fn passthrough_url_targets_openai_responses_path() {
        // Serialize against every other RYU_GATEWAY_URL toucher (process-global).
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        std::env::set_var("RYU_GATEWAY_URL", "http://test-gw.local:9999");
        let url = passthrough_base_url();
        assert_eq!(
            url,
            "http://test-gw.local:9999/passthrough/openai-responses"
        );
        std::env::remove_var("RYU_GATEWAY_URL");
    }

    #[test]
    fn safe_delete_hook_denies_dangerous_payloads_and_allows_trash() {
        let rm = serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "rm" }
        });
        assert!(safe_delete_hook_reason(&rm)
            .expect("rm must be denied")
            .contains("before shell execution"));

        let patch = serde_json::json!({
            "tool_name": "apply_patch",
            "tool_input": { "patch": "*** Delete File: notes.txt\n" }
        });
        assert!(safe_delete_hook_reason(&patch)
            .expect("file deletion patch must be denied")
            .contains("apply_patch"));

        let mcp = serde_json::json!({
            "tool_name": "mcp__filesystem__delete_file",
            "tool_input": { "path": "/tmp/notes.txt" }
        });
        assert!(safe_delete_hook_reason(&mcp)
            .expect("filesystem delete tool must be denied")
            .contains("filesystem tool"));

        let trash = serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "/usr/bin/trash /tmp/notes.txt" }
        });
        assert_eq!(safe_delete_hook_reason(&trash), None);

        let ordinary = serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "printf 'hello\\n'" }
        });
        assert_eq!(safe_delete_hook_reason(&ordinary), None);
        assert!(safe_delete_hook_reason(&rm).is_some());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_trash_command_is_absolute_and_has_no_double_dash() {
        let command = verified_trash_command().expect("macOS Trash command");
        assert_eq!(command, "/usr/bin/trash <absolute-path>");
        assert!(!command.contains(" --"));
    }

    #[test]
    fn missing_hook_tool_name_fails_closed() {
        let payload = serde_json::json!({ "tool_input": { "command": "echo hi" } });
        assert!(safe_delete_hook_reason(&payload)
            .expect("missing tool name must be denied")
            .contains("identify"));
    }

    #[test]
    fn safety_home_preserves_existing_codex_settings() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        if verified_trash_command().is_err() {
            return;
        }
        let home = unique_test_path("preserve");
        fs::create_dir_all(&home).expect("create test Codex home");
        fs::write(home.join("config.toml"), "model = \"keep-me\"\n").expect("seed config");
        fs::write(home.join("AGENTS.md"), "# existing instructions\n").expect("seed agents");
        fs::write(home.join("hooks.json"), "{}\n").expect("seed hooks");
        fs::create_dir_all(home.join("rules")).expect("create rules");
        fs::write(home.join("rules/default.rules"), "# existing rules\n").expect("seed rules");
        let previous = std::env::var("RYU_CODEX_SAFETY_HOME").ok();
        std::env::set_var("RYU_CODEX_SAFETY_HOME", &home);
        let result = ensure_safety_home();
        match previous {
            Some(value) => std::env::set_var("RYU_CODEX_SAFETY_HOME", value),
            None => std::env::remove_var("RYU_CODEX_SAFETY_HOME"),
        }
        result.expect("materialize safety home");

        let config = fs::read_to_string(home.join("config.toml")).expect("read config");
        assert!(config.contains("model = \"keep-me\""));
        assert!(config.contains("sandbox_mode = \"workspace-write\""));
        assert!(config.contains("approval_policy = \"on-request\""));
        assert!(home.join("config.toml.ryu-safety-backup").exists());
        assert!(home.join("AGENTS.md.ryu-safety-backup").exists());
        assert!(home.join("hooks.json.ryu-safety-backup").exists());
        assert!(home.join("rules/default.rules.ryu-safety-backup").exists());
        assert!(home.join("hooks.json").exists());
        assert!(home.join("rules/default.rules").exists());
        assert!(home.join("AGENTS.md").exists());
    }

    #[test]
    fn ensure_home_writes_config_with_provider_and_no_env_key() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        if verified_trash_command().is_err() {
            return;
        }
        let tmp = unique_test_path("gateway");
        let previous_home = std::env::var("RYU_CODEX_HOME").ok();
        std::env::set_var("RYU_CODEX_HOME", &tmp);
        let home = ensure_gateway_home().expect("ensure home");
        let cfg = std::fs::read_to_string(std::path::Path::new(&home).join("config.toml"))
            .expect("config.toml written");
        assert!(cfg.contains("wire_api = \"responses\""), "got: {cfg}");
        assert!(cfg.contains("model_providers.ryu-gateway"), "got: {cfg}");
        // Subscription-preservation: never an env_key / api key on this path.
        assert!(
            !cfg.contains("env_key"),
            "config must not set env_key: {cfg}"
        );
        let parsed: toml::Value = toml::from_str(&cfg).expect("generated config parses");
        assert_eq!(
            parsed.get("sandbox_mode").and_then(toml::Value::as_str),
            Some("workspace-write")
        );
        assert_eq!(
            parsed.get("approval_policy").and_then(toml::Value::as_str),
            Some("on-request")
        );
        let hooks = std::fs::read_to_string(std::path::Path::new(&home).join("hooks.json"))
            .expect("hooks.json written");
        let hooks: serde_json::Value = serde_json::from_str(&hooks).expect("hooks parse");
        assert_eq!(hooks["hooks"]["PreToolUse"][0]["matcher"], "*");
        assert!(hooks.to_string().contains(CODEX_SAFE_DELETE_HOOK_ARG));
        let instructions = std::fs::read_to_string(std::path::Path::new(&home).join("AGENTS.md"))
            .expect("AGENTS.md written");
        assert!(instructions.contains("Never permanently delete"));
        let rules =
            std::fs::read_to_string(std::path::Path::new(&home).join("rules/default.rules"))
                .expect("default rules written");
        assert!(rules.contains("pattern = [\"del\"]"));
        assert!(rules.contains("pattern = [\"Remove-Item\"]"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&home)
                    .expect("safety home metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        match previous_home {
            Some(value) => std::env::set_var("RYU_CODEX_HOME", value),
            None => std::env::remove_var("RYU_CODEX_HOME"),
        }
    }
}

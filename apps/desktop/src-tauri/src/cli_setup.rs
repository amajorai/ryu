//! Local, reversible Gateway setup for external coding CLIs.
//!
//! This runs in Desktop, not Core: a remote Core must never edit the desktop
//! user's ~/.claude or ~/.codex. The user selects a Gateway client key and model
//! in the UI. Apply records the exact previous file and Reset restores it only
//! while Ryu's written file is still unchanged.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use toml_edit::{value, DocumentMut, Item, Table};

static CLI_SETUP_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CliTool {
    ClaudeCode,
    Codex,
    Opencode,
    GeminiCli,
    Pi,
    Droid,
    Openclaw,
    Hermes,
    Continue,
    Kilo,
    Cline,
    Iflow,
    QwenCode,
    GrokBuild,
    RooCode,
}

impl CliTool {
    fn filename(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::GeminiCli => "gemini-cli",
            Self::Pi => "pi",
            Self::Droid => "droid",
            Self::Openclaw => "openclaw",
            Self::Hermes => "hermes",
            Self::Continue => "continue",
            Self::Kilo => "kilo",
            Self::Cline => "cline",
            Self::Iflow => "iflow",
            Self::QwenCode => "qwen-code",
            Self::GrokBuild => "grok-build",
            Self::RooCode => "roo-code",
        }
    }

    fn config_path(self, home: &Path) -> PathBuf {
        match self {
            Self::ClaudeCode => home.join(".claude").join("settings.json"),
            Self::Codex => home.join(".codex").join("config.toml"),
            Self::Opencode => home.join(".config").join("opencode").join("opencode.json"),
            Self::GeminiCli => home.join(".gemini").join("settings.json"),
            Self::Pi => home.join(".pi").join("agent").join("settings.json"),
            Self::Droid => home.join(".factory").join("settings.json"),
            Self::Openclaw => home.join(".openclaw").join("openclaw.json"),
            Self::Hermes => home.join(".hermes").join("config.yaml"),
            Self::Continue => home.join(".continue").join("config.yaml"),
            Self::Kilo => home.join(".config").join("kilo").join("kilo.json"),
            Self::Cline => home
                .join(".cline")
                .join("data")
                .join("settings")
                .join("providers.json"),
            Self::Iflow => home.join(".iflow").join("settings.json"),
            Self::QwenCode => home.join(".qwen").join("settings.json"),
            Self::GrokBuild => home.join(".grok").join("config.toml"),
            // Exports are resolved against Ryu data, never extension or CLI storage.
            Self::RooCode => cli_setup_dir(home).join("exports").join("roo-code.json"),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct AppliedState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_path: Option<PathBuf>,
    /// The user's config before Ryu touched it, kept for Reset. It can hold the
    /// user's own provider keys, so it is sealed on disk with the desktop key
    /// (`enc:v1:`); legacy plaintext snapshots still read and are resealed.
    #[serde(default, with = "crate::desktop_seal::sealed_opt_string")]
    original: Option<String>,
    applied_hash: String,
    #[serde(default, rename = "jsonc", alias = "opencode_jsonc")]
    opencode_jsonc: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cline_semantic_hash: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliModelLimits {
    context_tokens: u32,
    output_tokens: u32,
}

impl CliModelLimits {
    fn validate(self) -> Result<Self, String> {
        if !(1..=16_777_216).contains(&self.context_tokens)
            || !(1..=1_048_576).contains(&self.output_tokens)
            || self.output_tokens > self.context_tokens
        {
            return Err(
                "Choose valid context and output token limits; output cannot exceed context"
                    .to_owned(),
            );
        }
        Ok(self)
    }
}

#[derive(Serialize, Deserialize)]
struct GeminiAppliedState {
    settings: AppliedState,
    environment: AppliedState,
}

#[derive(Serialize, Deserialize)]
struct PiAppliedState {
    settings: AppliedState,
    models: AppliedState,
}

fn snapshot_matches(current: &Option<String>, state: &AppliedState) -> bool {
    current == &state.original
        || current
            .as_deref()
            .is_some_and(|contents| matches_applied(contents, state))
}

fn cline_semantic_hash(contents: &str) -> Result<String, String> {
    let mut config: serde_json::Value =
        serde_json::from_str(contents).map_err(|_| "Invalid Cline provider JSON".to_owned())?;
    if let Some(entry) = config
        .get_mut("providers")
        .and_then(|providers| providers.get_mut("openai-compatible"))
    {
        {
            let valid = entry
                .get("updatedAt")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| {
                    value.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(value).is_ok()
                });
            if !valid {
                return Err("Invalid Cline provider timestamp".to_owned());
            }
        }
        if let Some(entry) = entry.as_object_mut() {
            entry.remove("updatedAt");
        }
    }
    config.sort_all_objects();
    serde_json::to_string(&config)
        .map(|value| hash(&value))
        .map_err(|_| "Could not compare Cline provider JSON".to_owned())
}

fn matches_applied(contents: &str, state: &AppliedState) -> bool {
    hash(contents) == state.applied_hash
        || state.cline_semantic_hash.as_ref().is_some_and(|expected| {
            cline_semantic_hash(contents).is_ok_and(|actual| &actual == expected)
        })
}

fn restore_file(path: &Path, contents: Option<&str>) -> Result<(), String> {
    if let Some(contents) = contents {
        write_private(path, contents)
    } else {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

fn patched_gemini_environment(
    original: Option<&str>,
    base: &str,
    key: &str,
    model: &str,
) -> Result<String, String> {
    if !key
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        || !model.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/' | b':')
        })
    {
        return Err("Gemini CLI setup requires a Gateway key and model ID that can be stored safely in an environment file".to_owned());
    }
    let mut lines = Vec::new();
    for line in original.unwrap_or("").lines() {
        let name = line
            .trim_start()
            .strip_prefix("export ")
            .unwrap_or(line.trim_start())
            .split_once('=')
            .map(|(name, _)| name.trim());
        if !matches!(
            name,
            Some(
                "GEMINI_API_KEY"
                    | "GEMINI_MODEL"
                    | "GOOGLE_GEMINI_BASE_URL"
                    | "GOOGLE_GENAI_API_VERSION"
            )
        ) {
            lines.push(line.to_owned());
        }
    }
    lines.push(format!("GEMINI_API_KEY={key}"));
    lines.push(format!("GOOGLE_GEMINI_BASE_URL={base}"));
    lines.push(format!("GEMINI_MODEL={model}"));
    lines.push("GOOGLE_GENAI_API_VERSION=v1beta".to_owned());
    Ok(format!("{}\n", lines.join("\n")))
}

fn apply_gemini_at(
    home: &Path,
    data_dir: &Path,
    base: &str,
    key: &str,
    model: &str,
) -> Result<CliSetupStatus, String> {
    let path = CliTool::GeminiCli.config_path(home);
    let environment_path = path.with_file_name(".env");
    let state_file = state_path(data_dir, CliTool::GeminiCli);
    let before = read_regular_file(&path)?;
    let before_environment = read_regular_file(&environment_path)?;
    let prior_raw = read_state_file(&state_file)?;
    let prior = prior_raw
        .as_deref()
        .map(serde_json::from_str::<GeminiAppliedState>)
        .transpose()
        .map_err(|error| error.to_string())?;
    if let Some(prior) = &prior {
        if !snapshot_matches(&before, &prior.settings)
            || !snapshot_matches(&before_environment, &prior.environment)
        {
            return Err("Gemini CLI settings or environment changed after Apply; review both files before applying again".to_owned());
        }
    }
    let original = prior
        .as_ref()
        .map_or_else(|| before.clone(), |state| state.settings.original.clone());
    let original_environment = prior.as_ref().map_or_else(
        || before_environment.clone(),
        |state| state.environment.original.clone(),
    );
    let settings = patched_config(
        CliTool::GeminiCli,
        original.as_deref(),
        base,
        key,
        model,
        None,
    )?;
    let environment =
        patched_gemini_environment(original_environment.as_deref(), base, key, model)?;
    let state = GeminiAppliedState {
        settings: AppliedState {
            original,
            applied_hash: hash(&settings),
            opencode_jsonc: false,
            cline_semantic_hash: None,
            target_path: None,
        },
        environment: AppliedState {
            original: original_environment,
            applied_hash: hash(&environment),
            opencode_jsonc: false,
            cline_semantic_hash: None,
            target_path: None,
        },
    };
    write_private(
        &state_file,
        &serde_json::to_string(&state).map_err(|error| error.to_string())?,
    )?;
    let write_result = write_private(&path, &settings)
        .and_then(|()| write_private(&environment_path, &environment));
    if let Err(error) = write_result {
        restore_file(&path, before.as_deref())?;
        restore_file(&environment_path, before_environment.as_deref())?;
        restore_file(&state_file, prior_raw.as_deref())?;
        return Err(error);
    }
    Ok(CliSetupStatus {
        applied: true,
        conflict: false,
        config_path: path.display().to_string(),
    })
}

fn reset_gemini_at(home: &Path, data_dir: &Path) -> Result<CliSetupStatus, String> {
    let path = CliTool::GeminiCli.config_path(home);
    let environment_path = path.with_file_name(".env");
    let state_file = state_path(data_dir, CliTool::GeminiCli);
    if let Some(raw) = read_state_file(&state_file)? {
        let state: GeminiAppliedState =
            serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let before = read_regular_file(&path)?;
        let before_environment = read_regular_file(&environment_path)?;
        if !snapshot_matches(&before, &state.settings)
            || !snapshot_matches(&before_environment, &state.environment)
        {
            return Err("Gemini CLI settings or environment changed after Apply; Reset will not overwrite those edits".to_owned());
        }
        let restored = restore_file(&path, state.settings.original.as_deref())
            .and_then(|()| restore_file(&environment_path, state.environment.original.as_deref()));
        if let Err(error) = restored {
            restore_file(&path, before.as_deref())?;
            restore_file(&environment_path, before_environment.as_deref())?;
            return Err(error);
        }
        fs::remove_file(state_file).map_err(|error| error.to_string())?;
    }
    Ok(CliSetupStatus {
        applied: false,
        conflict: false,
        config_path: path.display().to_string(),
    })
}

fn patched_pi_settings(original: Option<&str>, model: &str) -> Result<String, String> {
    let mut settings: serde_json::Value = serde_json::from_str(original.unwrap_or("{}"))
        .map_err(|error| format!("Pi settings are invalid JSON: {error}"))?;
    let root = settings
        .as_object_mut()
        .ok_or("Pi settings must be a JSON object")?;
    root.insert("defaultProvider".to_owned(), "ryu-gateway".into());
    root.insert("defaultModel".to_owned(), model.into());
    serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())
}

fn patched_pi_models(
    original: Option<&str>,
    base: &str,
    key: &str,
    model: &str,
) -> Result<String, String> {
    let mut config: serde_json::Value = serde_json::from_str(original.unwrap_or("{}"))
        .map_err(|error| format!("Pi models are invalid JSON: {error}"))?;
    let root = config
        .as_object_mut()
        .ok_or("Pi models must be a JSON object")?;
    let providers = root
        .entry("providers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("Pi models.providers must be a JSON object")?;
    providers.insert(
        "ryu-gateway".to_owned(),
        serde_json::json!({
            "baseUrl": format!("{base}/v1"),
            "api": "openai-responses",
            "apiKey": key,
            "models": [{ "id": model }]
        }),
    );
    serde_json::to_string_pretty(&config).map_err(|error| error.to_string())
}

fn apply_pi_at(
    home: &Path,
    data_dir: &Path,
    base: &str,
    key: &str,
    model: &str,
) -> Result<CliSetupStatus, String> {
    let settings_path = CliTool::Pi.config_path(home);
    let models_path = settings_path.with_file_name("models.json");
    let state_file = state_path(data_dir, CliTool::Pi);
    let before_settings = read_regular_file(&settings_path)?;
    let before_models = read_regular_file(&models_path)?;
    let prior_raw = read_state_file(&state_file)?;
    let prior = prior_raw
        .as_deref()
        .map(serde_json::from_str::<PiAppliedState>)
        .transpose()
        .map_err(|error| error.to_string())?;
    if let Some(state) = &prior {
        if !snapshot_matches(&before_settings, &state.settings)
            || !snapshot_matches(&before_models, &state.models)
        {
            return Err("Pi settings or models changed after Apply; review both files before applying again".to_owned());
        }
    }
    let original_settings = prior.as_ref().map_or_else(
        || before_settings.clone(),
        |state| state.settings.original.clone(),
    );
    let original_models = prior.as_ref().map_or_else(
        || before_models.clone(),
        |state| state.models.original.clone(),
    );
    let settings = patched_pi_settings(original_settings.as_deref(), model)?;
    let models = patched_pi_models(original_models.as_deref(), base, key, model)?;
    let state = PiAppliedState {
        settings: AppliedState {
            original: original_settings,
            applied_hash: hash(&settings),
            opencode_jsonc: false,
            cline_semantic_hash: None,
            target_path: None,
        },
        models: AppliedState {
            original: original_models,
            applied_hash: hash(&models),
            opencode_jsonc: false,
            cline_semantic_hash: None,
            target_path: None,
        },
    };
    write_private(
        &state_file,
        &serde_json::to_string(&state).map_err(|error| error.to_string())?,
    )?;
    let result = write_private(&settings_path, &settings)
        .and_then(|()| write_private(&models_path, &models));
    if let Err(error) = result {
        restore_file(&settings_path, before_settings.as_deref())?;
        restore_file(&models_path, before_models.as_deref())?;
        restore_file(&state_file, prior_raw.as_deref())?;
        return Err(error);
    }
    Ok(CliSetupStatus {
        applied: true,
        conflict: false,
        config_path: settings_path.display().to_string(),
    })
}

fn reset_pi_at(home: &Path, data_dir: &Path) -> Result<CliSetupStatus, String> {
    let settings_path = CliTool::Pi.config_path(home);
    let models_path = settings_path.with_file_name("models.json");
    let state_file = state_path(data_dir, CliTool::Pi);
    if let Some(raw) = read_state_file(&state_file)? {
        let state: PiAppliedState =
            serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let before_settings = read_regular_file(&settings_path)?;
        let before_models = read_regular_file(&models_path)?;
        if !snapshot_matches(&before_settings, &state.settings)
            || !snapshot_matches(&before_models, &state.models)
        {
            return Err(
                "Pi settings or models changed after Apply; Reset will not overwrite those edits"
                    .to_owned(),
            );
        }
        let restored = restore_file(&settings_path, state.settings.original.as_deref())
            .and_then(|()| restore_file(&models_path, state.models.original.as_deref()));
        if let Err(error) = restored {
            restore_file(&settings_path, before_settings.as_deref())?;
            restore_file(&models_path, before_models.as_deref())?;
            return Err(error);
        }
        fs::remove_file(state_file).map_err(|error| error.to_string())?;
    }
    Ok(CliSetupStatus {
        applied: false,
        conflict: false,
        config_path: settings_path.display().to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliSetupStatus {
    applied: bool,
    conflict: bool,
    config_path: String,
}

/// `<data dir>/state/cli-setup` — apply snapshots and Ryu-owned exports.
fn cli_setup_dir(data_dir: &Path) -> PathBuf {
    ryu_sidecar_runtime::layout::state_path(data_dir, "cli-setup")
}

fn state_path(data_dir: &Path, tool: CliTool) -> PathBuf {
    cli_setup_dir(data_dir).join(format!("{}.json", tool.filename()))
}

fn config_path(home: &Path, data_dir: &Path, tool: CliTool) -> Result<PathBuf, String> {
    config_path_with_grok_home(home, data_dir, tool, None)
}

fn config_path_with_grok_home(
    home: &Path,
    data_dir: &Path,
    tool: CliTool,
    grok_home: Option<&std::ffi::OsStr>,
) -> Result<PathBuf, String> {
    if matches!(tool, CliTool::RooCode) {
        let path = tool.config_path(data_dir);
        let parent = path.parent().ok_or("Export path has no parent")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let root = data_dir.canonicalize().map_err(|error| error.to_string())?;
        if !parent
            .canonicalize()
            .map_err(|error| error.to_string())?
            .starts_with(root)
        {
            return Err("Roo export directory escapes Ryu data".into());
        }
        return Ok(path);
    }
    if matches!(tool, CliTool::GrokBuild) {
        if let Some(raw) = read_state_file(&state_path(data_dir, tool))? {
            let state: AppliedState =
                serde_json::from_str(&raw).map_err(|_| "Invalid Grok setup snapshot")?;
            if let Some(path) = state.target_path {
                if !path.is_absolute() || path.file_name().is_none_or(|name| name != "config.toml")
                {
                    return Err("Invalid Grok setup target".into());
                }
                return Ok(path);
            }
        }
        return grok_config_path(home, grok_home);
    }
    let path = tool.config_path(home);
    if !matches!(tool, CliTool::Opencode | CliTool::Kilo) {
        return Ok(path);
    }
    let jsonc = path.with_extension("jsonc");
    // Keep Reset attached to the file Apply edited, even if another config appears.
    if let Some(raw) = read_state_file(&state_path(data_dir, tool))? {
        let state: AppliedState = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        return Ok(if state.opencode_jsonc { jsonc } else { path });
    }
    Ok(if read_regular_file(&jsonc)?.is_some() {
        jsonc
    } else {
        path
    })
}

fn grok_config_path(
    home: &Path,
    override_home: Option<&std::ffi::OsStr>,
) -> Result<PathBuf, String> {
    let directory = override_home
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".grok"));
    if !directory.is_absolute() {
        return Err("GROK_HOME must be an absolute directory".into());
    }
    Ok(directory.join("config.toml"))
}

fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn read_regular_file(path: &Path) -> Result<Option<String>, String> {
    read_regular_file_limited(path, MAX_CONFIG_BYTES)
}

/// Third-party CLI configs Ryu reads or writes.
const MAX_CONFIG_BYTES: usize = 1024 * 1024;
/// Snapshots hold up to two sealed config copies; sealing adds base64's third.
const MAX_STATE_BYTES: usize = 4 * MAX_CONFIG_BYTES;

/// Read a Ryu-owned snapshot under `state/cli-setup/`.
fn read_state_file(path: &Path) -> Result<Option<String>, String> {
    read_regular_file_limited(path, MAX_STATE_BYTES)
}

/// Write a Ryu-owned snapshot under `state/cli-setup/` (owner-only, like configs).
fn write_state_file(path: &Path, contents: &str) -> Result<(), String> {
    write_private_with_limit(path, contents, MAX_STATE_BYTES)
}

/// Seal the plaintext `original` copies a snapshot written before sealing still
/// holds. Runs from the status command, so existing snapshots migrate on the
/// first visit to the CLI setup screen instead of waiting for the next Apply.
fn reseal_legacy_snapshots(data_dir: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(cli_setup_dir(data_dir)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let Some(raw) = read_state_file(&path)? else {
            continue;
        };
        if let Some(resealed) = crate::desktop_seal::reseal_json_originals(&raw)? {
            write_state_file(&path, &resealed)?;
        }
    }
    Ok(())
}

fn read_regular_file_limited(path: &Path, limit: usize) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    if metadata.len() > limit as u64 {
        return Err(format!(
            "{} exceeds the {} MiB limit",
            path.display(),
            limit / MAX_CONFIG_BYTES
        ));
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
mod windows_private_file {
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::{
        GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        AddAccessAllowedAceEx, CreateWellKnownSid, EqualSid, GetLengthSid, GetTokenInformation,
        InitializeAcl, TokenUser, WinLocalSystemSid, ACCESS_ALLOWED_ACE, ACE_FLAGS, ACL,
        ACL_REVISION, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_MAX_SID_SIZE,
        TOKEN_QUERY, TOKEN_USER, WELL_KNOWN_SID_TYPE,
    };
    use windows::Win32::Storage::FileSystem::{
        ReOpenFile, FILE_ALL_ACCESS, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, READ_CONTROL, WRITE_DAC, WRITE_OWNER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: This wrapper owns only successful OpenProcessToken/ReOpenFile handles.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn api_error(error: windows::core::Error) -> String {
        format!("Cannot secure private CLI file: {error}")
    }

    pub(super) fn current_user() -> Result<Vec<usize>, String> {
        let mut token = HANDLE::default();
        // SAFETY: The process pseudo-handle is borrowed; the returned token handle is owned.
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
            .map_err(api_error)?;
        let token = OwnedHandle(token);
        let mut required = 0;
        // SAFETY: A null buffer requests only the trusted token's required buffer size.
        let first = unsafe { GetTokenInformation(token.0, TokenUser, None, 0, &mut required) };
        if first.is_ok() || required < std::mem::size_of::<TOKEN_USER>() as u32 || required > 4096 {
            return Err("Cannot read current process user SID".into());
        }
        let mut buffer = vec![0usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
        // SAFETY: usize storage aligns TOKEN_USER; allocation covers the OS-reported byte count.
        unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                required,
                &mut required,
            )
        }
        .map_err(api_error)?;
        Ok(buffer)
    }

    pub(super) fn user_sid(buffer: &[usize]) -> PSID {
        // SAFETY: Only buffers returned successfully by current_user reach this helper.
        unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }

    pub(super) fn well_known(kind: WELL_KNOWN_SID_TYPE) -> Result<Vec<usize>, String> {
        let mut buffer =
            vec![0usize; (SECURITY_MAX_SID_SIZE as usize).div_ceil(std::mem::size_of::<usize>())];
        let mut bytes = SECURITY_MAX_SID_SIZE;
        // SAFETY: Aligned storage covers the documented maximum SID size; no domain SID is needed.
        unsafe {
            CreateWellKnownSid(
                kind,
                None,
                Some(PSID(buffer.as_mut_ptr().cast())),
                &mut bytes,
            )
        }
        .map_err(api_error)?;
        Ok(buffer)
    }

    pub(super) fn sid(buffer: &[usize]) -> PSID {
        PSID(buffer.as_ptr().cast_mut().cast())
    }

    pub(super) fn acl(sids: &[PSID], flags: ACE_FLAGS) -> Result<Vec<u32>, String> {
        acl_with_access(sids, flags, FILE_ALL_ACCESS.0)
    }

    pub(super) fn acl_with_access(
        sids: &[PSID],
        flags: ACE_FLAGS,
        access: u32,
    ) -> Result<Vec<u32>, String> {
        let ace_header = std::mem::size_of::<ACCESS_ALLOWED_ACE>() - std::mem::size_of::<u32>();
        // SAFETY: Every SID here is from GetTokenInformation or CreateWellKnownSid and remains alive.
        let bytes = std::mem::size_of::<ACL>()
            + sids
                .iter()
                .map(|sid| ace_header + unsafe { GetLengthSid(*sid) } as usize)
                .sum::<usize>();
        let length = u32::try_from(bytes).map_err(|_| "Private ACL is too large")?;
        let mut buffer = vec![0u32; bytes.div_ceil(std::mem::size_of::<u32>())];
        let acl = buffer.as_mut_ptr().cast::<ACL>();
        // SAFETY: u32 storage aligns ACL and contains space for every complete allow ACE.
        unsafe { InitializeAcl(acl, length, ACL_REVISION) }.map_err(api_error)?;
        for sid in sids {
            // No inherited/broad grant: production passes only current user and SYSTEM, with flags 0.
            unsafe { AddAccessAllowedAceEx(acl, ACL_REVISION, flags, access, *sid) }
                .map_err(api_error)?;
        }
        Ok(buffer)
    }

    pub(super) fn secure(file: &File) -> Result<(), String> {
        let owner_buffer = current_user()?;
        let system_buffer = well_known(WinLocalSystemSid)?;
        let owner = user_sid(&owner_buffer);
        let dacl = acl(&[owner, sid(&system_buffer)], ACE_FLAGS(0))?;
        // Normal callers need only DACL rights, not WRITE_OWNER on an inherited Modify-only file.
        // std/tempfile's read/write handle does not itself grant these security rights.
        let handle = unsafe {
            ReOpenFile(
                HANDLE(file.as_raw_handle()),
                READ_CONTROL.0 | WRITE_DAC.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_FLAGS_AND_ATTRIBUTES(0),
            )
        }
        .map_err(|error| format!("Cannot secure private CLI file (reopen DACL handle): {error}"))?;
        let handle = OwnedHandle(handle);
        // SAFETY: Empty file object remains pinned by both handles; SID/ACL buffers remain live.
        // SetSecurityInfo copies them and protects the DACL from directory inheritance.
        unsafe {
            SetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(dacl.as_ptr().cast::<ACL>()),
                None,
            )
        }
        .ok()
        .map_err(|error| format!("Cannot secure private CLI file (set protected DACL): {error}"))?;
        let mut existing_owner = PSID::default();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            GetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                Some(&mut existing_owner),
                None,
                None,
                None,
                Some(&mut descriptor),
            )
        }
        .ok()
        .map_err(|error| format!("Cannot secure private CLI file (query owner): {error}"))?;
        let already_owned = unsafe { EqualSid(existing_owner, owner) }.is_ok();
        // GetSecurityInfo allocates its descriptor. Its borrowed SID is no longer used after comparison.
        unsafe {
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        }
        if !already_owned {
            // Only an actual different-owner case needs ownership rights. The protected DACL now
            // grants this exact user full access without requiring an administrator/broad-group grant.
            let owner_handle = unsafe {
                ReOpenFile(
                    HANDLE(file.as_raw_handle()),
                    READ_CONTROL.0 | WRITE_OWNER.0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    FILE_FLAGS_AND_ATTRIBUTES(0),
                )
            }
            .map_err(|error| {
                format!("Cannot secure private CLI file (reopen owner handle): {error}")
            })?;
            let owner_handle = OwnedHandle(owner_handle);
            unsafe {
                SetSecurityInfo(
                    owner_handle.0,
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION,
                    Some(owner),
                    None,
                    None,
                    None,
                )
            }
            .ok()
            .map_err(|error| {
                format!("Cannot secure private CLI file (set required owner): {error}")
            })?;
        }
        Ok(())
    }
}

fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    write_private_with_limit(path, contents, MAX_CONFIG_BYTES)
}

fn write_private_with_security(
    path: &Path,
    contents: &str,
    secure: impl FnOnce(&fs::File) -> Result<(), String>,
) -> Result<(), String> {
    write_private_with_security_limited(path, contents, MAX_CONFIG_BYTES, secure)
}

fn write_private_with_limit(path: &Path, contents: &str, limit: usize) -> Result<(), String> {
    write_private_with_security_limited(path, contents, limit, |file| {
        #[cfg(windows)]
        {
            windows_private_file::secure(file)?;
        }
        #[cfg(not(windows))]
        let _ = file;
        Ok(())
    })
}

fn write_private_with_security_limited(
    path: &Path,
    contents: &str,
    limit: usize,
    secure: impl FnOnce(&fs::File) -> Result<(), String>,
) -> Result<(), String> {
    if contents.len() > limit {
        return Err(format!(
            "CLI settings or snapshot exceeds the {} MiB limit",
            limit / MAX_CONFIG_BYTES
        ));
    }
    let parent = path.parent().ok_or("config path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    // Security failure drops the still-EMPTY temporary file and never changes the original target.
    secure(temporary.as_file())?;
    temporary
        .write_all(contents.as_bytes())
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    temporary
        .persist(path)
        .map_err(|error| error.error.to_string())?;
    Ok(())
}

fn validate_gateway_url(raw: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid Gateway URL".to_owned())?;
    let host = url.host_str().ok_or("Gateway URL has no host")?;
    let local = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    if (local && url.scheme() != "http" && url.scheme() != "https")
        || (!local && url.scheme() != "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Gateway URL must be a root HTTP loopback URL or an HTTPS URL".to_owned());
    }
    Ok(raw.trim_end_matches('/').to_owned())
}

fn patched_qwen(
    original: Option<&str>,
    base: &str,
    key: &str,
    model: &str,
) -> Result<String, String> {
    let mut config: serde_json::Value = serde_json::from_str(original.unwrap_or("{}"))
        .map_err(|_| "Qwen Code settings are invalid JSON".to_owned())?;
    let root = config
        .as_object_mut()
        .ok_or("Qwen Code settings must be an object")?;
    if root
        .get("$version")
        .is_some_and(|value| value.as_u64() != Some(4))
    {
        return Err("Qwen Code setup requires settings schema version 4; migrate older settings with Qwen first".into());
    }
    root.insert("$version".into(), 4.into());
    let environment = root
        .entry("env")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("Qwen Code env must be an object")?;
    if environment.contains_key("RYU_GATEWAY_API_KEY") {
        return Err(
            "Qwen Code already has RYU_GATEWAY_API_KEY; review that entry before applying".into(),
        );
    }
    environment.insert("RYU_GATEWAY_API_KEY".into(), key.into());
    let providers = root
        .entry("modelProviders")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("Qwen Code modelProviders must be an object")?;
    let models = providers
        .entry("openai")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or("Qwen Code openai models must be an array")?;
    if models
        .iter()
        .any(|entry| entry.get("id").and_then(serde_json::Value::as_str) == Some(model))
    {
        return Err("Qwen Code already has this OpenAI model ID; choose a distinct Gateway alias before applying".into());
    }
    models.push(serde_json::json!({"id":model,"name":model,"envKey":"RYU_GATEWAY_API_KEY","baseUrl":format!("{base}/v1")}));
    let security = root
        .entry("security")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("Qwen Code security must be an object")?;
    let auth = security
        .entry("auth")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("Qwen Code auth must be an object")?;
    auth.insert("selectedType".into(), "openai".into());
    let selected = root
        .entry("model")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("Qwen Code model must be an object")?;
    selected.insert("name".into(), model.into());
    serde_json::to_string_pretty(&config).map_err(|_| "Could not encode Qwen Code settings".into())
}

fn json_object_field<'a>(
    parent: &'a mut serde_json::Map<String, serde_json::Value>,
    name: &str,
) -> Result<&'a mut serde_json::Map<String, serde_json::Value>, String> {
    parent
        .entry(name)
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("OpenClaw {name} must be an object"))
}

fn patched_openclaw(
    original: Option<&str>,
    base: &str,
    key: &str,
    model: &str,
) -> Result<String, String> {
    let mut config: serde_json::Value = json5::from_str(original.unwrap_or("{}"))
        .map_err(|_| "OpenClaw config is invalid JSON5".to_owned())?;
    let root = config
        .as_object_mut()
        .ok_or("OpenClaw config must be an object")?;
    let providers = json_object_field(json_object_field(root, "models")?, "providers")?;
    if providers.contains_key("ryu-gateway") {
        return Err(
            "OpenClaw already has a ryu-gateway provider; review that entry before applying"
                .to_owned(),
        );
    }
    providers.insert(
        "ryu-gateway".to_owned(),
        serde_json::json!({
            "baseUrl":format!("{base}/v1"), "apiKey":key, "api":"openai-completions",
            "authHeader":true, "models":[{"id":model,"name":model}]
        }),
    );
    let defaults = json_object_field(json_object_field(root, "agents")?, "defaults")?;
    let selected = defaults
        .entry("model")
        .or_insert_with(|| serde_json::json!({}));
    if selected.is_string() {
        *selected = serde_json::json!({});
    }
    let selected = selected
        .as_object_mut()
        .ok_or("OpenClaw default model must be text or an object")?;
    selected.insert(
        "primary".to_owned(),
        serde_json::json!(format!("ryu-gateway/{model}")),
    );
    selected.insert("fallbacks".to_owned(), serde_json::json!([]));
    json_object_field(defaults, "models")?.insert(
        format!("ryu-gateway/{model}"),
        serde_json::json!({"alias":"Ryu Gateway"}),
    );
    serde_json::to_string_pretty(&config).map_err(|_| "Could not encode OpenClaw config".to_owned())
}

fn yaml_mapping_field<'a>(
    parent: &'a mut serde_yaml::Mapping,
    name: &str,
) -> Result<&'a mut serde_yaml::Mapping, String> {
    parent
        .entry(serde_yaml::Value::String(name.to_owned()))
        .or_insert_with(|| serde_yaml::Value::Mapping(Default::default()))
        .as_mapping_mut()
        .ok_or_else(|| format!("Hermes {name} must be a mapping"))
}

fn patched_hermes(
    original: Option<&str>,
    base: &str,
    key: &str,
    model: &str,
) -> Result<String, String> {
    let mut config: serde_yaml::Value = serde_yaml::from_str(original.unwrap_or("{}"))
        .map_err(|_| "Hermes config is invalid YAML".to_owned())?;
    let root = config
        .as_mapping_mut()
        .ok_or("Hermes config must be a mapping")?;
    let providers = yaml_mapping_field(root, "providers")?;
    let provider_key = serde_yaml::Value::String("ryu-gateway".to_owned());
    if providers.contains_key(&provider_key) {
        return Err(
            "Hermes already has a ryu-gateway provider; review that entry before applying"
                .to_owned(),
        );
    }
    let provider = serde_yaml::to_value(serde_json::json!({
        "api":format!("{base}/v1"), "api_key":key, "transport":"openai_chat",
        "session_affinity_header":"x-ryu-session-id", "models":[model]
    }))
    .map_err(|_| "Could not encode Hermes provider".to_owned())?;
    providers.insert(provider_key, provider);
    let model_key = serde_yaml::Value::String("model".to_owned());
    if root
        .get(&model_key)
        .is_some_and(|value| value.is_string() || value.is_null())
    {
        root.insert(model_key, serde_yaml::Value::Mapping(Default::default()));
    }
    let selected = yaml_mapping_field(root, "model")?;
    for (name, value) in [
        ("provider", "custom:ryu-gateway".to_owned()),
        ("default", model.to_owned()),
        ("base_url", format!("{base}/v1")),
        ("api_mode", "chat_completions".to_owned()),
    ] {
        selected.insert(
            serde_yaml::Value::String(name.to_owned()),
            serde_yaml::Value::String(value),
        );
    }
    // Old per-model credential overrides must not send another provider's key to Ryu.
    selected.remove(serde_yaml::Value::String("api_key".to_owned()));
    selected.remove(serde_yaml::Value::String("key_env".to_owned()));
    root.insert(
        serde_yaml::Value::String("fallback_providers".to_owned()),
        serde_yaml::Value::Sequence(Vec::new()),
    );
    serde_yaml::to_string(&config).map_err(|_| "Could not encode Hermes config".to_owned())
}

fn patched_continue(
    original: Option<&str>,
    base: &str,
    key: &str,
    model: &str,
) -> Result<String, String> {
    let mut config: serde_yaml::Value = serde_yaml::from_str(original.unwrap_or("{}"))
        .map_err(|_| "Continue config is invalid YAML".to_owned())?;
    if config.is_null() {
        config = serde_yaml::Value::Mapping(Default::default());
    }
    let root = config
        .as_mapping_mut()
        .ok_or("Continue config must be a mapping")?;
    for (name, default) in [
        ("name", "Ryu Gateway"),
        ("version", "1.0.0"),
        ("schema", "v1"),
    ] {
        let value = root
            .entry(serde_yaml::Value::String(name.to_owned()))
            .or_insert_with(|| serde_yaml::Value::String(default.to_owned()));
        if !value.as_str().is_some_and(|value| !value.trim().is_empty()) {
            return Err(format!("Continue {name} must be nonempty text"));
        }
    }
    if root
        .get(serde_yaml::Value::String("schema".to_owned()))
        .and_then(serde_yaml::Value::as_str)
        != Some("v1")
    {
        return Err("Continue setup requires config schema v1".to_owned());
    }
    let models = root
        .entry(serde_yaml::Value::String("models".to_owned()))
        .or_insert_with(|| serde_yaml::Value::Sequence(Vec::new()))
        .as_sequence_mut()
        .ok_or("Continue models must be a list")?;
    if models
        .iter()
        .any(|entry| entry.get("name").and_then(serde_yaml::Value::as_str) == Some("Ryu Gateway"))
    {
        return Err(
            "Continue already has a Ryu Gateway model; review that entry before applying"
                .to_owned(),
        );
    }
    let gateway = serde_yaml::to_value(serde_json::json!({
        "name":"Ryu Gateway", "provider":"openai", "model":model,
        "apiBase":format!("{base}/v1"), "apiKey":key,
        "roles":["chat","edit","apply"], "capabilities":["tool_use"]
    }))
    .map_err(|_| "Could not encode Continue model".to_owned())?;
    models.insert(0, gateway);
    serde_yaml::to_string(&config).map_err(|_| "Could not encode Continue config".to_owned())
}

fn patched_grok(
    original: Option<&str>,
    base: &str,
    key: &str,
    model: &str,
    limits: Option<CliModelLimits>,
) -> Result<String, String> {
    let mut config: DocumentMut = original
        .unwrap_or("")
        .parse()
        .map_err(|_| "Grok Build config is invalid TOML")?;
    if config
        .get("model")
        .and_then(Item::as_table)
        .is_some_and(|models| models.contains_key("ryu"))
    {
        return Err("Grok Build already has model.ryu; review that entry before applying".into());
    }
    if config.get("models").is_none() {
        config["models"] = Item::Table(Table::new());
    }
    let defaults = config["models"]
        .as_table_mut()
        .ok_or("Grok models must be a TOML table")?;
    let mut selected = toml_edit::Value::from("ryu");
    if let Some(previous) = defaults.get("default") {
        let previous = previous
            .as_value()
            .filter(|value| value.as_str().is_some())
            .ok_or("Grok default model must be a string")?;
        *selected.decor_mut() = previous.decor().clone();
    }
    defaults.insert("default", Item::Value(selected));
    if config.get("model").is_none() {
        config["model"] = Item::Table(Table::new());
    }
    let models = config["model"]
        .as_table_mut()
        .ok_or("Grok model must be a TOML table")?;
    let mut ryu = Table::new();
    ryu["model"] = value(model);
    ryu["name"] = value("Ryu Gateway");
    ryu["base_url"] = value(format!("{base}/v1"));
    ryu["api_backend"] = value("responses");
    // A literal per-model client key prevents fallback to the user's xAI session.
    ryu["api_key"] = value(key);
    if let Some(limits) = limits.map(CliModelLimits::validate).transpose()? {
        ryu["context_window"] = value(i64::from(limits.context_tokens));
        ryu["max_completion_tokens"] = value(i64::from(limits.output_tokens));
    }
    models.insert("ryu", Item::Table(ryu));
    Ok(config.to_string())
}

fn roo_profile_export(base: &str, key: &str, model: &str) -> Result<String, String> {
    serde_json::to_string_pretty(&serde_json::json!({
        "providerProfiles": {
            "currentApiConfigName": "Ryu Gateway",
            "apiConfigs": { "Ryu Gateway": {
                "id": "ryu-gateway", "apiProvider": "openai",
                "openAiBaseUrl": format!("{base}/v1"),
                "openAiApiKey": key, "openAiModelId": model
            }}
        },
        "globalSettings": {}
    }))
    .map_err(|_| "Could not encode Roo Code profile export".into())
}

fn patched_config(
    tool: CliTool,
    original: Option<&str>,
    base_url: &str,
    key: &str,
    model: &str,
    model_limits: Option<CliModelLimits>,
) -> Result<String, String> {
    match tool {
        CliTool::GrokBuild => patched_grok(original, base_url, key, model, model_limits),
        CliTool::RooCode => roo_profile_export(base_url, key, model),
        CliTool::QwenCode => patched_qwen(original, base_url, key, model),
        CliTool::Iflow => {
            let mut config: serde_json::Value = serde_json::from_str(original.unwrap_or("{}"))
                .map_err(|_| "iFlow settings are invalid JSON".to_owned())?;
            let root = config
                .as_object_mut()
                .ok_or("iFlow settings must be an object")?;
            root.insert("selectedAuthType".to_owned(), "openai-compatible".into());
            root.insert("apiKey".to_owned(), key.into());
            root.insert("baseUrl".to_owned(), format!("{base_url}/v1").into());
            root.insert("modelName".to_owned(), model.into());
            serde_json::to_string_pretty(&config)
                .map_err(|_| "Could not encode iFlow settings".to_owned())
        }
        CliTool::Cline => {
            let mut config: serde_json::Value = serde_json::from_str(
                original.unwrap_or(r#"{"version":1,"modes":{},"providers":{}}"#),
            )
            .map_err(|_| "Cline provider settings are invalid JSON".to_owned())?;
            let root = config
                .as_object_mut()
                .ok_or("Cline provider settings must be an object")?;
            if root.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
                return Err("Cline setup requires provider-settings version 1".to_owned());
            }
            let providers = root
                .entry("providers")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or("Cline providers must be an object")?;
            let entry = providers
                .entry("openai-compatible")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or("Cline OpenAI entry must be an object")?;
            let settings = entry
                .entry("settings")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or("Cline OpenAI settings must be an object")?;
            settings.insert("provider".to_owned(), "openai-compatible".into());
            settings.insert("model".to_owned(), model.into());
            settings.insert("apiKey".to_owned(), key.into());
            settings.insert("baseUrl".to_owned(), format!("{base_url}/v1").into());
            settings.remove("auth");
            entry.insert("tokenSource".to_owned(), "manual".into());
            entry.insert(
                "updatedAt".to_owned(),
                chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    .into(),
            );
            root.insert("lastUsedProvider".to_owned(), "openai-compatible".into());
            serde_json::to_string_pretty(&config)
                .map_err(|_| "Could not encode Cline provider settings".to_owned())
        }
        CliTool::Openclaw => patched_openclaw(original, base_url, key, model),
        CliTool::Hermes => patched_hermes(original, base_url, key, model),
        CliTool::Continue => patched_continue(original, base_url, key, model),
        CliTool::Pi => Err("Pi setup uses settings.json and models.json together".to_owned()),
        CliTool::Droid => {
            let mut config: serde_json::Value = serde_json::from_str(original.unwrap_or("{}"))
                .map_err(|error| format!("Droid settings are invalid JSON: {error}"))?;
            let root = config
                .as_object_mut()
                .ok_or("Droid settings must be a JSON object")?;
            let models = root
                .entry("customModels")
                .or_insert_with(|| serde_json::json!([]))
                .as_array_mut()
                .ok_or("Droid customModels must be an array")?;
            if models
                .iter()
                .any(|entry| entry.get("model").and_then(serde_json::Value::as_str) == Some(model))
            {
                return Err("Droid already has a custom model with this ID; choose another Gateway model or remove the conflicting entry first".to_owned());
            }
            models.push(serde_json::json!({
                "model": model,
                "displayName": format!("Ryu Gateway: {model}"),
                "baseUrl": format!("{base_url}/v1"),
                "apiKey": key,
                "provider": "generic-chat-completion-api"
            }));
            root.insert("model".to_owned(), format!("custom:{model}").into());
            serde_json::to_string_pretty(&config).map_err(|error| error.to_string())
        }
        CliTool::GeminiCli => {
            use jsonc_parser::cst::{CstInputValue, CstRootNode};
            let config = CstRootNode::parse(original.unwrap_or("{}"), &Default::default())
                .map_err(|error| format!("Gemini CLI settings are invalid JSONC: {error}"))?;
            let root = config
                .object_value()
                .ok_or("Gemini CLI settings must be an object")?;
            let security = root
                .object_value_or_create("security")
                .ok_or("Gemini CLI security settings must be an object")?;
            let auth = security
                .object_value_or_create("auth")
                .ok_or("Gemini CLI auth settings must be an object")?;
            let value = CstInputValue::from("gemini-api-key");
            if let Some(existing) = auth.get("selectedType") {
                existing.set_value(value);
            } else {
                auth.append("selectedType", value);
            }
            let model_settings = root
                .object_value_or_create("model")
                .ok_or("Gemini CLI model settings must be an object")?;
            if let Some(existing) = model_settings.get("name") {
                existing.set_value(model.into());
            } else {
                model_settings.append("name", model.into());
            }
            Ok(config.to_string())
        }
        CliTool::ClaudeCode => {
            let mut config: serde_json::Value = serde_json::from_str(original.unwrap_or("{}"))
                .map_err(|error| format!("Claude Code settings are invalid JSON: {error}"))?;
            let root = config
                .as_object_mut()
                .ok_or("Claude Code settings must be a JSON object")?;
            let env = root
                .entry("env")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or("Claude Code settings.env must be a JSON object")?;
            env.insert("ANTHROPIC_BASE_URL".to_owned(), base_url.into());
            env.insert("ANTHROPIC_AUTH_TOKEN".to_owned(), key.into());
            env.insert("ANTHROPIC_MODEL".to_owned(), model.into());
            serde_json::to_string_pretty(&config).map_err(|error| error.to_string())
        }
        CliTool::Codex => {
            let mut config: DocumentMut = original
                .unwrap_or("")
                .parse()
                .map_err(|error| format!("Codex config is invalid TOML: {error}"))?;
            config["model_provider"] = value("ryu-gateway");
            config["model"] = value(model);
            if config.get("model_providers").is_none() {
                config["model_providers"] = Item::Table(Table::new());
            }
            let providers = config["model_providers"]
                .as_table_mut()
                .ok_or("Codex model_providers must be a TOML table")?;
            if !providers.contains_key("ryu-gateway") {
                providers.insert("ryu-gateway", Item::Table(Table::new()));
            }
            let ryu = providers["ryu-gateway"]
                .as_table_mut()
                .ok_or("Codex ryu-gateway provider must be a TOML table")?;
            ryu["name"] = value("Ryu Gateway");
            ryu["base_url"] = value(format!("{base_url}/v1"));
            ryu["wire_api"] = value("responses");
            ryu["experimental_bearer_token"] = value(key);
            Ok(config.to_string())
        }
        CliTool::Opencode | CliTool::Kilo => {
            use jsonc_parser::cst::{CstInputValue, CstRootNode};
            use jsonc_parser::json;
            let config = CstRootNode::parse(original.unwrap_or("{}"), &Default::default())
                .map_err(|_| "CLI config is invalid JSONC".to_owned())?;
            let root = config
                .object_value()
                .ok_or("CLI config must be a JSON object")?;
            if matches!(tool, CliTool::Opencode) && root.get("$schema").is_none() {
                root.append("$schema", "https://opencode.ai/config.json".into());
            }
            if matches!(tool, CliTool::Kilo) {
                if root.get("$schema").is_none() {
                    root.append("$schema", "https://app.kilo.ai/config.json".into());
                }
                if root.get("permission").is_none() {
                    root.append("permission", json!({"bash":"ask"}));
                }
            }
            let providers = root
                .object_value_or_create("provider")
                .ok_or("CLI provider must be a JSON object")?;
            if matches!(tool, CliTool::Kilo) && providers.get("ryu-gateway").is_some() {
                return Err(
                    "Kilo already has a ryu-gateway provider; review that entry before applying"
                        .to_owned(),
                );
            }
            let model_options = if matches!(tool, CliTool::Kilo) {
                let limits = model_limits
                    .ok_or("Enter Kilo model context and output token limits")?
                    .validate()?;
                let context = limits.context_tokens;
                let output = limits.output_tokens;
                let token_limits = json!({"context":context,"output":output});
                json!({"name":model,"tool_call":true,"limit":token_limits})
            } else {
                json!({"name":model})
            };
            let models = CstInputValue::Object(vec![(model.to_owned(), model_options)]);
            let base = format!("{base_url}/v1");
            let options = json!({ "baseURL": base, "apiKey": key });
            let gateway = json!({
                "npm": "@ai-sdk/openai-compatible",
                "name": "Ryu Gateway",
                "options": options,
                "models": models
            });
            match providers.get("ryu-gateway") {
                Some(existing) => existing.set_value(gateway),
                None => {
                    providers.append("ryu-gateway", gateway);
                }
            }
            let model = format!("ryu-gateway/{model}").into();
            match root.get("model") {
                Some(existing) => existing.set_value(model),
                None => {
                    root.append("model", model);
                }
            }
            Ok(config.to_string())
        }
    }
}

fn apply_at(
    home: &Path,
    data_dir: &Path,
    tool: CliTool,
    base_url: &str,
    key: &str,
    model: &str,
    model_limits: Option<CliModelLimits>,
) -> Result<CliSetupStatus, String> {
    apply_at_with_grok_home(
        home,
        data_dir,
        tool,
        base_url,
        key,
        model,
        model_limits,
        None,
    )
}

fn apply_at_with_grok_home(
    home: &Path,
    data_dir: &Path,
    tool: CliTool,
    base_url: &str,
    key: &str,
    model: &str,
    model_limits: Option<CliModelLimits>,
    grok_home: Option<&std::ffi::OsStr>,
) -> Result<CliSetupStatus, String> {
    let base_url = validate_gateway_url(base_url)?;
    ryu_gw_credentials::validate(key).map_err(|error| error.to_string())?;
    let model = model.trim();
    if model.is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
        return Err("Choose a valid Gateway model ID".to_owned());
    }
    if matches!(tool, CliTool::GeminiCli) {
        return apply_gemini_at(home, data_dir, &base_url, key, model);
    }
    if matches!(tool, CliTool::Pi) {
        return apply_pi_at(home, data_dir, &base_url, key, model);
    }
    let path = config_path_with_grok_home(home, data_dir, tool, grok_home)?;
    let state_file = state_path(data_dir, tool);
    let current = read_regular_file(&path)?;
    let prior_raw = read_state_file(&state_file)?;
    let prior = prior_raw
        .clone()
        .map(|raw| serde_json::from_str::<AppliedState>(&raw).map_err(|error| error.to_string()))
        .transpose()?;
    let original =
        match prior {
            Some(state)
                if current
                    .as_deref()
                    .is_some_and(|value| matches_applied(value, &state))
                    || current == state.original =>
            {
                state.original
            }
            Some(_) => return Err(
                "CLI config changed since Ryu applied it; review that file before applying again"
                    .to_owned(),
            ),
            None => current,
        };
    let patched = patched_config(
        tool,
        original.as_deref(),
        &base_url,
        key,
        model,
        model_limits,
    )?;
    let state = AppliedState {
        target_path: matches!(tool, CliTool::GrokBuild).then(|| path.clone()),
        cline_semantic_hash: if matches!(tool, CliTool::Cline) {
            Some(cline_semantic_hash(&patched)?)
        } else {
            None
        },
        original,
        applied_hash: hash(&patched),
        opencode_jsonc: matches!(tool, CliTool::Opencode | CliTool::Kilo)
            && path.extension().is_some_and(|ext| ext == "jsonc"),
    };
    let saved = serde_json::to_string(&state).map_err(|error| error.to_string())?;
    write_state_file(&state_file, &saved)?;
    if let Err(error) = write_private(&path, &patched) {
        match prior_raw {
            Some(previous) => {
                let _ = write_state_file(&state_file, &previous);
            }
            None => {
                let _ = fs::remove_file(&state_file);
            }
        }
        return Err(error);
    }
    Ok(CliSetupStatus {
        applied: true,
        conflict: false,
        config_path: path.display().to_string(),
    })
}

fn reset_at(home: &Path, data_dir: &Path, tool: CliTool) -> Result<CliSetupStatus, String> {
    if matches!(tool, CliTool::GeminiCli) {
        return reset_gemini_at(home, data_dir);
    }
    if matches!(tool, CliTool::Pi) {
        return reset_pi_at(home, data_dir);
    }
    let path = config_path(home, data_dir, tool)?;
    let state_file = state_path(data_dir, tool);
    let Some(raw) = read_state_file(&state_file)? else {
        return Ok(CliSetupStatus {
            applied: false,
            conflict: false,
            config_path: path.display().to_string(),
        });
    };
    let state: AppliedState = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let current = read_regular_file(&path)?;
    if current == state.original {
        fs::remove_file(&state_file).map_err(|error| error.to_string())?;
        return Ok(CliSetupStatus {
            applied: false,
            conflict: false,
            config_path: path.display().to_string(),
        });
    }
    if !current
        .as_deref()
        .is_some_and(|value| matches_applied(value, &state))
    {
        return Err(
            "CLI config changed after Ryu applied it; Reset will not overwrite those edits"
                .to_owned(),
        );
    }
    match state.original {
        Some(original) => write_private(&path, &original)?,
        None => {
            if path.exists() {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
        }
    }
    fs::remove_file(&state_file).map_err(|error| error.to_string())?;
    Ok(CliSetupStatus {
        applied: false,
        conflict: false,
        config_path: path.display().to_string(),
    })
}

fn status_at(home: &Path, data_dir: &Path, tool: CliTool) -> Result<CliSetupStatus, String> {
    if matches!(tool, CliTool::Pi) {
        let path = tool.config_path(home);
        let Some(raw) = read_state_file(&state_path(data_dir, tool))? else {
            return Ok(CliSetupStatus {
                applied: false,
                conflict: false,
                config_path: path.display().to_string(),
            });
        };
        let state: PiAppliedState =
            serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let applied = read_regular_file(&path)?
            .as_deref()
            .is_some_and(|contents| hash(contents) == state.settings.applied_hash)
            && read_regular_file(&path.with_file_name("models.json"))?
                .as_deref()
                .is_some_and(|contents| hash(contents) == state.models.applied_hash);
        return Ok(CliSetupStatus {
            applied,
            conflict: !applied,
            config_path: path.display().to_string(),
        });
    }
    if matches!(tool, CliTool::GeminiCli) {
        let path = tool.config_path(home);
        let Some(raw) = read_state_file(&state_path(data_dir, tool))? else {
            return Ok(CliSetupStatus {
                applied: false,
                conflict: false,
                config_path: path.display().to_string(),
            });
        };
        let state: GeminiAppliedState =
            serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let applied = read_regular_file(&path)?
            .as_deref()
            .is_some_and(|contents| hash(contents) == state.settings.applied_hash)
            && read_regular_file(&path.with_file_name(".env"))?
                .as_deref()
                .is_some_and(|contents| hash(contents) == state.environment.applied_hash);
        return Ok(CliSetupStatus {
            applied,
            conflict: !applied,
            config_path: path.display().to_string(),
        });
    }
    let path = config_path(home, data_dir, tool)?;
    let Some(raw) = read_state_file(&state_path(data_dir, tool))? else {
        return Ok(CliSetupStatus {
            applied: false,
            conflict: false,
            config_path: path.display().to_string(),
        });
    };
    let state: AppliedState = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let applied = read_regular_file(&path)?
        .as_deref()
        .is_some_and(|value| matches_applied(value, &state));
    Ok(CliSetupStatus {
        applied,
        conflict: !applied,
        config_path: path.display().to_string(),
    })
}

#[tauri::command]
pub async fn apply_gateway_cli_setup(
    tool: CliTool,
    gateway_url: String,
    api_key: String,
    model: String,
    model_limits: Option<CliModelLimits>,
) -> Result<CliSetupStatus, String> {
    let home = dirs::home_dir().ok_or("Cannot find the user home directory")?;
    let data_dir = crate::profile::ryu_home_dir();
    let grok_home = std::env::var_os("GROK_HOME");
    tokio::task::spawn_blocking(move || {
        let _guard = CLI_SETUP_LOCK
            .lock()
            .map_err(|_| "CLI setup lock is unavailable".to_owned())?;
        if matches!(tool, CliTool::GrokBuild) {
            apply_at_with_grok_home(
                &home,
                &data_dir,
                tool,
                &gateway_url,
                &api_key,
                &model,
                model_limits,
                grok_home.as_deref(),
            )
        } else {
            apply_at(
                &home,
                &data_dir,
                tool,
                &gateway_url,
                &api_key,
                &model,
                model_limits,
            )
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn reset_gateway_cli_setup(tool: CliTool) -> Result<CliSetupStatus, String> {
    let home = dirs::home_dir().ok_or("Cannot find the user home directory")?;
    let data_dir = crate::profile::ryu_home_dir();
    let grok_home = std::env::var_os("GROK_HOME");
    tokio::task::spawn_blocking(move || {
        let _guard = CLI_SETUP_LOCK
            .lock()
            .map_err(|_| "CLI setup lock is unavailable".to_owned())?;
        let had_snapshot = read_state_file(&state_path(&data_dir, tool))?.is_some();
        let mut status = reset_at(&home, &data_dir, tool)?;
        if matches!(tool, CliTool::GrokBuild) && !had_snapshot {
            status.config_path = grok_config_path(&home, grok_home.as_deref())?
                .display()
                .to_string();
        }
        Ok(status)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gateway_cli_setup_status(tool: CliTool) -> Result<CliSetupStatus, String> {
    let home = dirs::home_dir().ok_or("Cannot find the user home directory")?;
    let data_dir = crate::profile::ryu_home_dir();
    let grok_home = std::env::var_os("GROK_HOME");
    tokio::task::spawn_blocking(move || {
        let _guard = CLI_SETUP_LOCK
            .lock()
            .map_err(|_| "CLI setup lock is unavailable".to_owned())?;
        if let Err(error) = reseal_legacy_snapshots(&data_dir) {
            tracing::warn!("cli setup: could not reseal legacy snapshots: {error}");
        }
        let mut status = status_at(&home, &data_dir, tool)?;
        if matches!(tool, CliTool::GrokBuild) && !state_path(&data_dir, tool).exists() {
            status.config_path = grok_config_path(&home, grok_home.as_deref())?
                .display()
                .to_string();
        }
        Ok(status)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn assert_owner_system_acl(path: &Path) {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{LocalFree, HANDLE, HLOCAL};
        use windows::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
        use windows::Win32::Security::{
            EqualSid, GetAce, GetSecurityDescriptorControl, WinLocalSystemSid, ACCESS_ALLOWED_ACE,
            ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
            SE_DACL_PROTECTED,
        };
        use windows::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
        struct Descriptor(PSECURITY_DESCRIPTOR);
        impl Drop for Descriptor {
            fn drop(&mut self) {
                unsafe {
                    let _ = LocalFree(Some(HLOCAL(self.0 .0)));
                }
            }
        }
        let file = fs::File::open(path).unwrap();
        let mut owner = PSID::default();
        let mut acl = std::ptr::null_mut::<ACL>();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            GetSecurityInfo(
                HANDLE(file.as_raw_handle()),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                Some(&mut owner),
                None,
                Some(&mut acl),
                None,
                Some(&mut descriptor),
            )
        }
        .ok()
        .unwrap();
        let descriptor = Descriptor(descriptor);
        let owner_buffer = windows_private_file::current_user().unwrap();
        let expected_owner = windows_private_file::user_sid(&owner_buffer);
        let system_buffer = windows_private_file::well_known(WinLocalSystemSid).unwrap();
        let expected_system = windows_private_file::sid(&system_buffer);
        assert!(unsafe { EqualSid(owner, expected_owner) }.is_ok());
        let mut control = 0;
        let mut revision = 0;
        unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) }.unwrap();
        assert_ne!(control & SE_DACL_PROTECTED.0, 0);
        assert!(!acl.is_null());
        assert_eq!(unsafe { (*acl).AceCount }, 2);
        let mut found_owner = false;
        let mut found_system = false;
        for index in 0..2 {
            let mut raw = std::ptr::null_mut();
            unsafe { GetAce(acl, index, &mut raw) }.unwrap();
            let ace = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
            assert_eq!(ace.Header.AceType, 0); // ACCESS_ALLOWED_ACE_TYPE
            assert_eq!(ace.Header.AceFlags, 0); // Explicit, no inherited ACE.
            assert_eq!(ace.Mask, FILE_ALL_ACCESS.0);
            let sid = PSID((&ace.SidStart as *const u32).cast_mut().cast());
            let is_owner = unsafe { EqualSid(sid, expected_owner) }.is_ok();
            let is_system = unsafe { EqualSid(sid, expected_system) }.is_ok();
            assert!(
                is_owner || is_system,
                "Unexpected principal on private file"
            );
            found_owner |= is_owner;
            found_system |= is_system;
        }
        assert!(found_owner && found_system);
        // Real owner read, not a function-call or permission-mode proxy.
        assert!(fs::read(path).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn roo_windows_apply_snapshot_reset_override_broad_inherited_directory_acl() {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Security::Authorization::{SetSecurityInfo, SE_FILE_OBJECT};
        use windows::Win32::Security::{
            WinAuthenticatedUserSid, WinBuiltinUsersSid, WinLocalSystemSid, WinWorldSid, ACE_FLAGS,
            ACL, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        };
        use windows::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, READ_CONTROL, WRITE_DAC,
        };
        let temp = tempfile::tempdir().unwrap();
        let owner_buffer = windows_private_file::current_user().unwrap();
        let owner = windows_private_file::user_sid(&owner_buffer);
        let buffers: Vec<_> = [
            WinLocalSystemSid,
            WinWorldSid,
            WinAuthenticatedUserSid,
            WinBuiltinUsersSid,
        ]
        .into_iter()
        .map(|kind| windows_private_file::well_known(kind).unwrap())
        .collect();
        let mut sids = vec![owner];
        sids.extend(
            buffers
                .iter()
                .map(|buffer| windows_private_file::sid(buffer)),
        );
        let broad_acl = windows_private_file::acl(&sids, ACE_FLAGS(3)).unwrap(); // OBJECT + CONTAINER inheritance.
        let directory = fs::OpenOptions::new()
            .access_mode(READ_CONTROL.0 | WRITE_DAC.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(temp.path())
            .unwrap();
        unsafe {
            SetSecurityInfo(
                HANDLE(directory.as_raw_handle()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(broad_acl.as_ptr().cast::<ACL>()),
                None,
            )
        }
        .ok()
        .unwrap();
        let data = temp.path().join("data");
        let path = config_path(temp.path(), &data, CliTool::RooCode).unwrap();
        let original = "{\n  \"originalExport\": true\n}\n";
        fs::write(&path, original).unwrap(); // Deliberately broad inherited original.
        apply_at(
            temp.path(),
            &data,
            CliTool::RooCode,
            "https://gateway.example",
            PARITY_KEY,
            "chosen",
            None,
        )
        .unwrap();
        assert_owner_system_acl(&path);
        assert_owner_system_acl(&state_path(&data, CliTool::RooCode));
        reset_at(temp.path(), &data, CliTool::RooCode).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert_owner_system_acl(&path); // Restore bytes, never the insecure ACL.
        assert!(!state_path(&data, CliTool::RooCode).exists());
        apply_at(
            temp.path(),
            &data,
            CliTool::RooCode,
            "https://gateway.example",
            PARITY_KEY,
            "chosen",
            None,
        )
        .unwrap();
        write_private(&path, "{\"userEdited\":true}").unwrap();
        assert!(reset_at(temp.path(), &data, CliTool::RooCode).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"userEdited\":true}");
        assert_owner_system_acl(&path);
    }

    #[test]
    fn private_security_failure_never_writes_secret_or_replaces_original() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("original.json");
        fs::write(&path, "original bytes").unwrap();
        let result = write_private_with_security(&path, PARITY_KEY, |file| {
            assert_eq!(file.metadata().unwrap().len(), 0);
            #[cfg(windows)]
            {
                use windows::Win32::Foundation::HANDLE;
                use windows::Win32::Security::Authorization::{SetSecurityInfo, SE_FILE_OBJECT};
                use windows::Win32::Security::DACL_SECURITY_INFORMATION;
                // An actual Windows API failure, propagated through the empty-temp constructor.
                return unsafe {
                    SetSecurityInfo(
                        HANDLE::default(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        None,
                        None,
                        None,
                        None,
                    )
                }
                .ok()
                .map_err(|error| error.to_string());
            }
            #[cfg(not(windows))]
            Err("security fixture failure".into())
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original bytes");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1); // Empty temp was removed.
    }

    #[cfg(windows)]
    #[test]
    fn roo_windows_modify_only_parent_needs_no_initial_write_owner_right() {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Security::Authorization::{SetSecurityInfo, SE_FILE_OBJECT};
        use windows::Win32::Security::{
            WinLocalSystemSid, ACE_FLAGS, ACL, DACL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION,
        };
        use windows::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, READ_CONTROL, WRITE_DAC,
        };
        let temp = tempfile::tempdir().unwrap();
        let owner_buffer = windows_private_file::current_user().unwrap();
        let system_buffer = windows_private_file::well_known(WinLocalSystemSid).unwrap();
        // Windows Modify: read/write/execute, read-control, synchronize and delete.
        // Crucially excludes both WRITE_DAC and WRITE_OWNER from inherited file grants.
        let modify = 0x0013_01bf;
        let normal_acl = windows_private_file::acl_with_access(
            &[
                windows_private_file::user_sid(&owner_buffer),
                windows_private_file::sid(&system_buffer),
            ],
            ACE_FLAGS(3),
            modify,
        )
        .unwrap();
        let directory = fs::OpenOptions::new()
            .access_mode(READ_CONTROL.0 | WRITE_DAC.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(temp.path())
            .unwrap();
        unsafe {
            SetSecurityInfo(
                HANDLE(directory.as_raw_handle()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(normal_acl.as_ptr().cast::<ACL>()),
                None,
            )
        }
        .ok()
        .unwrap();
        let data = temp.path().join("data");
        let path = config_path(temp.path(), &data, CliTool::RooCode).unwrap();
        let original = "{\n\"original\":\"nonempty\"\n}\n";
        fs::write(&path, original).unwrap();
        apply_at(
            temp.path(),
            &data,
            CliTool::RooCode,
            "https://gateway.example",
            PARITY_KEY,
            "chosen",
            None,
        )
        .unwrap();
        assert_owner_system_acl(&path);
        assert_owner_system_acl(&state_path(&data, CliTool::RooCode));
        reset_at(temp.path(), &data, CliTool::RooCode).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert_owner_system_acl(&path);
    }

    const PARITY_KEY: &str = "gwclient_parity_fixture_12345678901234567890";

    #[test]
    fn grok_native_responses_fields_preserve_comments_and_restore_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let data = temp.path().join("data");
        let path = CliTool::GrokBuild.config_path(&home);
        let original = "# keep this comment\n[models]\ndefault = 'old' # keep default note\n[model.old]\nmodel = 'existing'\n[ui]\ntheme = 'dark'\n";
        write_private(&path, original).unwrap();
        apply_at(
            &home,
            &data,
            CliTool::GrokBuild,
            "http://127.0.0.1:7981",
            PARITY_KEY,
            "pool:balanced",
            Some(CliModelLimits {
                context_tokens: 131072,
                output_tokens: 8192,
            }),
        )
        .unwrap();
        let contents = fs::read_to_string(&path).unwrap();
        let config: DocumentMut = contents.parse().unwrap();
        assert!(contents.contains("# keep this comment"));
        assert!(contents.contains("# keep default note"));
        assert_eq!(config["models"]["default"].as_str(), Some("ryu"));
        assert_eq!(config["model"]["old"]["model"].as_str(), Some("existing"));
        assert_eq!(
            config["model"]["ryu"]["model"].as_str(),
            Some("pool:balanced")
        );
        assert_eq!(
            config["model"]["ryu"]["api_backend"].as_str(),
            Some("responses")
        );
        assert_eq!(config["model"]["ryu"]["api_key"].as_str(), Some(PARITY_KEY));
        assert_eq!(
            config["model"]["ryu"]["base_url"].as_str(),
            Some("http://127.0.0.1:7981/v1")
        );
        assert_eq!(
            config["model"]["ryu"]["context_window"].as_integer(),
            Some(131072)
        );
        reset_at(&home, &data, CliTool::GrokBuild).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn grok_refuses_foreign_alias_and_later_edits_without_exposing_keys() {
        assert!(patched_grok(
            Some("[model.ryu]\nmodel='foreign'\n"),
            "https://gateway.example",
            PARITY_KEY,
            "chosen",
            None
        )
        .is_err());
        assert!(patched_grok(
            Some("models = []"),
            "https://gateway.example",
            PARITY_KEY,
            "chosen",
            None
        )
        .is_err());
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::GrokBuild.config_path(temp.path());
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::GrokBuild,
            "https://gateway.example",
            PARITY_KEY,
            "chosen",
            None,
        )
        .unwrap();
        let edited = format!("{}\n# user edit\n", fs::read_to_string(&path).unwrap());
        write_private(&path, &edited).unwrap();
        let error = reset_at(temp.path(), temp.path(), CliTool::GrokBuild)
            .err()
            .unwrap();
        assert!(!error.contains(PARITY_KEY));
        assert_eq!(fs::read_to_string(path).unwrap(), edited);
    }

    #[test]
    fn grok_home_override_and_snapshot_target_are_stable() {
        let temp = tempfile::tempdir().unwrap();
        let override_dir = temp.path().join("custom");
        assert_eq!(
            grok_config_path(temp.path(), Some(override_dir.as_os_str())).unwrap(),
            override_dir.join("config.toml")
        );
        assert!(grok_config_path(temp.path(), Some(std::ffi::OsStr::new("relative"))).is_err());
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::GrokBuild,
            "https://gateway.example",
            PARITY_KEY,
            "chosen",
            None,
        )
        .unwrap();
        let state: AppliedState = serde_json::from_str(
            &fs::read_to_string(state_path(temp.path(), CliTool::GrokBuild)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            state.target_path,
            Some(temp.path().join(".grok/config.toml"))
        );
        reset_at(temp.path(), temp.path(), CliTool::GrokBuild).unwrap();
        apply_at_with_grok_home(
            temp.path(),
            temp.path(),
            CliTool::GrokBuild,
            "https://gateway.example",
            PARITY_KEY,
            "custom-model",
            None,
            Some(override_dir.as_os_str()),
        )
        .unwrap();
        assert!(override_dir.join("config.toml").is_file());
        assert_eq!(
            config_path(temp.path(), temp.path(), CliTool::GrokBuild).unwrap(),
            override_dir.join("config.toml")
        );
        reset_at(temp.path(), temp.path(), CliTool::GrokBuild).unwrap();
        assert!(!override_dir.join("config.toml").exists());
    }

    #[test]
    fn roo_exports_importer_contract_restores_bytes_and_never_mutates_cli_state() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let data = temp.path().join("data");
        let cli = home.join(".roo/cli-settings.json");
        write_private(&cli, "{\"provider\":\"xai\"}\n").unwrap();
        let path = config_path(&home, &data, CliTool::RooCode).unwrap();
        let original = "{\n  \"previousExport\": true\n}\n";
        write_private(&path, original).unwrap();
        let status = apply_at(
            &home,
            &data,
            CliTool::RooCode,
            "https://gateway.example",
            PARITY_KEY,
            "chosen",
            None,
        )
        .unwrap();
        assert!(status.applied);
        assert!(!serde_json::to_string(&status).unwrap().contains(PARITY_KEY));
        let export: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let profile = &export["providerProfiles"]["apiConfigs"]["Ryu Gateway"];
        assert_eq!(
            export["providerProfiles"]["currentApiConfigName"],
            "Ryu Gateway"
        );
        assert_eq!(profile["id"], "ryu-gateway");
        assert_eq!(profile["apiProvider"], "openai");
        assert_eq!(profile["openAiApiKey"], PARITY_KEY);
        assert_eq!(profile["openAiBaseUrl"], "https://gateway.example/v1");
        assert_eq!(profile["openAiModelId"], "chosen");
        assert_eq!(export["globalSettings"], serde_json::json!({}));
        reset_at(&home, &data, CliTool::RooCode).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
        assert_eq!(fs::read_to_string(cli).unwrap(), "{\"provider\":\"xai\"}\n");
    }

    #[test]
    fn roo_refuses_later_artifact_edits_and_enforces_private_size_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let path = config_path(temp.path(), temp.path(), CliTool::RooCode).unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::RooCode,
            "https://gateway.example",
            PARITY_KEY,
            "chosen",
            None,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        write_private(&path, "{\"userEdited\": true}").unwrap();
        assert!(reset_at(temp.path(), temp.path(), CliTool::RooCode).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"userEdited\": true}");
        assert!(write_private(&path, &"x".repeat(1024 * 1024 + 1)).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "{\"userEdited\": true}");
    }

    #[test]
    fn iflow_switches_to_compatible_auth_and_restores_original_settings() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Iflow.config_path(temp.path());
        let original = r#"{"selectedAuthType":"iflow","apiKey":"old-key","modelName":"old-model","baseUrl":"https://apis.iflow.cn/v1","vimMode":true,"autoAccept":false,"mcpServers":{"example":{"command":"example"}}}"#;
        write_private(&path, original).unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::Iflow,
            "http://127.0.0.1:7981",
            "gwclient_proof_only_12345678901234567890",
            "proof-model",
            None,
        )
        .unwrap();
        let current: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(current["selectedAuthType"], "openai-compatible");
        assert_eq!(current["baseUrl"], "http://127.0.0.1:7981/v1");
        assert_eq!(current["modelName"], "proof-model");
        assert_eq!(
            current["apiKey"],
            "gwclient_proof_only_12345678901234567890"
        );
        assert_eq!(current["vimMode"], true);
        assert_eq!(current["autoAccept"], false);
        assert_eq!(current["mcpServers"]["example"]["command"], "example");
        reset_at(temp.path(), temp.path(), CliTool::Iflow).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn iflow_reset_preserves_later_edits_and_rejects_non_object_settings() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Iflow.config_path(temp.path());
        write_private(&path, "[]").unwrap();
        assert!(apply_at(
            temp.path(),
            temp.path(),
            CliTool::Iflow,
            "http://127.0.0.1:7981",
            "gwclient_proof_only_12345678901234567890",
            "proof-model",
            None
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "[]");
        write_private(&path, "{}").unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::Iflow,
            "http://127.0.0.1:7981",
            "gwclient_proof_only_12345678901234567890",
            "proof-model",
            None,
        )
        .unwrap();
        let mut current: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        current["vimMode"] = true.into();
        let edited = serde_json::to_string_pretty(&current).unwrap();
        write_private(&path, &edited).unwrap();
        assert!(reset_at(temp.path(), temp.path(), CliTool::Iflow).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), edited);
    }

    #[test]
    fn qwen_preserves_other_providers_and_restores_original_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::QwenCode.config_path(temp.path());
        let original = r#"{"ui":{"theme":"dark"},"env":{"OTHER_KEY":"existing"},"security":{"auth":{"selectedType":"anthropic"}},"model":{"name":"old"},"modelProviders":{"openai":[{"id":"other-model","envKey":"OTHER_KEY","baseUrl":"https://example.com/v1"}],"anthropic":[{"id":"claude","envKey":"OTHER_KEY"}]}}"#;
        write_private(&path, original).unwrap();
        for model in ["proof-model", "pool:balanced"] {
            apply_at(
                temp.path(),
                temp.path(),
                CliTool::QwenCode,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                model,
                None,
            )
            .unwrap();
            let config: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(config["ui"]["theme"], "dark");
            assert_eq!(config["security"]["auth"]["selectedType"], "openai");
            assert_eq!(config["model"]["name"], model);
            assert_eq!(config["modelProviders"]["openai"][0]["id"], "other-model");
            assert_eq!(config["modelProviders"]["openai"][1]["id"], model);
            assert_eq!(
                config["modelProviders"]["openai"][1]["baseUrl"],
                "http://127.0.0.1:7981/v1"
            );
            assert_eq!(config["modelProviders"]["anthropic"][0]["id"], "claude");
            assert_eq!(config["env"]["OTHER_KEY"], "existing");
        }
        reset_at(temp.path(), temp.path(), CliTool::QwenCode).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn qwen_rejects_collisions_and_preserves_later_edits() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::QwenCode.config_path(temp.path());
        for original in [
            "[]",
            r#"{"env":{"RYU_GATEWAY_API_KEY":"existing"}}"#,
            r#"{"modelProviders":{"openai":[{"id":"proof-model"}]}}"#,
        ] {
            write_private(&path, original).unwrap();
            assert!(apply_at(
                temp.path(),
                temp.path(),
                CliTool::QwenCode,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                "proof-model",
                None
            )
            .is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
        }
        write_private(&path, "{}").unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::QwenCode,
            "http://127.0.0.1:7981",
            "gwclient_proof_only_12345678901234567890",
            "proof-model",
            None,
        )
        .unwrap();
        let mut config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        config["ui"] = serde_json::json!({"theme":"dark"});
        let edited = serde_json::to_string_pretty(&config).unwrap();
        write_private(&path, &edited).unwrap();
        assert!(reset_at(temp.path(), temp.path(), CliTool::QwenCode).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), edited);
    }

    #[test]
    fn cline_switches_current_provider_settings_and_restores_original_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Cline.config_path(temp.path());
        let original = r#"{"version":1,"modes":{},"lastUsedProvider":"cline","providers":{"cline":{"settings":{"provider":"cline","apiKey":"other-key"},"updatedAt":"2026-01-01T00:00:00Z","tokenSource":"manual"},"openai-compatible":{"settings":{"provider":"openai-compatible","model":"old","temperature":0.3,"apiKey":"old-key"},"updatedAt":"2026-01-01T00:00:00Z","tokenSource":"manual"}}}"#;
        write_private(&path, original).unwrap();
        for model in ["proof-model", "pool:balanced"] {
            apply_at(
                temp.path(),
                temp.path(),
                CliTool::Cline,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                model,
                None,
            )
            .unwrap();
            let config: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(config["lastUsedProvider"], "openai-compatible");
            assert!(config["providers"]["openai-compatible"]["updatedAt"]
                .as_str()
                .unwrap()
                .ends_with('Z'));
            assert_eq!(
                config["providers"]["openai-compatible"]["settings"]["baseUrl"],
                "http://127.0.0.1:7981/v1"
            );
            assert_eq!(
                config["providers"]["openai-compatible"]["settings"]["model"],
                model
            );
            assert_eq!(
                config["providers"]["openai-compatible"]["settings"]["temperature"],
                0.3
            );
            assert_eq!(
                config["providers"]["cline"]["settings"]["apiKey"],
                "other-key"
            );
        }
        reset_at(temp.path(), temp.path(), CliTool::Cline).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn cline_rejects_unsupported_settings_and_user_edits() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Cline.config_path(temp.path());
        for original in [
            "{\"version\":2}",
            "{\"version\":1,\"providers\":[]}",
            "invalid",
        ] {
            write_private(&path, original).unwrap();
            assert!(apply_at(
                temp.path(),
                temp.path(),
                CliTool::Cline,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                "m",
                None
            )
            .is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
        }
        fs::remove_file(&path).unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::Cline,
            "http://127.0.0.1:7981",
            "gwclient_proof_only_12345678901234567890",
            "m",
            None,
        )
        .unwrap();
        write_private(&path, "{\"version\":1,\"providers\":{}}").unwrap();
        assert!(reset_at(temp.path(), temp.path(), CliTool::Cline).is_err());
    }

    #[test]
    fn cline_timestamp_refresh_is_metadata_but_credentials_and_settings_remain_guarded() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Cline.config_path(temp.path());
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::Cline,
            "http://127.0.0.1:7981",
            "gwclient_proof_only_12345678901234567890",
            "m",
            None,
        )
        .unwrap();
        let mut config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        config["providers"]["openai-compatible"]["updatedAt"] = "2026-10-02T00:00:00.000Z".into();
        write_private(&path, &serde_json::to_string(&config).unwrap()).unwrap();
        assert!(
            status_at(temp.path(), temp.path(), CliTool::Cline)
                .unwrap()
                .applied
        );
        for field in ["apiKey", "model", "baseUrl"] {
            let mut changed = config.clone();
            changed["providers"]["openai-compatible"]["settings"][field] = "user change".into();
            write_private(&path, &serde_json::to_string(&changed).unwrap()).unwrap();
            assert!(
                status_at(temp.path(), temp.path(), CliTool::Cline)
                    .unwrap()
                    .conflict
            );
            assert!(reset_at(temp.path(), temp.path(), CliTool::Cline).is_err());
        }
        let mut missing = config.clone();
        missing["providers"]["openai-compatible"]
            .as_object_mut()
            .unwrap()
            .remove("updatedAt");
        write_private(&path, &serde_json::to_string(&missing).unwrap()).unwrap();
        assert!(reset_at(temp.path(), temp.path(), CliTool::Cline).is_err());
        write_private(&path, &serde_json::to_string(&config).unwrap()).unwrap();
        reset_at(temp.path(), temp.path(), CliTool::Cline).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn kilo_jsonc_apply_reapply_and_reset_keep_comments_and_other_settings() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Kilo
            .config_path(temp.path())
            .with_extension("jsonc");
        let original = "{ // user comment\n\"model\":\"other/m\",\"provider\":{\"other\":{\"models\":{\"m\":{}}}},\"permission\":{\"edit\":\"ask\"}}";
        write_private(&path, original).unwrap();
        let limits = Some(CliModelLimits {
            context_tokens: 32768,
            output_tokens: 4096,
        });
        for model in ["openai/gpt-4o-mini", "pool:balanced"] {
            apply_at(
                temp.path(),
                temp.path(),
                CliTool::Kilo,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                model,
                limits,
            )
            .unwrap();
            let applied = fs::read_to_string(&path).unwrap();
            assert!(applied.contains("// user comment"));
            let config: serde_json::Value =
                jsonc_parser::parse_to_serde_value(&applied, &Default::default())
                    .unwrap()
                    .unwrap();
            assert_eq!(config["model"], format!("ryu-gateway/{model}"));
            assert_eq!(
                config["provider"]["ryu-gateway"]["options"]["baseURL"],
                "http://127.0.0.1:7981/v1"
            );
            assert_eq!(
                config["provider"]["ryu-gateway"]["models"][model]["limit"]["context"],
                32768
            );
            assert_eq!(
                config["provider"]["ryu-gateway"]["models"][model]["limit"]["output"],
                4096
            );
            assert_eq!(config["permission"]["edit"], "ask");
            assert!(config["provider"].get("other").is_some());
            assert!(
                status_at(temp.path(), temp.path(), CliTool::Kilo)
                    .unwrap()
                    .applied
            );
        }
        // A later JSON file must not redirect Reset away from the JSONC file Apply chose.
        write_private(&CliTool::Kilo.config_path(temp.path()), "{}").unwrap();
        reset_at(temp.path(), temp.path(), CliTool::Kilo).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn kilo_requires_valid_limits_and_refuses_provider_collisions() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Kilo.config_path(temp.path());
        for limits in [
            None,
            Some(CliModelLimits {
                context_tokens: 0,
                output_tokens: 1,
            }),
            Some(CliModelLimits {
                context_tokens: 10,
                output_tokens: 11,
            }),
        ] {
            assert!(apply_at(
                temp.path(),
                temp.path(),
                CliTool::Kilo,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                "m",
                limits
            )
            .is_err());
            assert!(!path.exists());
        }
        let original = "{\"provider\":{\"ryu-gateway\":{\"name\":\"User entry\"}}}";
        write_private(&path, original).unwrap();
        assert!(apply_at(
            temp.path(),
            temp.path(),
            CliTool::Kilo,
            "http://127.0.0.1:7981",
            "gwclient_proof_only_12345678901234567890",
            "m",
            Some(CliModelLimits {
                context_tokens: 10,
                output_tokens: 1
            })
        )
        .is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn kilo_reset_refuses_later_edits_and_old_jsonc_state_still_reads() {
        let temp = tempfile::tempdir().unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::Kilo,
            "http://127.0.0.1:7981",
            "gwclient_proof_only_12345678901234567890",
            "m",
            Some(CliModelLimits {
                context_tokens: 100,
                output_tokens: 10,
            }),
        )
        .unwrap();
        let path = CliTool::Kilo.config_path(temp.path());
        let later = "{\"model\":\"user/change\"}";
        write_private(&path, later).unwrap();
        assert!(reset_at(temp.path(), temp.path(), CliTool::Kilo).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), later);
        let old: AppliedState =
            serde_json::from_str(r#"{"original":null,"applied_hash":"h","opencode_jsonc":true}"#)
                .unwrap();
        assert!(old.opencode_jsonc);
    }

    #[test]
    fn continue_apply_reapply_and_reset_preserve_other_models_and_rules() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Continue.config_path(temp.path());
        let original = "# project defaults\nname: My Config\nversion: 2.0.0\nschema: v1\nmodels:\n  - name: Embeddings\n    provider: openai\n    model: text-embedding-3-small\n    roles: [embed]\n  - uses: anthropic/claude-sonnet\nrules: [Keep tests]\nmcpServers: []\n";
        write_private(&path, original).unwrap();
        for model in ["openai/gpt-4o-mini", "pool:balanced"] {
            apply_at(
                temp.path(),
                temp.path(),
                CliTool::Continue,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                model,
                None,
            )
            .unwrap();
            let config: serde_yaml::Value =
                serde_yaml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(config["name"], "My Config");
            assert_eq!(config["version"], "2.0.0");
            assert_eq!(config["models"][0]["name"], "Ryu Gateway");
            assert_eq!(config["models"][0]["model"], model);
            assert_eq!(config["models"][0]["apiBase"], "http://127.0.0.1:7981/v1");
            assert_eq!(config["models"][0]["capabilities"][0], "tool_use");
            assert_eq!(config["models"][1]["roles"][0], "embed");
            assert_eq!(config["models"][2]["uses"], "anthropic/claude-sonnet");
            assert_eq!(config["rules"][0], "Keep tests");
            assert!(
                status_at(temp.path(), temp.path(), CliTool::Continue)
                    .unwrap()
                    .applied
            );
        }
        reset_at(temp.path(), temp.path(), CliTool::Continue).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn continue_rejects_collisions_unsupported_schema_and_later_edits() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Continue.config_path(temp.path());
        for original in [
            "schema: v2\n",
            "models: {}\n",
            "models: [{name: Ryu Gateway}]\n",
            "name: 1\n",
            "!!invalid",
        ] {
            write_private(&path, original).unwrap();
            assert!(apply_at(
                temp.path(),
                temp.path(),
                CliTool::Continue,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                "m",
                None
            )
            .is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
        }
        fs::remove_file(&path).unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::Continue,
            "http://127.0.0.1:7981",
            "gwclient_proof_only_12345678901234567890",
            "m",
            None,
        )
        .unwrap();
        let later = fs::read_to_string(&path).unwrap() + "\nrules: [New user rule]\n";
        write_private(&path, &later).unwrap();
        assert!(reset_at(temp.path(), temp.path(), CliTool::Continue).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), later);
    }

    #[test]
    fn continue_bootstraps_and_removes_fresh_config_on_reset() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Continue.config_path(temp.path());
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::Continue,
            "https://gateway.example",
            "gwclient_proof_only_12345678901234567890",
            "pool:balanced",
            None,
        )
        .unwrap();
        let config: serde_yaml::Value =
            serde_yaml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(config["schema"], "v1");
        assert_eq!(config["models"][0]["apiBase"], "https://gateway.example/v1");
        reset_at(temp.path(), temp.path(), CliTool::Continue).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn openclaw_apply_reapply_and_reset_preserve_models_and_original_json5() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Openclaw.config_path(temp.path());
        let original = r#"{ // user comment
            models: {providers: {existing: {baseUrl: 'https://example.com/v1', models: []}}},
            agents: {defaults: {model: {primary: 'existing/m', fallbacks: ['existing/backup']}, models: {'existing/m': {}}}},
            channels: {telegram: {enabled: false}},
        }"#;
        write_private(&path, original).unwrap();
        for model in ["openai/gpt-4o-mini", "pool:balanced"] {
            apply_at(
                temp.path(),
                temp.path(),
                CliTool::Openclaw,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                model,
                None,
            )
            .unwrap();
            let config: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(
                config["models"]["providers"]["ryu-gateway"]["api"],
                "openai-completions"
            );
            assert_eq!(
                config["models"]["providers"]["ryu-gateway"]["baseUrl"],
                "http://127.0.0.1:7981/v1"
            );
            assert_eq!(
                config["models"]["providers"]["ryu-gateway"]["models"][0]["id"],
                model
            );
            assert_eq!(
                config["agents"]["defaults"]["model"]["primary"],
                format!("ryu-gateway/{model}")
            );
            assert_eq!(
                config["agents"]["defaults"]["model"]["fallbacks"],
                serde_json::json!([])
            );
            assert!(config["agents"]["defaults"]["models"]
                .get(format!("ryu-gateway/{model}"))
                .is_some());
            assert_eq!(
                config["models"]["providers"]["existing"]["baseUrl"],
                "https://example.com/v1"
            );
            assert_eq!(config["channels"]["telegram"]["enabled"], false);
            assert!(
                status_at(temp.path(), temp.path(), CliTool::Openclaw)
                    .unwrap()
                    .applied
            );
        }
        reset_at(temp.path(), temp.path(), CliTool::Openclaw).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn hermes_apply_reapply_and_reset_keep_other_routes_and_settings() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Hermes.config_path(temp.path());
        let original = "# personal settings\nmodel: {provider: openrouter, default: old, temperature: 0.2, api_key: old-provider-key}\nproviders:\n  existing: {api: 'https://example.com/v1', api_key: existing-key}\nauxiliary:\n  vision: {provider: existing, model: vision-model}\ndisplay: {compact: true}\n";
        write_private(&path, original).unwrap();
        for model in ["openai/gpt-4o-mini", "pool:balanced"] {
            apply_at(
                temp.path(),
                temp.path(),
                CliTool::Hermes,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                model,
                None,
            )
            .unwrap();
            let config: serde_yaml::Value =
                serde_yaml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(config["model"]["provider"], "custom:ryu-gateway");
            assert_eq!(config["model"]["default"], model);
            assert_eq!(config["model"]["temperature"], 0.2);
            assert!(config["model"]["api_key"].is_null());
            assert_eq!(
                config["providers"]["ryu-gateway"]["api"],
                "http://127.0.0.1:7981/v1"
            );
            assert_eq!(
                config["providers"]["ryu-gateway"]["session_affinity_header"],
                "x-ryu-session-id"
            );
            assert_eq!(config["providers"]["existing"]["api_key"], "existing-key");
            assert_eq!(config["auxiliary"]["vision"]["model"], "vision-model");
            assert_eq!(config["display"]["compact"], true);
        }
        reset_at(temp.path(), temp.path(), CliTool::Hermes).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn new_cli_tools_refuse_name_collisions_and_later_user_edits() {
        let temp = tempfile::tempdir().unwrap();
        for (tool, original) in [
            (
                CliTool::Openclaw,
                "{models:{providers:{'ryu-gateway':{baseUrl:'https://example.com/v1'}}}}",
            ),
            (
                CliTool::Hermes,
                "providers:\n  ryu-gateway: {api: 'https://example.com/v1'}\n",
            ),
        ] {
            let path = tool.config_path(temp.path());
            write_private(&path, original).unwrap();
            assert!(apply_at(
                temp.path(),
                temp.path(),
                tool,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                "m",
                None
            )
            .is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
            fs::remove_file(&path).unwrap();
            apply_at(
                temp.path(),
                temp.path(),
                tool,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                "m",
                None,
            )
            .unwrap();
            write_private(&path, original).unwrap();
            assert!(status_at(temp.path(), temp.path(), tool).unwrap().conflict);
            assert!(reset_at(temp.path(), temp.path(), tool).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
        }
    }

    #[test]
    fn new_cli_tools_accept_fresh_profiles_and_reject_invalid_shapes_without_writes() {
        for (tool, invalid) in [
            (CliTool::Openclaw, "{models:[]}"),
            (CliTool::Hermes, "model: []\n"),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let path = tool.config_path(temp.path());
            write_private(&path, invalid).unwrap();
            assert!(apply_at(
                temp.path(),
                temp.path(),
                tool,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                "m",
                None
            )
            .is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
            fs::remove_file(&path).unwrap();
            apply_at(
                temp.path(),
                temp.path(),
                tool,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                "pool:balanced",
                None,
            )
            .unwrap();
            reset_at(temp.path(), temp.path(), tool).unwrap();
            assert!(!path.exists());
        }
    }

    #[test]
    fn droid_apply_reapply_and_reset_preserve_original_settings() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Droid.config_path(temp.path());
        let original = r#"{"theme":"dark","customModels":[{"model":"other-model","provider":"generic-chat-completion-api"}]}"#;
        write_private(&path, original).unwrap();

        for model in ["openai/gpt-4o-mini", "pool:balanced"] {
            apply_at(
                temp.path(),
                temp.path(),
                CliTool::Droid,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                model,
                None,
            )
            .unwrap();
            assert!(
                status_at(temp.path(), temp.path(), CliTool::Droid)
                    .unwrap()
                    .applied
            );
            let settings: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(settings["theme"], "dark");
            assert_eq!(settings["model"], format!("custom:{model}"));
            assert_eq!(settings["customModels"].as_array().unwrap().len(), 2);
            assert_eq!(settings["customModels"][0]["model"], "other-model");
            assert_eq!(settings["customModels"][1]["model"], model);
            assert_eq!(
                settings["customModels"][1]["baseUrl"],
                "http://127.0.0.1:7981/v1"
            );
            assert_eq!(
                settings["customModels"][1]["provider"],
                "generic-chat-completion-api"
            );
        }

        reset_at(temp.path(), temp.path(), CliTool::Droid).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn droid_rejects_conflicting_model_and_preserves_later_user_edits() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Droid.config_path(temp.path());
        let original =
            r#"{"customModels":[{"model":"same-model","baseUrl":"https://example.com/v1"}]}"#;
        write_private(&path, original).unwrap();
        assert!(apply_at(
            temp.path(),
            temp.path(),
            CliTool::Droid,
            "http://127.0.0.1:7981",
            "gwclient_proof_only_12345678901234567890",
            "same-model",
            None
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::Droid,
            "http://127.0.0.1:7981",
            "gwclient_proof_only_12345678901234567890",
            "new-model",
            None,
        )
        .unwrap();
        fs::write(&path, r#"{"userEdit":true}"#).unwrap();
        assert!(
            status_at(temp.path(), temp.path(), CliTool::Droid)
                .unwrap()
                .conflict
        );
        assert!(reset_at(temp.path(), temp.path(), CliTool::Droid).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), r#"{"userEdit":true}"#);
    }

    #[test]
    fn pi_apply_reapply_and_reset_preserve_both_original_files() {
        let temp = tempfile::tempdir().unwrap();
        let settings = CliTool::Pi.config_path(temp.path());
        let models = settings.with_file_name("models.json");
        let original_settings = r#"{"defaultProvider":"anthropic","theme":"dark"}"#;
        let original_models = r#"{"providers":{"local":{"baseUrl":"http://localhost:8000/v1","api":"openai-completions","models":[{"id":"local-model"}]}}}"#;
        write_private(&settings, original_settings).unwrap();
        write_private(&models, original_models).unwrap();
        for model in ["openai/gpt-4o-mini", "pool:balanced"] {
            apply_at(
                temp.path(),
                temp.path(),
                CliTool::Pi,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                model,
                None,
            )
            .unwrap();
            assert!(
                status_at(temp.path(), temp.path(), CliTool::Pi)
                    .unwrap()
                    .applied
            );
            let settings_value: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
            let models_value: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&models).unwrap()).unwrap();
            assert_eq!(settings_value["defaultProvider"], "ryu-gateway");
            assert_eq!(settings_value["defaultModel"], model);
            assert_eq!(settings_value["theme"], "dark");
            assert_eq!(
                models_value["providers"]["ryu-gateway"]["api"],
                "openai-responses"
            );
            assert_eq!(
                models_value["providers"]["ryu-gateway"]["baseUrl"],
                "http://127.0.0.1:7981/v1"
            );
            assert_eq!(
                models_value["providers"]["ryu-gateway"]["models"][0]["id"],
                model
            );
            assert_eq!(
                models_value["providers"]["local"]["models"][0]["id"],
                "local-model"
            );
        }
        reset_at(temp.path(), temp.path(), CliTool::Pi).unwrap();
        assert_eq!(fs::read_to_string(settings).unwrap(), original_settings);
        assert_eq!(fs::read_to_string(models).unwrap(), original_models);
    }

    #[test]
    fn pi_reset_refuses_user_edits_to_either_file() {
        let temp = tempfile::tempdir().unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::Pi,
            "http://localhost:7981",
            "gwclient_proof_only_12345678901234567890",
            "openai/gpt-4o-mini",
            None,
        )
        .unwrap();
        let settings = CliTool::Pi.config_path(temp.path());
        let models = settings.with_file_name("models.json");
        let applied_settings = fs::read_to_string(&settings).unwrap();
        fs::write(&models, "{\"userEdit\":true}").unwrap();
        assert!(
            status_at(temp.path(), temp.path(), CliTool::Pi)
                .unwrap()
                .conflict
        );
        assert!(reset_at(temp.path(), temp.path(), CliTool::Pi).is_err());
        assert_eq!(fs::read_to_string(settings).unwrap(), applied_settings);
    }

    #[test]
    fn pi_reset_removes_new_files() {
        let temp = tempfile::tempdir().unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::Pi,
            "http://localhost:7981",
            "gwclient_proof_only_12345678901234567890",
            "openai/gpt-4o-mini",
            None,
        )
        .unwrap();
        let settings = CliTool::Pi.config_path(temp.path());
        reset_at(temp.path(), temp.path(), CliTool::Pi).unwrap();
        assert!(!settings.exists());
        assert!(!settings.with_file_name("models.json").exists());
    }
    #[test]
    fn gemini_apply_reapply_and_reset_restore_both_original_files() {
        let temporary = tempfile::tempdir().unwrap();
        let settings = CliTool::GeminiCli.config_path(temporary.path());
        let environment = settings.with_file_name(".env");
        let original_settings="{ // Keep this comment\n\"security\":{\"auth\":{\"selectedType\":\"oauth-personal\"}},\"general\":{\"vimMode\":true}}";
        let original_environment = "# Keep environment comment\nKEEP=yes\nGEMINI_API_KEY=old-key\n";
        write_private(&settings, original_settings).unwrap();
        write_private(&environment, original_environment).unwrap();
        for model in ["gemini-2.5-flash", "gemini-3-flash-preview"] {
            apply_at(
                temporary.path(),
                temporary.path(),
                CliTool::GeminiCli,
                "http://127.0.0.1:7981",
                "gwclient_proof_only_12345678901234567890",
                model,
                None,
            )
            .unwrap();
            assert!(
                status_at(temporary.path(), temporary.path(), CliTool::GeminiCli)
                    .unwrap()
                    .applied
            );
            let value = jsonc_parser::parse_to_serde_value(
                &fs::read_to_string(&settings).unwrap(),
                &Default::default(),
            )
            .unwrap()
            .unwrap();
            assert_eq!(value["security"]["auth"]["selectedType"], "gemini-api-key");
            assert_eq!(value["model"]["name"], model);
            assert_eq!(value["general"]["vimMode"], true);
            let applied = fs::read_to_string(&environment).unwrap();
            assert!(applied.contains("KEEP=yes"));
            assert!(applied.contains("GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:7981"));
            assert!(!applied.contains("old-key"));
        }
        reset_at(temporary.path(), temporary.path(), CliTool::GeminiCli).unwrap();
        assert_eq!(fs::read_to_string(settings).unwrap(), original_settings);
        assert_eq!(
            fs::read_to_string(environment).unwrap(),
            original_environment
        );
    }

    #[test]
    fn gemini_reset_refuses_to_overwrite_environment_edits() {
        let temporary = tempfile::tempdir().unwrap();
        apply_at(
            temporary.path(),
            temporary.path(),
            CliTool::GeminiCli,
            "http://localhost:7981",
            "gwclient_proof_only_12345678901234567890",
            "gemini-2.5-flash",
            None,
        )
        .unwrap();
        let settings = CliTool::GeminiCli.config_path(temporary.path());
        let applied = fs::read_to_string(&settings).unwrap();
        fs::write(settings.with_file_name(".env"), "USER_EDIT=yes\n").unwrap();
        assert!(
            status_at(temporary.path(), temporary.path(), CliTool::GeminiCli)
                .unwrap()
                .conflict
        );
        assert!(reset_at(temporary.path(), temporary.path(), CliTool::GeminiCli).is_err());
        assert_eq!(fs::read_to_string(settings).unwrap(), applied);
    }

    #[test]
    fn gemini_new_files_are_removed_by_reset() {
        let temporary = tempfile::tempdir().unwrap();
        apply_at(
            temporary.path(),
            temporary.path(),
            CliTool::GeminiCli,
            "http://localhost:7981",
            "gwclient_proof_only_12345678901234567890",
            "gemini-2.5-flash",
            None,
        )
        .unwrap();
        reset_at(temporary.path(), temporary.path(), CliTool::GeminiCli).unwrap();
        let settings = CliTool::GeminiCli.config_path(temporary.path());
        assert!(!settings.exists());
        assert!(!settings.with_file_name(".env").exists());
    }

    #[test]
    fn opencode_apply_reapply_and_reset_preserve_existing_providers() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Opencode.config_path(temp.path());
        let original = r#"{"model":"old/model","provider":{"old":{"options":{"apiKey":"old-key"}}},"permission":{"bash":"ask"}}"#;
        write_private(&path, original).unwrap();
        for model in ["openrouter/auto", "pool:free-chat"] {
            apply_at(
                temp.path(),
                temp.path(),
                CliTool::Opencode,
                "http://localhost:7981",
                "test-key-with-enough-entropy",
                model,
                None,
            )
            .unwrap();
            let applied: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(applied["model"], format!("ryu-gateway/{model}"));
            let provider = &applied["provider"]["ryu-gateway"];
            assert_eq!(provider["npm"], "@ai-sdk/openai-compatible");
            assert_eq!(provider["options"]["baseURL"], "http://localhost:7981/v1");
            assert_eq!(
                provider["options"]["apiKey"],
                "test-key-with-enough-entropy"
            );
            assert_eq!(provider["models"][model]["name"], model);
            assert_eq!(applied["provider"]["old"]["options"]["apiKey"], "old-key");
            assert_eq!(applied["permission"]["bash"], "ask");
        }
        reset_at(temp.path(), temp.path(), CliTool::Opencode).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn opencode_jsonc_keeps_comments_and_resets_the_selected_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Opencode.config_path(temp.path());
        let original = "{ // User settings\n \"permission\": { \"bash\": \"ask\", },\n }";
        write_private(&path.with_extension("jsonc"), original).unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::Opencode,
            "http://localhost:7981",
            "test-key-with-enough-entropy",
            "model",
            None,
        )
        .unwrap();
        assert!(!path.exists());
        let applied = fs::read_to_string(path.with_extension("jsonc")).unwrap();
        assert!(applied.contains("// User settings"));
        let value = jsonc_parser::parse_to_serde_value(&applied, &Default::default())
            .unwrap()
            .unwrap();
        assert_eq!(value["permission"]["bash"], "ask");
        write_private(&path, "{\"new_config\":true}").unwrap();
        reset_at(temp.path(), temp.path(), CliTool::Opencode).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"new_config\":true}");
        assert_eq!(
            fs::read_to_string(path.with_extension("jsonc")).unwrap(),
            original
        );
    }

    #[test]
    fn claude_apply_and_reset_preserve_prior_settings() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::ClaudeCode.config_path(temp.path());
        write_private(
            &path,
            r#"{"env":{"KEEP":"yes"},"permissions":{"defaultMode":"ask"}}"#,
        )
        .unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::ClaudeCode,
            "http://127.0.0.1:7981",
            "test-key-with-enough-entropy",
            "claude-sonnet-4",
            None,
        )
        .unwrap();
        let applied: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(applied["env"]["KEEP"], "yes");
        assert_eq!(applied["env"]["ANTHROPIC_MODEL"], "claude-sonnet-4");
        reset_at(temp.path(), temp.path(), CliTool::ClaudeCode).unwrap();
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            r#"{"env":{"KEEP":"yes"},"permissions":{"defaultMode":"ask"}}"#
        );
    }

    #[test]
    fn codex_apply_and_reset_keep_other_tables() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::Codex.config_path(temp.path());
        write_private(&path, "model = 'gpt-5'\n[features]\nweb_search = true\n").unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::Codex,
            "http://localhost:7981",
            "test-key-with-enough-entropy",
            "openrouter/auto",
            None,
        )
        .unwrap();
        let applied = fs::read_to_string(&path).unwrap();
        assert!(applied.contains("model_provider = \"ryu-gateway\""));
        assert!(applied.contains("web_search = true"));
        assert!(applied.contains("experimental_bearer_token"));
        reset_at(temp.path(), temp.path(), CliTool::Codex).unwrap();
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "model = 'gpt-5'\n[features]\nweb_search = true\n"
        );
    }

    #[test]
    fn reset_refuses_to_discard_later_user_edits() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::ClaudeCode.config_path(temp.path());
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::ClaudeCode,
            "http://localhost:7981",
            "test-key-with-enough-entropy",
            "m",
            None,
        )
        .unwrap();
        fs::write(&path, "{\"user_edit\":true}").unwrap();
        assert!(
            status_at(temp.path(), temp.path(), CliTool::ClaudeCode)
                .unwrap()
                .conflict
        );
        assert!(reset_at(temp.path(), temp.path(), CliTool::ClaudeCode).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "{\"user_edit\":true}");
    }

    #[test]
    fn snapshot_seals_the_users_original_config_and_reset_restores_it() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::ClaudeCode.config_path(temp.path());
        let original = "{\"env\":{\"ANTHROPIC_API_KEY\":\"sk-user-own-secret-123\"}}";
        write_private(&path, original).unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::ClaudeCode,
            "http://localhost:7981",
            "test-key-with-enough-entropy",
            "model",
            None,
        )
        .unwrap();
        let state_file = state_path(temp.path(), CliTool::ClaudeCode);
        let on_disk = fs::read_to_string(&state_file).unwrap();
        assert!(!on_disk.contains("sk-user-own-secret-123"));
        assert!(on_disk.contains("enc:v1:"));
        assert!(
            status_at(temp.path(), temp.path(), CliTool::ClaudeCode)
                .unwrap()
                .applied
        );
        reset_at(temp.path(), temp.path(), CliTool::ClaudeCode).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn legacy_plaintext_snapshot_still_resets_and_is_resealed() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::ClaudeCode.config_path(temp.path());
        let original = "{\"env\":{\"ANTHROPIC_API_KEY\":\"sk-legacy-secret-456\"}}";
        let applied = "{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"gateway\"}}";
        write_private(&path, applied).unwrap();
        let state_file = state_path(temp.path(), CliTool::ClaudeCode);
        // A snapshot written before sealing: `original` is plain JSON text.
        let legacy = serde_json::json!({
            "original": original,
            "applied_hash": hash(applied),
        });
        write_state_file(&state_file, &legacy.to_string()).unwrap();
        reseal_legacy_snapshots(temp.path()).unwrap();
        let on_disk = fs::read_to_string(&state_file).unwrap();
        assert!(!on_disk.contains("sk-legacy-secret-456"));
        reset_at(temp.path(), temp.path(), CliTool::ClaudeCode).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn interrupted_apply_can_be_retried_without_losing_the_original() {
        let temp = tempfile::tempdir().unwrap();
        let path = CliTool::ClaudeCode.config_path(temp.path());
        write_private(&path, "{\"env\":{}}").unwrap();
        let state_file = state_path(temp.path(), CliTool::ClaudeCode);
        let pending = AppliedState {
            original: Some("{\"env\":{}}".to_owned()),
            applied_hash: hash("an update that never reached the config file"),
            opencode_jsonc: false,
            cline_semantic_hash: None,
            target_path: None,
        };
        write_state_file(&state_file, &serde_json::to_string(&pending).unwrap()).unwrap();
        apply_at(
            temp.path(),
            temp.path(),
            CliTool::ClaudeCode,
            "http://localhost:7981",
            "test-key-with-enough-entropy",
            "model",
            None,
        )
        .unwrap();
        reset_at(temp.path(), temp.path(), CliTool::ClaudeCode).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "{\"env\":{}}");
    }
}

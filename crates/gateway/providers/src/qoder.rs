//! Official Qoder CLI transport. Profile URLs are selectors, never HTTP endpoints.
use std::{pin::Pin, process::Stdio, time::Duration};

use axum::body::Body;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Mutex,
};

use crate::{Provider, ProviderError};

const MODEL_LIMIT: usize = 256 * 1024;
const TURN_LIMIT: usize = 64 * 1024 * 1024;
const LINE_LIMIT: usize = 8 * 1024 * 1024;
const INPUT_LIMIT: usize = 200_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QoderRegion {
    Global,
    Cn,
}

impl QoderRegion {
    fn names(self) -> &'static [&'static str] {
        match self {
            Self::Global => &["qoder", "qodercli"],
            Self::Cn => &["qodercn", "qoderclicn"],
        }
    }
    fn token_env(self) -> &'static str {
        match self {
            Self::Global => "QODER_PERSONAL_ACCESS_TOKEN",
            Self::Cn => "QODERCN_PERSONAL_ACCESS_TOKEN",
        }
    }
    fn config_env(self) -> &'static str {
        match self {
            Self::Global => "QODER_CONFIG_DIR",
            Self::Cn => "QODERCN_CONFIG_DIR",
        }
    }
    fn prompt_env(self) -> &'static str {
        match self {
            Self::Global => "QODER_APPEND_SYSTEM_PROMPT",
            Self::Cn => "QODERCN_APPEND_SYSTEM_PROMPT",
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::Global => "qoder",
            Self::Cn => "qoder-cn",
        }
    }
}

type ModelCache = Option<([u8; 32], std::time::Instant, Vec<Value>)>;

pub struct QoderProvider {
    region: QoderRegion,
    token: String,
    models: Mutex<ModelCache>,
    #[cfg(test)]
    executable: Option<std::path::PathBuf>,
    #[cfg(test)]
    prefix: Vec<String>,
}

impl QoderProvider {
    /// Check only the fixed official profile names; never run a user-supplied command.
    pub fn cli_available(region: QoderRegion) -> bool {
        resolve_cli(region).is_some()
    }

    pub fn new(region: QoderRegion, token: String) -> Self {
        Self {
            region,
            token,
            models: Mutex::new(None),
            #[cfg(test)]
            executable: None,
            #[cfg(test)]
            prefix: Vec::new(),
        }
    }

    fn command(
        &self,
        path: &std::path::Path,
        config: &std::path::Path,
        prompt: &str,
        args: &[String],
    ) -> Result<Command, ProviderError> {
        #[cfg(test)]
        let path = self
            .executable
            .as_ref()
            .map(|p| p.as_path())
            .unwrap_or(path);
        let mut arguments = Vec::new();
        #[cfg(test)]
        arguments.extend(self.prefix.iter().cloned());
        arguments.extend(args.iter().cloned());
        let mut command = launch_command(path, &arguments)?;
        command.env_clear();
        // Runtime plumbing only: no ambient vendor keys, prompts, proxy or config.
        for name in [
            "PATH",
            "SystemRoot",
            "WINDIR",
            "PATHEXT",
            "TEMP",
            "TMP",
            "LANG",
            "LC_ALL",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .env("HOME", config)
            .env("USERPROFILE", config)
            .env("NO_COLOR", "1")
            .env("CI", "1")
            .env(self.region.token_env(), &self.token)
            .env(self.region.config_env(), config)
            .env(self.region.prompt_env(), prompt)
            .current_dir(config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        Ok(command)
    }

    async fn run(
        &self,
        args: &[String],
        input: &[u8],
        prompt: &str,
        limit: usize,
        deadline: Duration,
    ) -> Result<Vec<u8>, ProviderError> {
        if self.token.trim().is_empty() {
            return Err(failure("Qoder Personal Access Token is required"));
        }
        let config = PrivateConfig::create().await?;
        #[cfg(test)]
        let executable = self.executable.clone().or_else(|| resolve_cli(self.region));
        #[cfg(not(test))]
        let executable = resolve_cli(self.region);
        let executable = executable
            .ok_or_else(|| failure("Install the official Qoder CLI for the selected region"))?;
        let mut child = self
            .command(&executable, &config.0, prompt, args)?
            .spawn()
            .map_err(|_| failure("Qoder CLI could not start"))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| failure("Qoder stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| failure("Qoder stdout unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| failure("Qoder stderr unavailable"))?;
        let operation = async {
            let (_, stdout, _) = tokio::try_join!(
                async {
                    stdin
                        .write_all(input)
                        .await
                        .map_err(|_| failure("Qoder input write failed"))?;
                    stdin
                        .shutdown()
                        .await
                        .map_err(|_| failure("Qoder input close failed"))?;
                    drop(stdin); // Native CLI must observe EOF before it emits its result.
                    Ok::<(), ProviderError>(())
                },
                read_bounded(stdout, limit),
                read_bounded(stderr, 64 * 1024)
            )?; // Diagnostics are bounded and never forwarded (may contain credentials).
            let status = child
                .wait()
                .await
                .map_err(|_| failure("Qoder process wait failed"))?;
            if status.code() == Some(118) {
                return Err(quota_error(self.region));
            }
            if !status.success() {
                return Err(failure(&format!(
                    "Qoder CLI rejected the request (exit {})",
                    status
                        .code()
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "signal".into())
                )));
            }
            Ok(stdout)
        };
        match tokio::time::timeout(deadline, operation).await {
            Ok(Ok(output)) => Ok(output),
            result => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                match result {
                    Ok(Err(error)) => Err(error),
                    _ => Err(ProviderError::DeliveryUncertain(
                        "Qoder CLI deadline exceeded".into(),
                    )),
                }
            }
        }
    }

    async fn turn(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        if !valid_model(model) {
            return Err(failure("Invalid Qoder model ID"));
        }
        let (input, prompt) = conversation(body)?;
        let models = self
            .discover_models()
            .await
            .ok_or_else(|| failure("Qoder model discovery is unavailable"))?;
        if !models
            .iter()
            .any(|entry| entry["id"].as_str() == Some(model))
        {
            return Err(failure(
                "Model is not available to the selected Qoder account",
            ));
        }
        let args = [
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--tools",
            "",
            "--strict-mcp-config",
            "--setting-sources",
            "",
            "--max-turns",
            "1",
            "--no-session-persistence",
            "--model",
            model,
        ]
        .map(str::to_owned);
        let output = self
            .run(&args, &input, &prompt, TURN_LIMIT, Duration::from_secs(120))
            .await?;
        decode_turn(&output, model, self.region)
    }
}

impl Provider for QoderProvider {
    fn name(&self) -> &'static str {
        self.region.id()
    }
    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        Box::pin(async move {
            let fingerprint: [u8; 32] = Sha256::digest(self.token.as_bytes()).into();
            let mut cache = self.models.lock().await;
            if let Some((key, time, models)) = cache.as_ref() {
                if *key == fingerprint && time.elapsed() < Duration::from_secs(60) {
                    return Some(models.clone());
                }
            }
            *cache = None;
            let output = self
                .run(
                    &["--list-models".into()],
                    b"",
                    "",
                    MODEL_LIMIT,
                    Duration::from_secs(8),
                )
                .await
                .ok()?;
            let models = parse_models(&output, self.region)?;
            *cache = Some((fingerprint, std::time::Instant::now(), models.clone()));
            Some(models)
        })
    }
    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(self.turn(model, body))
    }
    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            // Qoder's default stream-json emits complete assistant frames. Validate the
            // terminal result before exposing them; never claim unverified tool streaming.
            let response = self.turn(model, body).await?;
            let message = &response["choices"][0]["message"];
            let chunk = json!({"id":response["id"],"object":"chat.completion.chunk","model":model,"choices":[{"index":0,"delta":message,"finish_reason":null}]});
            let done = json!({"id":response["id"],"object":"chat.completion.chunk","model":model,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":response["usage"]});
            Ok(Body::from(format!(
                "data: {chunk}\n\ndata: {done}\n\ndata: [DONE]\n\n"
            )))
        })
    }
}

struct PrivateConfig(std::path::PathBuf);

fn resolve_cli(region: QoderRegion) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for name in region.names() {
        for directory in std::env::split_paths(&path) {
            #[cfg(windows)]
            let extensions = [".exe", ".cmd", ".bat"];
            #[cfg(not(windows))]
            let extensions = [""];
            for extension in extensions {
                let candidate = directory.join(format!("{name}{extension}"));
                let Ok(metadata) = std::fs::metadata(&candidate) else {
                    continue;
                };
                if !metadata.is_file() {
                    continue;
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if metadata.permissions().mode() & 0o111 == 0 {
                        continue;
                    }
                }
                #[cfg(windows)]
                if extension != ".exe" && shim_line(&candidate, &[]).is_err() {
                    continue;
                }
                return Some(candidate);
            }
        }
    }
    None
}

fn launch_command(path: &std::path::Path, args: &[String]) -> Result<Command, ProviderError> {
    #[cfg(windows)]
    if path.extension().is_some_and(|extension| {
        extension.to_str().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
    }) {
        use std::os::windows::process::CommandExt;
        let system = std::env::var_os("SystemRoot")
            .ok_or_else(|| failure("Windows system directory unavailable"))?;
        // CMD parses slash switches in its own command line. A mixed-separator
        // `System32/cmd.exe` path exposes `/c` inside the executable token.
        let mut native = std::process::Command::new(
            std::path::PathBuf::from(system)
                .join("System32")
                .join("cmd.exe"),
        );
        native
            .args(["/d", "/s", "/c"])
            .raw_arg(format!("\"{}\"", shim_line(path, args)?));
        return Ok(Command::from(native));
    }
    let mut command = Command::new(path);
    command.args(args);
    Ok(command)
}

#[cfg(windows)]
fn shim_line(path: &std::path::Path, args: &[String]) -> Result<String, ProviderError> {
    let path = path
        .to_str()
        .ok_or_else(|| failure("Invalid Qoder shim path"))?;
    // Reject expansion and control characters, including those capable of escaping
    // cross-spawn-style caret quoting across npm's second batch evaluation.
    if path
        .chars()
        .any(|c| c.is_control() || "%!^\"&|<>`".contains(c))
        || args.iter().any(|arg| {
            !arg.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
        })
    {
        return Err(failure("Unsafe Qoder shim argument or path"));
    }
    let escaped: String = path
        .chars()
        .flat_map(|c| {
            if "()[];, *?".contains(c) {
                vec!['^', c]
            } else {
                vec![c]
            }
        })
        .collect();
    let mut line = escaped;
    let double_escape = path
        .to_ascii_lowercase()
        .replace('/', "\\")
        .contains("node_modules\\.bin\\");
    for arg in args {
        line.push(' ');
        let quoted = format!("^\"{arg}^\"");
        if double_escape {
            for character in quoted.chars() {
                if "^\"".contains(character) {
                    line.push('^');
                }
                line.push(character);
            }
        } else {
            line.push_str(&quoted);
        }
    }
    Ok(line)
}

impl PrivateConfig {
    async fn create() -> Result<Self, ProviderError> {
        let path = std::env::temp_dir().join(format!("ryu-qoder-{}", uuid::Uuid::new_v4()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&path)
                .map_err(|_| failure("Qoder isolated config creation failed"))?;
        }
        #[cfg(not(unix))]
        tokio::fs::create_dir(&path)
            .await
            .map_err(|_| failure("Qoder isolated config creation failed"))?;
        Ok(Self(path))
    }
}
impl Drop for PrivateConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn failure(message: &str) -> ProviderError {
    ProviderError::Provider(message.into())
}
fn quota_error(region: QoderRegion) -> ProviderError {
    ProviderError::RateLimited {
        provider: region.id().to_owned(),
        retry_after: None,
        reset_at: None,
    }
}
async fn read_bounded(
    reader: impl AsyncRead + Unpin,
    limit: usize,
) -> Result<Vec<u8>, ProviderError> {
    let mut bytes = Vec::new();
    reader
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| failure("Qoder output read failed"))?;
    if bytes.len() > limit {
        return Err(failure("Qoder output exceeded its bound"));
    }
    Ok(bytes)
}
fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 256
        && !model.starts_with('-')
        && model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
}
fn parse_models(bytes: &[u8], region: QoderRegion) -> Option<Vec<Value>> {
    if bytes.len() > MODEL_LIMIT {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines();
    lines.find(|line| line.trim().eq_ignore_ascii_case("model"))?;
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in lines {
        let id = line.trim();
        if valid_model(id) && seen.insert(id.to_owned()) {
            models.push(json!({"id":id,"object":"model","owned_by":region.id()}));
            if models.len() == 256 {
                break;
            }
        }
    }
    (!models.is_empty()).then_some(models)
}

fn conversation(body: &Value) -> Result<(Vec<u8>, String), ProviderError> {
    if body
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
    {
        return Err(failure("Qoder tools are not supported"));
    }
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| failure("Qoder requires messages"))?;
    let mut system = Vec::new();
    let mut turns = Vec::new();
    let mut total = 0;
    for message in messages {
        if message.get("tool_calls").is_some() {
            return Err(failure("Qoder tool calls are not supported"));
        }
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| failure("Invalid Qoder message role"))?;
        let content = &message["content"];
        let text = if let Some(text) = content.as_str() {
            text.to_owned()
        } else if let Some(parts) = content.as_array() {
            let mut result = String::new();
            for part in parts {
                if part["type"] != "text" {
                    return Err(failure("Qoder accepts text input only"));
                }
                result.push_str(
                    part["text"]
                        .as_str()
                        .ok_or_else(|| failure("Invalid Qoder text block"))?,
                );
            }
            result
        } else {
            return Err(failure("Invalid Qoder content"));
        };
        total += text.len();
        if total > INPUT_LIMIT {
            return Err(failure("Qoder conversation exceeds its bound"));
        }
        match role {
            "system" | "developer" => system.push(text),
            "user" | "assistant" => turns.push((role, text)),
            _ => {
                return Err(failure(
                    "Qoder accepts user and assistant text history only",
                ))
            }
        }
    }
    let text = if turns.len() == 1 && turns[0].0 == "user" {
        turns[0].1.clone()
    } else {
        let (current, prior) = turns
            .split_last()
            .ok_or_else(|| failure("Qoder requires a user request"))?;
        let history = prior
            .iter()
            .map(|(role, text)| format!("{}:\n{text}", role.to_uppercase()))
            .collect::<Vec<_>>()
            .join("\n\n");
        format!(
            "Prior conversation context:\n\n{history}\n\nCurrent user request:\n\n{}",
            current.1
        )
    };
    let mut wire = serde_json::to_vec(
        &json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":text}]}}),
    )
    .map_err(|_| failure("Qoder input encoding failed"))?;
    wire.push(b'\n');
    Ok((wire, system.join("\n\n")))
}

/// Validate the text-only caller boundary before capturing a provider credential.
pub fn validate_request(body: &Value) -> Result<(), ProviderError> {
    conversation(body).map(|_| ())
}

fn decode_turn(bytes: &[u8], model: &str, region: QoderRegion) -> Result<Value, ProviderError> {
    let mut text = String::new();
    let mut thinking = String::new();
    let mut partial_text = false;
    let mut partial_thinking = false;
    let mut terminal = false;
    let mut usage = json!({});
    for line in bytes
        .split(|b| *b == b'\n')
        .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
    {
        if line.len() > LINE_LIMIT {
            return Err(failure("Qoder frame exceeded its bound"));
        }
        let frame: Value = serde_json::from_slice(line)
            .map_err(|_| failure("Malformed Qoder stream-json frame"))?;
        if !frame.is_object() || terminal {
            return Err(failure("Invalid Qoder protocol sequence"));
        }
        match frame["type"].as_str() {
            Some("stream_event") => {
                let event = &frame["event"];
                if event["content_block"]["type"] == "tool_use"
                    || event["delta"]["type"] == "input_json_delta"
                {
                    return Err(failure("Qoder emitted unsupported tool output"));
                }
                let delta = &event["delta"];
                if delta["type"] == "text_delta" {
                    text.push_str(
                        delta["text"]
                            .as_str()
                            .ok_or_else(|| failure("Invalid Qoder text delta"))?,
                    );
                    partial_text = true;
                }
                if delta["type"] == "thinking_delta" {
                    thinking.push_str(
                        delta["thinking"]
                            .as_str()
                            .ok_or_else(|| failure("Invalid Qoder reasoning delta"))?,
                    );
                    partial_thinking = true;
                }
            }
            Some("assistant") => {
                let blocks = frame["message"]["content"]
                    .as_array()
                    .ok_or_else(|| failure("Invalid Qoder assistant frame"))?;
                for block in blocks {
                    match block["type"].as_str() {
                        Some("text") if !partial_text => text.push_str(
                            block["text"]
                                .as_str()
                                .ok_or_else(|| failure("Invalid Qoder text"))?,
                        ),
                        Some("thinking") if !partial_thinking => thinking.push_str(
                            block["thinking"]
                                .as_str()
                                .ok_or_else(|| failure("Invalid Qoder reasoning"))?,
                        ),
                        Some("text" | "thinking") => {}
                        _ => return Err(failure("Qoder emitted unsupported content")),
                    }
                }
            }
            Some("result") => {
                if frame["is_error"] == true || frame["subtype"] != "success" {
                    if frame["error_code"] == 118
                        || frame["result"]
                            .as_str()
                            .is_some_and(|s| s.to_lowercase().contains("credit usage limit"))
                    {
                        return Err(quota_error(region));
                    }
                    return Err(failure("Qoder CLI returned an execution error"));
                }
                terminal = true;
                let input = frame["usage"]["input_tokens"].as_u64().unwrap_or(0);
                let output = frame["usage"]["output_tokens"].as_u64().unwrap_or(0);
                usage = json!({"prompt_tokens":input,"completion_tokens":output,"total_tokens":input.saturating_add(output)});
            }
            Some("system" | "user") => {}
            _ => return Err(failure("Unsupported Qoder protocol frame")),
        }
    }
    if !terminal {
        return Err(ProviderError::DeliveryUncertain(
            "Qoder stream ended without a terminal result".into(),
        ));
    }
    Ok(
        json!({"id":format!("chatcmpl-{}", uuid::Uuid::new_v4()),"object":"chat.completion","model":model,"choices":[{"index":0,"message":{"role":"assistant","content":text,"reasoning_content":thinking},"finish_reason":"stop"}],"usage":usage}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_roster_is_authoritative_bounded_and_deduplicated() {
        let models = parse_models(
            b"Model\nqoder-best\nqoder-best\n../unsafe space\nqoder-fast\n",
            QoderRegion::Cn,
        )
        .unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["owned_by"], "qoder-cn");
        assert!(parse_models(b"{\"data\":[]}", QoderRegion::Global).is_none());
        assert!(parse_models(&vec![b'x'; MODEL_LIMIT + 1], QoderRegion::Global).is_none());
        for region in [QoderRegion::Global, QoderRegion::Cn] {
            match quota_error(region) {
                ProviderError::RateLimited {
                    provider,
                    retry_after,
                    reset_at,
                } => {
                    assert_eq!(provider, region.id());
                    assert_eq!(retry_after, None);
                    assert_eq!(reset_at, None);
                }
                other => panic!("Unexpected quota verdict: {other}"),
            }
        }
    }

    #[test]
    fn conversation_is_one_legal_user_frame_with_scoped_system_and_history() {
        let (wire, system) = conversation(&json!({"messages":[{"role":"system","content":"policy"},{"role":"user","content":"first"},{"role":"assistant","content":"answer"},{"role":"user","content":"next"}]})).unwrap();
        assert_eq!(system, "policy");
        assert_eq!(wire.iter().filter(|b| **b == b'\n').count(), 1);
        let value: Value = serde_json::from_slice(&wire).unwrap();
        assert_eq!(value["type"], "user");
        assert!(value["message"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("ASSISTANT:\nanswer"));
        assert!(conversation(&json!({"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.com/image"}}]}]})).is_err());
        assert!(conversation(&json!({"messages":[],"tools":[{}]})).is_err());
        assert!(conversation(
            &json!({"messages":[{"role":"user","content":"x".repeat(INPUT_LIMIT+1)}]})
        )
        .is_err());
    }

    #[test]
    fn protocol_deduplicates_reasoning_and_requires_success_without_tools() {
        let bytes = concat!(
            "{\"type\":\"stream_event\",\"event\":{\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}}\n",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"},{\"type\":\"thinking\",\"thinking\":\"reason\"}]}}\n",
            "{\"type\":\"result\",\"subtype\":\"success\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}\n"
        );
        let output = decode_turn(bytes.as_bytes(), "model", QoderRegion::Global).unwrap();
        assert_eq!(output["choices"][0]["message"]["content"], "hello");
        assert_eq!(
            output["choices"][0]["message"]["reasoning_content"],
            "reason"
        );
        assert_eq!(output["usage"]["total_tokens"], 5);
        assert!(decode_turn(
            b"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\"}]}}",
            "model",
            QoderRegion::Cn
        )
        .is_err());
        assert!(matches!(
            decode_turn(b"{\"type\":\"system\"}", "model", QoderRegion::Cn),
            Err(ProviderError::DeliveryUncertain(_))
        ));
        assert!(matches!(
            decode_turn(
                b"{\"type\":\"result\",\"is_error\":true,\"error_code\":118}",
                "model",
                QoderRegion::Cn
            ),
            Err(ProviderError::RateLimited { .. })
        ));
    }

    async fn fixture(region: QoderRegion, script: &str) -> (QoderProvider, PrivateConfig) {
        let directory = PrivateConfig::create().await.unwrap();
        let mut provider = QoderProvider::new(region, "synthetic-pat".into());
        #[cfg(windows)]
        {
            let path = directory.0.join("fixture.ps1");
            tokio::fs::write(&path, script).await.unwrap();
            provider.executable = Some("powershell.exe".into());
            provider.prefix = vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                path.to_string_lossy().into_owned(),
            ];
        }
        #[cfg(unix)]
        {
            let path = directory.0.join("fixture.sh");
            tokio::fs::write(&path, script).await.unwrap();
            provider.executable = Some("/bin/sh".into());
            provider.prefix = vec![path.to_string_lossy().into_owned()];
        }
        (provider, directory)
    }

    #[tokio::test]
    async fn both_regions_invoke_native_process_with_child_only_pat_and_exact_flags() {
        for region in [QoderRegion::Global, QoderRegion::Cn] {
            #[cfg(windows)]
            let script = format!(
                r#"
$wire = [Console]::In.ReadToEnd()
if ($args[0] -eq '--list-models') {{ [Console]::Write("Model`nfixture-model`n"); exit 0 }}
$allowed = @('-p','--output-format','stream-json','--input-format','stream-json','--tools','','--strict-mcp-config','--setting-sources','','--max-turns','1','--no-session-persistence','--model','fixture-model')
if (($args -join '|') -ne ($allowed -join '|')) {{ exit 7 }}
if ($env:{token} -ne 'synthetic-pat' -or $env:{prompt} -ne 'policy') {{ exit 8 }}
if ($env:{other} -or $env:OPENAI_API_KEY) {{ exit 9 }}
$frame = $wire | ConvertFrom-Json
if ($frame.type -ne 'user' -or $frame.message.content[0].text -ne 'hello') {{ exit 10 }}
[Console]::Write('{{"type":"assistant","message":{{"content":[{{"type":"text","text":"fixture answer"}}]}}}}' + "`n" + '{{"type":"result","subtype":"success"}}' + "`n")
"#,
                token = region.token_env(),
                prompt = region.prompt_env(),
                other = if region == QoderRegion::Global {
                    QoderRegion::Cn.token_env()
                } else {
                    QoderRegion::Global.token_env()
                }
            );
            #[cfg(unix)]
            let script = format!(
                r#"
if [ "$1" = '--list-models' ]; then printf 'Model\nfixture-model\n'; exit 0; fi
[ "${{{token}}}" = 'synthetic-pat' ] || exit 8
[ "${{{prompt}}}" = 'policy' ] || exit 9
[ "$1" = '-p' ] && [ "$6" = '--tools' ] && [ "$7" = '' ] && [ "${{15}}" = 'fixture-model' ] || exit 7
cat >/dev/null
printf '%s\n' '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"fixture answer"}}]}}}}' '{{"type":"result","subtype":"success"}}'
"#,
                token = region.token_env(),
                prompt = region.prompt_env()
            );
            let (provider, _directory) = fixture(region, &script).await;
            let models = provider.discover_models().await.unwrap();
            assert_eq!(models[0]["id"], "fixture-model");
            let response = provider.complete("fixture-model", &json!({"messages":[{"role":"system","content":"policy"},{"role":"user","content":"hello"}]})).await.unwrap();
            assert_eq!(
                response["choices"][0]["message"]["content"],
                "fixture answer"
            );
            let command = provider
                .command(
                    std::path::Path::new(region.names()[0]),
                    &_directory.0,
                    "policy",
                    &[],
                )
                .unwrap();
            let environment: Vec<_> = command.as_std().get_envs().collect();
            assert!(!environment
                .iter()
                .any(|(name, _)| *name == std::ffi::OsStr::new("OPENAI_API_KEY")));
        }
    }

    #[tokio::test]
    async fn deadline_kills_process_and_cleans_isolated_configuration() {
        #[cfg(windows)]
        let script = "Start-Sleep -Seconds 30";
        #[cfg(unix)]
        let script = "exec sleep 30";
        let (provider, _directory) = fixture(QoderRegion::Global, script).await;
        let started = std::time::Instant::now();
        let result = provider
            .run(&[], b"", "", 1024, Duration::from_millis(200))
            .await;
        assert!(matches!(result, Err(ProviderError::DeliveryUncertain(_))));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_npm_shim_preserves_empty_flags_child_pat_and_stdin() {
        let script = r#"
$wire = [Console]::In.ReadToEnd() | ConvertFrom-Json
if (($args -join '|') -ne '-p|--output-format|stream-json|--input-format|stream-json|--tools||--strict-mcp-config|--setting-sources||--max-turns|1|--no-session-persistence|--model|fixture-model') { exit 7 }
if ($env:QODERCN_PERSONAL_ACCESS_TOKEN -ne 'synthetic-pat' -or $env:QODER_PERSONAL_ACCESS_TOKEN -or $env:QODERCN_APPEND_SYSTEM_PROMPT -ne 'policy') { exit 8 }
if ($wire.type -ne 'user' -or $wire.message.content[0].text -ne 'hello') { exit 9 }
[Console]::Write('{"type":"assistant","message":{"content":[{"type":"text","text":"shim answer"}]}}' + "`n" + '{"type":"result","subtype":"success"}' + "`n")
"#;
        let (mut provider, directory) = fixture(QoderRegion::Cn, script).await;
        let powershell = directory.0.join("fixture.ps1");
        let shim = directory.0.join("qoderclicn.cmd");
        tokio::fs::write(&shim, format!("@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\" %*\r\n", powershell.display())).await.unwrap();
        provider.executable = Some(shim.clone());
        provider.prefix.clear();
        let args = [
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--tools",
            "",
            "--strict-mcp-config",
            "--setting-sources",
            "",
            "--max-turns",
            "1",
            "--no-session-persistence",
            "--model",
            "fixture-model",
        ]
        .map(str::to_owned);
        let (wire, prompt) = conversation(&json!({"messages":[{"role":"system","content":"policy"},{"role":"user","content":"hello"}]})).unwrap();
        let output = provider
            .run(&args, &wire, &prompt, 4096, Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(
            decode_turn(&output, "fixture-model", QoderRegion::Cn).unwrap()["choices"][0]
                ["message"]["content"],
            "shim answer"
        );
        for arg in [
            "model&whoami",
            "%QODERCN_PERSONAL_ACCESS_TOKEN%",
            "!secret!",
            "model\ncommand",
            "model\"command",
        ] {
            assert!(shim_line(&shim, &[arg.to_owned()]).is_err());
            assert!(!valid_model(arg));
        }
        assert!(shim_line(std::path::Path::new("C:/unsafe%PATH%/qoder.cmd"), &[]).is_err());
    }
}

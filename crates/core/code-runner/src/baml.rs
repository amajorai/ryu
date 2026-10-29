//! BAML functions: `baml-cli check` for check mode, and a short-lived
//! `baml-cli serve` (BAML-over-HTTP) for one `POST /call/<function>` in run mode.
//!
//! BAML has no IO of its own; its only effect is the model call. The server runs
//! with a cleared environment, a random `BAML_PASSWORD` (it binds every
//! interface), an empty working directory (it loads `.env` from there), and a
//! Core-written [`BAML_CLIENT_NAME`] client that targets the Ryu gateway. User
//! sources may not declare clients of their own.

use std::path::Path;
use std::time::{Duration, Instant};

use tokio::process::Command;

use crate::process;
use crate::toolchain::{self, Tool};
use crate::{check_receipt, clip, CodeLanguage, CodeMode, CodeOutput, CodeRequest, LlmRoute};
use crate::{MAX_INPUT_BYTES, MAX_OUTPUT_BYTES};

/// The client every BAML step function uses: `client Ryu`.
pub const BAML_CLIENT_NAME: &str = "Ryu";
const RUNNER: &str = "host:baml";
const SOURCE_DIR: &str = "baml_src";
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const ERROR_CLIP: usize = 8192;

/// The Core-provided client. Values come from the server's environment so no
/// step input is ever spliced into BAML source.
pub(crate) fn ryu_client_source(has_api_key: bool) -> String {
    let api_key = if has_api_key {
        "\n    api_key env.RYU_GATEWAY_API_KEY"
    } else {
        ""
    };
    format!(
        "// Written by Ryu: model calls from this step go through the Ryu gateway.\n\
         client<llm> {BAML_CLIENT_NAME} {{\n  \
           provider \"openai-generic\"\n  \
           options {{\n    \
             base_url env.RYU_GATEWAY_BASE_URL{api_key}\n    \
             model env.RYU_GATEWAY_MODEL\n  \
           }}\n\
         }}\n"
    )
}

/// Refuse sources that declare their own model clients (named `client<llm>`
/// blocks or `client "provider/model"` shorthands): those could read provider
/// credentials or address a provider without the gateway.
pub(crate) fn validate_source(source: &str) -> Result<(), String> {
    for line in source.lines() {
        let code = line.split("//").next().unwrap_or_default();
        let compact: String = code.chars().filter(|ch| !ch.is_whitespace()).collect();
        if compact.contains("client<") {
            return Err(format!(
                "BAML code steps cannot declare model clients; use `client {BAML_CLIENT_NAME}`, \
                 which Ryu provides and routes through the gateway"
            ));
        }
        let trimmed = code.trim_start();
        if let Some(rest) = trimmed.strip_prefix("client") {
            if rest.trim_start().starts_with('"') {
                return Err(format!(
                    "BAML code steps cannot use shorthand clients such as `client \"openai/...\"`; \
                     use `client {BAML_CLIENT_NAME}`"
                ));
            }
        }
    }
    Ok(())
}

/// A BAML function name: an identifier, so it is safe in a URL path.
pub(crate) fn validate_function(function: Option<&str>) -> Result<&str, String> {
    let name = function.map(str::trim).unwrap_or_default();
    let mut chars = name.chars();
    let valid_start = chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_');
    if valid_start && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        return Ok(name);
    }
    if name.is_empty() {
        return Err("a BAML run step needs `function`: the BAML function to call".to_string());
    }
    Err(format!("`{name}` is not a valid BAML function name"))
}

/// Turn a successful `/call` response body into the step output: a JSON string
/// result is emitted raw, anything else as compact JSON.
pub(crate) fn output_from_response(body: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(serde_json::Value::String(text)) => text,
        Ok(value) => value.to_string(),
        Err(_) => body.trim().to_string(),
    }
}

/// Pull BAML's `message` out of an error response when there is one.
pub(crate) fn error_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.to_string())
}

pub(crate) async fn run(
    request: &CodeRequest<'_>,
    timeout: Duration,
) -> Result<CodeOutput, String> {
    validate_source(request.source)?;
    let binary = toolchain::resolve(Tool::Baml)?;
    let workdir = tempfile::tempdir()
        .map_err(|error| format!("could not create a BAML working directory: {error}"))?;
    let source_dir = workdir.path().join(SOURCE_DIR);
    std::fs::create_dir(&source_dir)
        .and_then(|()| {
            std::fs::write(
                source_dir.join("ryu.baml"),
                ryu_client_source(request.llm.is_some_and(|llm| llm.api_key.is_some())),
            )
        })
        .and_then(|()| std::fs::write(source_dir.join("main.baml"), request.source))
        .map_err(|error| format!("could not write the BAML source: {error}"))?;
    let value = match request.mode {
        CodeMode::Check => check(&binary, workdir.path(), timeout).await?,
        CodeMode::Run => {
            let function = validate_function(request.function)?;
            let Some(llm) = request.llm else {
                return Err(
                    "BAML run steps call models through the Ryu gateway, which is not configured"
                        .to_string(),
                );
            };
            let args = match request.args {
                serde_json::Value::Object(_) => request.args.to_string(),
                serde_json::Value::Null => {
                    return Err(format!(
                        "a BAML run step needs `args`: an object of {function}'s parameters, \
                         for example {{\"text\": \"{{{{input}}}}\"}}"
                    ))
                }
                _ => {
                    return Err("BAML `args` must be a JSON object of named parameters".to_string())
                }
            };
            if args.len() > MAX_INPUT_BYTES {
                return Err(format!(
                    "BAML args are {} bytes; code steps accept at most {MAX_INPUT_BYTES}",
                    args.len()
                ));
            }
            call(&binary, workdir.path(), function, args, llm, timeout).await?
        }
    };
    Ok(CodeOutput {
        value,
        runner: RUNNER.to_string(),
    })
}

async fn check(binary: &Path, workdir: &Path, timeout: Duration) -> Result<String, String> {
    let mut command = Command::new(binary);
    command
        .args(["check", "--from", SOURCE_DIR])
        .current_dir(workdir);
    process::prepare(&mut command, process::child_env(&[]));
    let captured = process::run_bounded(command, timeout, "baml-cli check").await?;
    if captured.exit_code != Some(0) {
        return Err(format!(
            "BAML rejected the source:\n{}",
            clip(&captured.combined(), ERROR_CLIP)
        ));
    }
    Ok(check_receipt(
        CodeLanguage::Baml,
        RUNNER,
        &captured.combined(),
    ))
}

/// Pick a free loopback port. The listener is dropped before `baml-cli` binds,
/// so a collision is possible but only fails this step.
fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("could not reserve a port for baml-cli serve: {error}"))
}

fn log_tail(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let tail_start = text.len().saturating_sub(4096);
    let mut start = tail_start;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].trim().to_string()
}

async fn call(
    binary: &Path,
    workdir: &Path,
    function: &str,
    args: String,
    llm: &LlmRoute,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let port = free_port()?;
    let password = format!("sk-baml-{}", uuid::Uuid::new_v4().simple());
    let log_path = workdir.join("serve.log");
    let log = std::fs::File::create(&log_path)
        .and_then(|file| Ok((file.try_clone()?, file)))
        .map_err(|error| format!("could not create the baml-cli log: {error}"))?;

    let mut extra = vec![
        ("RYU_GATEWAY_BASE_URL", llm.base_url.clone()),
        ("RYU_GATEWAY_MODEL", llm.model.clone()),
        ("BAML_PASSWORD", password.clone()),
        ("BAML_LOG", "warn".to_string()),
    ];
    if let Some(key) = &llm.api_key {
        extra.push(("RYU_GATEWAY_API_KEY", key.clone()));
    }
    let mut command = Command::new(binary);
    command
        .args([
            "serve",
            "--from",
            SOURCE_DIR,
            "--port",
            &port.to_string(),
            "--no-version-check",
        ])
        .current_dir(workdir);
    process::prepare(&mut command, process::child_env(&extra));
    command.stdout(log.0).stderr(log.1);
    let mut server = command
        .spawn()
        .map_err(|error| format!("could not start baml-cli serve: {error}"))?;

    let result = async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|error| format!("could not build the BAML HTTP client: {error}"))?;
        let base = format!("http://127.0.0.1:{port}");
        loop {
            if let Ok(Some(status)) = server.try_wait() {
                return Err(format!(
                    "baml-cli serve exited ({status}) before it was ready:\n{}",
                    log_tail(&log_path)
                ));
            }
            let ping = client
                .get(format!("{base}/_debug/ping"))
                .timeout(Duration::from_secs(2))
                .send()
                .await;
            if ping.is_ok_and(|response| response.status().is_success()) {
                break;
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "baml-cli serve was not ready within the {}s step timeout:\n{}",
                    timeout.as_secs(),
                    log_tail(&log_path)
                ));
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let response = client
            .post(format!("{base}/call/{function}"))
            .header("x-baml-api-key", &password)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(args)
            .timeout(remaining.max(Duration::from_secs(1)))
            .send()
            .await
            .map_err(|error| format!("BAML function {function} did not answer: {error}"))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|error| format!("BAML function {function} response was unreadable: {error}"))?;
        if body.len() > MAX_OUTPUT_BYTES {
            return Err(format!(
                "BAML function {function} returned {} bytes; code steps keep at most {MAX_OUTPUT_BYTES}",
                body.len()
            ));
        }
        let body = String::from_utf8_lossy(&body);
        if !status.is_success() {
            return Err(format!(
                "BAML function {function} failed (HTTP {}): {}",
                status.as_u16(),
                clip(&error_message(&body), ERROR_CLIP)
            ));
        }
        Ok(output_from_response(&body))
    }
    .await;
    process::kill_tree(&mut server).await;
    result
}

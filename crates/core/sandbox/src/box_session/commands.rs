//! Commands and managed prompt runs inside a Box: find by name, scripts,
//! prompts, process output, interrupt, and destroy.

use super::*;

impl BoxSessionClient {
    /// Find the first non-deleted Box whose name matches exactly.
    pub async fn find_by_name(&self, name: &str) -> Result<Option<WorkspaceId>> {
        let value = self
            .request(reqwest::Method::GET, "/boxes", None, None, None)
            .await?;
        let boxes = value
            .get("boxes")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("Box list response did not contain boxes"))?;
        let found = boxes.iter().find(|entry| {
            entry.get("name").and_then(Value::as_str) == Some(name)
                && entry.get("status").and_then(Value::as_str) != Some("deleted")
        });
        let Some(entry) = found else {
            return Ok(None);
        };
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("Box list entry did not contain an id"))?;
        validate_box_id(id)?;
        Ok(Some(WorkspaceId(id.to_owned())))
    }

    /// Run a shell script (sent only as stdin to `sh -s`) with per-command
    /// env as `user`. The env is never logged.
    pub async fn exec_script(
        &self,
        id: &WorkspaceId,
        script: &str,
        env: &[(String, String)],
        user: BoxUser,
        timeout_secs: u64,
    ) -> Result<ExecOutput> {
        validate_box_id(&id.0)?;
        if timeout_secs == 0 || timeout_secs > MAX_EXEC_TIMEOUT_SECS {
            bail!("Box command timeout must be between 1 and {MAX_EXEC_TIMEOUT_SECS} seconds");
        }
        if script.len() > MAX_SCRIPT_BYTES {
            bail!("Box command script exceeds {MAX_SCRIPT_BYTES} bytes");
        }
        let http_timeout = self
            .timeout
            .max(Duration::from_secs(timeout_secs) + EXEC_HTTP_HEADROOM);
        let value = self
            .request(
                reqwest::Method::POST,
                &format!("/boxes/{}/commands", id.0),
                Some(json!({
                    "command": "sh",
                    "args": ["-s"],
                    "stdin": script,
                    "cwd": ".",
                    "env": env_object(env),
                    "user": user.wire_name(),
                    "timeoutSeconds": timeout_secs,
                })),
                None,
                Some(http_timeout),
            )
            .await?;
        let result_value = value.get("result").cloned().unwrap_or(value);
        let result: ScriptResult = serde_json::from_value(result_value)
            .map_err(|error| anyhow!("Box command result was invalid: {error}"))?;
        Ok(ExecOutput {
            exit_code: result
                .exit_code
                .ok_or_else(|| anyhow!("Box command response did not contain exitCode"))?,
            stdout: result.stdout.into_bytes(),
            stderr: result.stderr.into_bytes(),
        })
    }

    /// Queue a managed CLI prompt run.
    pub async fn start_prompt(
        &self,
        id: &WorkspaceId,
        spec: &ManagedPromptSpec,
    ) -> Result<PromptRunView> {
        validate_box_id(&id.0)?;
        validate_prompt_spec(spec)?;
        let value = self
            .request(
                reqwest::Method::POST,
                &format!("/boxes/{}/prompt", id.0),
                Some(json!({
                    "provider": spec.provider.wire_name(),
                    "text": spec.text,
                    "execution": "managed",
                    "cwd": spec.cwd,
                    "env": env_object(&spec.env),
                    "timeoutSeconds": spec.timeout_secs,
                })),
                None,
                None,
            )
            .await?;
        parse_run(value)
    }

    /// Read one prompt run.
    pub async fn prompt_run(&self, id: &WorkspaceId, run_id: &str) -> Result<PromptRunView> {
        validate_box_id(&id.0)?;
        validate_run_id(run_id)?;
        let value = self
            .request(
                reqwest::Method::GET,
                &format!("/boxes/{}/prompts/{run_id}", id.0),
                None,
                None,
                None,
            )
            .await?;
        parse_run(value)
    }

    /// Cancel a managed prompt run (idempotent for terminal runs).
    pub async fn cancel_prompt(&self, id: &WorkspaceId, run_id: &str) -> Result<PromptRunView> {
        validate_box_id(&id.0)?;
        validate_run_id(run_id)?;
        let value = self
            .request(
                reqwest::Method::POST,
                &format!("/boxes/{}/prompts/{run_id}/cancel", id.0),
                None,
                None,
                None,
            )
            .await?;
        parse_run(value)
    }

    /// Read process output chunks after `after_seq`.
    pub async fn process_output_after(
        &self,
        id: &WorkspaceId,
        process_id: &str,
        after_seq: u64,
    ) -> Result<ProcessOutputPage> {
        validate_box_id(&id.0)?;
        validate_run_id(process_id)?;
        let value = self
            .request(
                reqwest::Method::GET,
                &format!(
                    "/boxes/{}/processes/{process_id}/logs?after={after_seq}",
                    id.0
                ),
                None,
                None,
                None,
            )
            .await?;
        let logs: LogsResponse = serde_json::from_value(value)
            .map_err(|error| anyhow!("Box process logs response was invalid: {error}"))?;
        let exited = logs
            .process
            .and_then(|process| process.status)
            .is_some_and(|status| status != "running");
        Ok(ProcessOutputPage {
            chunks: logs
                .chunks
                .into_iter()
                .map(|chunk| OutputChunk {
                    seq: chunk.seq,
                    stream: chunk.stream,
                    data: chunk.data,
                })
                .collect(),
            exited,
        })
    }

    /// Interrupt every active process (and managed prompt run) in a Box.
    pub async fn interrupt(&self, id: &WorkspaceId) -> Result<()> {
        validate_box_id(&id.0)?;
        self.request(
            reqwest::Method::POST,
            &format!("/boxes/{}/interrupt", id.0),
            None,
            None,
            None,
        )
        .await?;
        Ok(())
    }

    /// Destroy a Box. An already-missing Box (404) is success.
    pub async fn destroy(&self, id: &WorkspaceId) -> Result<()> {
        validate_box_id(&id.0)?;
        let response = self
            .http
            .delete(format!("{}/boxes/{}", self.base, id.0))
            .header(reqwest::header::AUTHORIZATION, self.authorization()?)
            .header("X-Ascii-Confirm-Delete", &id.0)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|error| anyhow!("Box destroy request failed: {}", error.without_url()))?;
        let status = response.status();
        if status.is_success() || status.as_u16() == 404 {
            return Ok(());
        }
        let detail = crate::capture::response_text(response).await?;
        Err(anyhow!(
            "Box destroy returned HTTP {status}: {}",
            detail.chars().take(ERROR_DETAIL_CHARS).collect::<String>()
        ))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptResult {
    #[serde(default)]
    exit_code: Option<i32>,
    #[serde(default)]
    stderr: String,
    #[serde(default)]
    stdout: String,
}

#[derive(Debug, Deserialize)]
struct LogsResponse {
    #[serde(default)]
    chunks: Vec<LogChunk>,
    #[serde(default)]
    process: Option<LogProcess>,
}

#[derive(Debug, Deserialize)]
struct LogChunk {
    seq: u64,
    stream: String,
    data: String,
}

#[derive(Debug, Deserialize)]
struct LogProcess {
    #[serde(default)]
    status: Option<String>,
}

fn env_object(env: &[(String, String)]) -> Value {
    let map: Map<String, Value> = env
        .iter()
        .map(|(name, value)| (name.clone(), Value::String(value.clone())))
        .collect();
    Value::Object(map)
}

fn parse_run(value: Value) -> Result<PromptRunView> {
    let run = value
        .get("run")
        .cloned()
        .ok_or_else(|| anyhow!("Box prompt response did not contain run"))?;
    serde_json::from_value(run).map_err(|error| anyhow!("Box prompt run was invalid: {error}"))
}

/// Run and process ids: `[A-Za-z0-9_-]{1,128}`.
pub(super) fn validate_run_id(id: &str) -> Result<()> {
    let valid = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if valid {
        Ok(())
    } else {
        bail!("invalid Box run id")
    }
}

fn validate_prompt_spec(spec: &ManagedPromptSpec) -> Result<()> {
    let chars = spec.text.chars().count();
    if chars == 0 || chars > MAX_PROMPT_CHARS {
        bail!("Box prompt text must be 1 to {MAX_PROMPT_CHARS} characters");
    }
    if !(MIN_PROMPT_TIMEOUT_SECS..=MAX_PROMPT_TIMEOUT_SECS).contains(&spec.timeout_secs) {
        bail!(
            "Box prompt timeout must be between {MIN_PROMPT_TIMEOUT_SECS} and {MAX_PROMPT_TIMEOUT_SECS} seconds"
        );
    }
    let cwd = spec.cwd.as_str();
    let cwd_valid = cwd.chars().count() <= MAX_CWD_CHARS
        && !cwd.starts_with('/')
        && !cwd.starts_with('\\')
        && !cwd.split(['/', '\\']).any(|segment| segment == "..");
    if !cwd_valid {
        bail!("Box prompt cwd must be a relative path inside the workspace");
    }
    Ok(())
}

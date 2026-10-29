//! Provider clients for password-manager accounts.
//!
//! * `1password-connect`: a 1Password Connect server over REST through the
//!   SSRF-guarded client in [`crate::vault::external::net`]:
//!   `GET /v1/vaults?filter=name eq "<vault>"`,
//!   `GET /v1/vaults/{id}/items?filter=title eq "<item>"`, and
//!   `GET /v1/vaults/{id}/items/{id}`, with `Authorization: Bearer <token>`.
//! * `1password-service-account`: the `op` CLI, `op read --no-newline <ref>`,
//!   with `OP_SERVICE_ACCOUNT_TOKEN` in the child's environment only.
//! * `bitwarden-sm`: the `bws` CLI, `bws secret get <uuid> --output json`,
//!   with `BWS_ACCESS_TOKEN` (and `BWS_SERVER_URL` when the account has a
//!   server URL) in the child's environment only.
//!
//! A CLI child gets a cleared environment plus a short pass-through list
//! ([`PASSTHROUGH_ENV`]) and the token; the token never appears in argv. The
//! child runs with a strict timeout and is killed when it overruns; stdout and
//! stderr are read through a [`MAX_CLI_OUTPUT`] bound, and a child that writes
//! more is killed instead of buffered. Errors are
//! classified (authentication, not found, unavailable) and never echo the
//! child's output, which could contain a value.

use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;

use super::{AccountRecord, PmRef, ProviderKind, Secret};
use crate::vault::external::net;

/// How long one CLI invocation may run.
pub const CLI_TIMEOUT: Duration = Duration::from_secs(20);
/// Largest CLI output accepted, per stream.
pub const MAX_CLI_OUTPUT: usize = 1024 * 1024;
/// Parent environment variables a provider CLI inherits (everything else is
/// cleared).
pub const PASSTHROUGH_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "TMPDIR",
    "TEMP",
    "TMP",
    "XDG_CONFIG_HOME",
    "LANG",
    // Windows: Go's `os.UserConfigDir` (used by `op`) needs `%AppData%`.
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
];
/// 1Password service-account token variable read by `op`.
pub const OP_TOKEN_ENV: &str = "OP_SERVICE_ACCOUNT_TOKEN";
/// Bitwarden Secrets Manager access-token variable read by `bws`.
pub const BWS_TOKEN_ENV: &str = "BWS_ACCESS_TOKEN";
/// Bitwarden Secrets Manager server URL variable read by `bws`.
pub const BWS_SERVER_ENV: &str = "BWS_SERVER_URL";

/// Why a provider call failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// The provider refused the account token; the account needs a new one.
    Auth,
    /// The referenced vault, item, field, or secret does not exist.
    NotFound,
    /// The provider could not be reached or answered unexpectedly.
    Unavailable,
}

/// A sanitized provider failure: never carries a value, a token, or raw
/// provider output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderFailure {
    pub kind: FailureKind,
    pub message: String,
}

impl std::fmt::Display for ProviderFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProviderFailure {}

fn failure(kind: FailureKind, message: impl Into<String>) -> ProviderFailure {
    ProviderFailure {
        kind,
        message: message.into(),
    }
}

/// Fetch the value `reference` names.
pub async fn fetch(
    account: &AccountRecord,
    token: &Secret,
    reference: &PmRef,
) -> Result<Secret, ProviderFailure> {
    match account.provider {
        ProviderKind::OnePasswordConnect => connect_fetch(account, token, reference).await,
        ProviderKind::OnePasswordServiceAccount => {
            let provider_ref = reference.provider_ref();
            let output = run_cli(
                account,
                &["read", "--no-newline", &provider_ref],
                &[(OP_TOKEN_ENV, token.expose())],
            )
            .await?;
            if std::str::from_utf8(output.as_bytes()).is_err() {
                return Err(failure(
                    FailureKind::Unavailable,
                    "`op read` returned non-UTF-8 output",
                ));
            }
            Ok(output)
        }
        ProviderKind::BitwardenSm => {
            let id = reference.provider_ref();
            let output = run_cli(
                account,
                &["secret", "get", &id, "--output", "json"],
                &bws_env(account, token),
            )
            .await?;
            let parsed: Value = serde_json::from_slice(output.as_bytes()).map_err(|_| {
                failure(
                    FailureKind::Unavailable,
                    "`bws secret get` did not return JSON",
                )
            })?;
            match parsed.get("value").and_then(Value::as_str) {
                Some(value) => Ok(Secret::new(value.to_owned())),
                None => Err(failure(
                    FailureKind::Unavailable,
                    "`bws secret get` returned no value",
                )),
            }
        }
    }
}

/// Check the account's connectivity and token without reading a value.
pub async fn check(account: &AccountRecord, token: &Secret) -> Result<(), ProviderFailure> {
    match account.provider {
        ProviderKind::OnePasswordConnect => {
            let session = ConnectSession::open(account, token).await?;
            let vaults = session.get(&["v1", "vaults"], None).await?;
            if vaults.is_array() {
                Ok(())
            } else {
                Err(failure(
                    FailureKind::Unavailable,
                    "the Connect server returned an unexpected vault list",
                ))
            }
        }
        ProviderKind::OnePasswordServiceAccount => run_cli(
            account,
            &["vault", "list", "--format", "json"],
            &[(OP_TOKEN_ENV, token.expose())],
        )
        .await
        .map(drop),
        ProviderKind::BitwardenSm => run_cli(
            account,
            &["project", "list", "--output", "json"],
            &bws_env(account, token),
        )
        .await
        .map(drop),
    }
}

fn bws_env<'a>(account: &'a AccountRecord, token: &'a Secret) -> Vec<(&'static str, &'a str)> {
    let mut env = vec![(BWS_TOKEN_ENV, token.expose())];
    if let Some(address) = account.address.as_deref() {
        env.push((BWS_SERVER_ENV, address));
    }
    env
}

// ── CLI ───────────────────────────────────────────────────────────────────

fn cli_name(account: &AccountRecord) -> &'static str {
    match account.provider {
        ProviderKind::BitwardenSm => "bws",
        _ => "op",
    }
}

/// Classify a failed CLI run from its stderr without echoing it.
fn classify_cli_error(stderr: &[u8]) -> FailureKind {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    const AUTH: &[&str] = &[
        "unauthorized",
        "unauthenticated",
        "authentication",
        "not authorized",
        "invalid token",
        "token is invalid",
        "invalid access token",
        "access token",
        "expired",
        "forbidden",
        "401",
        "403",
    ];
    const NOT_FOUND: &[&str] = &[
        "not found",
        "isn't an item",
        "isn't a vault",
        "isn't a field",
        "no item",
        "could not find",
        "resource not found",
        "404",
    ];
    if NOT_FOUND.iter().any(|needle| text.contains(needle)) {
        FailureKind::NotFound
    } else if AUTH.iter().any(|needle| text.contains(needle)) {
        FailureKind::Auth
    } else {
        FailureKind::Unavailable
    }
}

/// Run the account's provider CLI with a cleared environment plus `env`.
/// Returns stdout; never returns or logs stderr.
async fn run_cli(
    account: &AccountRecord,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<Secret, ProviderFailure> {
    let name = cli_name(account);
    let Some(binary) = account.binary_path.as_deref() else {
        return Err(failure(
            FailureKind::Unavailable,
            format!("the account has no `{name}` binary configured"),
        ));
    };
    let mut command = tokio::process::Command::new(binary);
    command.args(args).env_clear();
    for key in PASSTHROUGH_ENV {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    for (key, value) in env {
        command.env(key, value);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| {
        failure(
            FailureKind::Unavailable,
            format!("the `{name}` CLI could not be started"),
        )
    })?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let collected = async {
        // A reader that hits the bound drops its pipe, so a child still
        // writing gets EPIPE instead of blocking; it is killed below.
        let (stdout, stderr) = tokio::join!(read_bounded(stdout_pipe), read_bounded(stderr_pipe));
        let overflowed = stdout.as_ref().is_ok_and(|out| out.len() > MAX_CLI_OUTPUT)
            || stderr.as_ref().is_ok_and(|err| err.len() > MAX_CLI_OUTPUT);
        if overflowed {
            let _ = child.start_kill();
        }
        let status = child.wait().await;
        match (stdout, stderr, status) {
            (Ok(stdout), Ok(stderr), Ok(status)) => Ok((
                std::process::Output {
                    status,
                    stdout,
                    stderr,
                },
                overflowed,
            )),
            (stdout, stderr, _) => {
                for mut buffer in [stdout, stderr].into_iter().flatten() {
                    super::wipe(&mut buffer);
                }
                Err(())
            }
        }
    };
    let output = match tokio::time::timeout(CLI_TIMEOUT, collected).await {
        Ok(Ok((mut output, true))) => {
            super::wipe(&mut output.stdout);
            super::wipe(&mut output.stderr);
            return Err(failure(
                FailureKind::Unavailable,
                format!("`{name}` output is too large"),
            ));
        }
        Ok(Ok((output, false))) => output,
        Ok(Err(())) => {
            return Err(failure(
                FailureKind::Unavailable,
                format!("the `{name}` CLI failed to run"),
            ))
        }
        Err(_) => {
            return Err(failure(
                FailureKind::Unavailable,
                format!(
                    "the `{name}` CLI timed out after {}s",
                    CLI_TIMEOUT.as_secs()
                ),
            ))
        }
    };
    let mut stderr = output.stderr;
    let stdout = Secret::from_bytes(output.stdout);
    if !output.status.success() {
        let kind = classify_cli_error(&stderr);
        super::wipe(&mut stderr);
        let code = output
            .status
            .code()
            .map_or_else(|| "a signal".to_owned(), |code| format!("status {code}"));
        let message = match kind {
            FailureKind::Auth => {
                format!("`{name}` rejected the account token (exited with {code})")
            }
            FailureKind::NotFound => {
                format!("`{name}` could not find the reference (exited with {code})")
            }
            FailureKind::Unavailable => format!("`{name}` exited with {code}"),
        };
        return Err(failure(kind, message));
    }
    super::wipe(&mut stderr);
    if stdout.as_bytes().len() > MAX_CLI_OUTPUT {
        return Err(failure(
            FailureKind::Unavailable,
            format!("`{name}` output is too large"),
        ));
    }
    Ok(stdout)
}

/// Read a child pipe up to one byte past [`MAX_CLI_OUTPUT`] (so an overrun
/// is detectable), then drop the pipe.
async fn read_bounded<R>(pipe: Option<R>) -> std::io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt as _;
    let mut buffer = Vec::new();
    if let Some(pipe) = pipe {
        let limit = u64::try_from(MAX_CLI_OUTPUT + 1).unwrap_or(u64::MAX);
        if let Err(error) = pipe.take(limit).read_to_end(&mut buffer).await {
            super::wipe(&mut buffer);
            return Err(error);
        }
    }
    Ok(buffer)
}

// ── 1Password Connect ─────────────────────────────────────────────────────

struct ConnectSession<'a> {
    base: url::Url,
    http: reqwest::Client,
    token: &'a Secret,
}

/// A 1Password object id (26 lowercase base32 characters).
fn is_op_id(text: &str) -> bool {
    text.len() == 26
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

impl<'a> ConnectSession<'a> {
    async fn open(account: &AccountRecord, token: &'a Secret) -> Result<Self, ProviderFailure> {
        let address = account.address.as_deref().ok_or_else(|| {
            failure(
                FailureKind::Unavailable,
                "the account has no Connect address",
            )
        })?;
        let egress = net::Egress::from_env();
        let base = net::validate_address(address, egress)
            .map_err(|error| failure(FailureKind::Unavailable, format!("{error:#}")))?;
        let http = net::guarded_client(&base, egress)
            .await
            .map_err(|error| failure(FailureKind::Unavailable, format!("{error:#}")))?;
        Ok(Self { base, http, token })
    }

    async fn get(
        &self,
        segments: &[&str],
        filter: Option<String>,
    ) -> Result<Value, ProviderFailure> {
        let mut url = self.base.clone();
        {
            let mut path = url.path_segments_mut().map_err(|()| {
                failure(
                    FailureKind::Unavailable,
                    "the Connect address cannot carry a path",
                )
            })?;
            path.pop_if_empty();
            for segment in segments {
                path.push(segment);
            }
        }
        if let Some(filter) = filter {
            url.query_pairs_mut().append_pair("filter", &filter);
        }
        let response = self
            .http
            .get(url)
            .bearer_auth(self.token.expose())
            .send()
            .await
            .map_err(|_| {
                failure(
                    FailureKind::Unavailable,
                    "the Connect server is unreachable",
                )
            })?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(failure(
                FailureKind::Auth,
                format!("the Connect server rejected the account token ({status})"),
            ));
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(failure(
                FailureKind::NotFound,
                "the Connect server has no such vault or item",
            ));
        }
        if !status.is_success() {
            return Err(failure(
                FailureKind::Unavailable,
                format!("the Connect server answered {status}"),
            ));
        }
        net::read_json(response)
            .await
            .map_err(|error| failure(FailureKind::Unavailable, format!("{error:#}")))
    }

    /// The id of the one object in `list` whose `field` equals `wanted`.
    fn pick(
        list: &Value,
        field: &str,
        wanted: &str,
        what: &str,
    ) -> Result<Option<String>, ProviderFailure> {
        let matches: Vec<&str> = list
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item.get(field).and_then(Value::as_str) == Some(wanted))
                    .filter_map(|item| item.get("id").and_then(Value::as_str))
                    .collect()
            })
            .unwrap_or_default();
        match matches.as_slice() {
            [] => Ok(None),
            [one] => Ok(Some((*one).to_owned())),
            _ => Err(failure(
                FailureKind::NotFound,
                format!("several {what}s are named `{wanted}`; use its id"),
            )),
        }
    }

    async fn vault_id(&self, vault: &str) -> Result<String, ProviderFailure> {
        let list = self
            .get(&["v1", "vaults"], Some(format!("name eq \"{vault}\"")))
            .await?;
        match Self::pick(&list, "name", vault, "vault")? {
            Some(id) => Ok(id),
            None if is_op_id(vault) => Ok(vault.to_owned()),
            None => Err(failure(
                FailureKind::NotFound,
                format!("no vault named `{vault}` is shared with the Connect server"),
            )),
        }
    }

    async fn item_id(&self, vault_id: &str, item: &str) -> Result<String, ProviderFailure> {
        let list = self
            .get(
                &["v1", "vaults", vault_id, "items"],
                Some(format!("title eq \"{item}\"")),
            )
            .await?;
        match Self::pick(&list, "title", item, "item")? {
            Some(id) => Ok(id),
            None if is_op_id(item) => Ok(item.to_owned()),
            None => Err(failure(
                FailureKind::NotFound,
                format!("no item titled `{item}` in that vault"),
            )),
        }
    }
}

/// The value of the field a Connect item holds for `(section, field)`. A
/// field matches by label or id; a section by label or id.
fn connect_field(
    item: &Value,
    section: Option<&str>,
    field: &str,
) -> Result<String, ProviderFailure> {
    let section_ids: Option<Vec<String>> = section.map(|wanted| {
        item.get("sections")
            .and_then(Value::as_array)
            .map(|sections| {
                sections
                    .iter()
                    .filter(|s| {
                        s.get("label").and_then(Value::as_str) == Some(wanted)
                            || s.get("id").and_then(Value::as_str) == Some(wanted)
                    })
                    .filter_map(|s| s.get("id").and_then(Value::as_str).map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    });
    let fields = item
        .get("fields")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let matches: Vec<&Value> = fields
        .iter()
        .filter(|f| {
            f.get("label").and_then(Value::as_str) == Some(field)
                || f.get("id").and_then(Value::as_str) == Some(field)
        })
        .filter(|f| match &section_ids {
            None => true,
            Some(ids) => f
                .get("section")
                .and_then(|s| s.get("id"))
                .and_then(Value::as_str)
                .is_some_and(|id| ids.iter().any(|wanted| wanted == id)),
        })
        .collect();
    match matches.as_slice() {
        [one] => one
            .get("value")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| failure(FailureKind::NotFound, format!("field `{field}` is empty"))),
        [] => Err(failure(
            FailureKind::NotFound,
            format!("the item has no field `{field}`"),
        )),
        _ => Err(failure(
            FailureKind::NotFound,
            format!("several fields match `{field}`; name the section"),
        )),
    }
}

async fn connect_fetch(
    account: &AccountRecord,
    token: &Secret,
    reference: &PmRef,
) -> Result<Secret, ProviderFailure> {
    let (vault, item, section, field) = reference
        .op_parts()
        .ok_or_else(|| failure(FailureKind::NotFound, "not a 1Password reference"))?;
    let session = ConnectSession::open(account, token).await?;
    let vault_id = session.vault_id(vault).await?;
    let item_id = session.item_id(&vault_id, item).await?;
    let mut body = session
        .get(&["v1", "vaults", &vault_id, "items", &item_id], None)
        .await?;
    let value = connect_field(&body, section, field);
    // Drop every other field's value from memory as soon as possible.
    if let Some(fields) = body.get_mut("fields").and_then(Value::as_array_mut) {
        for f in fields.iter_mut() {
            if let Some(Value::String(text)) = f.get_mut("value") {
                super::wipe_string(text);
            }
        }
    }
    value.map(Secret::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cli_errors_are_classified_without_echoing_output() {
        assert_eq!(
            classify_cli_error(b"[ERROR] 401: Unauthorized: invalid token"),
            FailureKind::Auth
        );
        assert_eq!(
            classify_cli_error(b"\"nope\" isn't an item in the \"dev\" vault"),
            FailureKind::NotFound
        );
        assert_eq!(
            classify_cli_error(b"connection refused"),
            FailureKind::Unavailable
        );
    }

    #[test]
    fn connect_fields_match_by_label_or_id_and_section() {
        let item = json!({
            "sections": [{ "id": "s1", "label": "prod" }, { "id": "s2", "label": "dev" }],
            "fields": [
                { "id": "password", "label": "password", "value": "top" },
                { "id": "f1", "label": "key", "value": "prod-key", "section": { "id": "s1" } },
                { "id": "f2", "label": "key", "value": "dev-key", "section": { "id": "s2" } },
                { "id": "f3", "label": "blank", "value": "" },
            ],
        });
        assert_eq!(connect_field(&item, None, "password").unwrap(), "top");
        assert_eq!(
            connect_field(&item, Some("prod"), "key").unwrap(),
            "prod-key"
        );
        assert_eq!(connect_field(&item, Some("s2"), "f2").unwrap(), "dev-key");
        assert_eq!(
            connect_field(&item, None, "key").unwrap_err().kind,
            FailureKind::NotFound
        );
        assert!(connect_field(&item, None, "blank").is_err());
        assert!(connect_field(&item, None, "missing").is_err());
    }

    #[test]
    fn op_ids_are_recognized() {
        assert!(is_op_id("abcdefghijklmnopqrstuvwxyz"));
        assert!(!is_op_id("Production"));
    }
}

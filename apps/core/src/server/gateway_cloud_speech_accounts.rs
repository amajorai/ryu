//! Protected editor for explicitly supplied Google TTS and Polly credentials.

use axum::{
    extract::{Json, State},
    http::StatusCode,
    Extension,
};
use ryu_gw_credentials::{
    ConfigCommitError, ConfigFileTransaction, ConfigRevision, ProviderAccountPolicy,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::ServerState;

#[derive(Clone, Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields)]
struct GoogleConfig {
    accounts: Vec<GoogleAccount>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct GoogleAccount {
    access_token: String,
    quota_project: String,
    #[serde(default)]
    expires_at_unix_secs: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PollyConfig {
    region: String,
    accounts: Vec<PollyAccount>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PollyAccount {
    access_key_id: String,
    secret_access_key: String,
    #[serde(default)]
    session_token: Option<String>,
    #[serde(default)]
    expires_at_unix_secs: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Action {
    Add,
    Configure,
    Remove,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CloudSpeechWrite {
    action: Action,
    provider: String,
    expected_revision: ConfigRevision,
    account_id: Option<String>,
    account_policy: Option<ProviderAccountPolicy>,
    access_token: Option<String>,
    quota_project: Option<String>,
    access_key_id: Option<String>,
    secret_access_key: Option<String>,
    session_token: Option<String>,
    expires_at_unix_secs: Option<u64>,
    region: Option<String>,
}

fn failure(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({"success":false,"error":message.into()})),
    )
}

fn account_id_google(row: &GoogleAccount) -> String {
    let mut digest = Sha256::new();
    digest.update(b"ryu:google-tts:supplied-oauth:v1\0");
    digest.update((row.access_token.len() as u64).to_be_bytes());
    digest.update(row.access_token.as_bytes());
    digest.update(row.quota_project.as_bytes());
    format!("{:x}", digest.finalize())
}

fn account_id_polly(region: &str, row: &PollyAccount) -> String {
    let mut digest = Sha256::new();
    digest.update(b"ryu:polly:explicit:v1\0");
    for value in [
        region,
        &row.access_key_id,
        &row.secret_access_key,
        row.session_token.as_deref().unwrap_or(""),
    ] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn google_account(body: &CloudSpeechWrite) -> Result<GoogleAccount, String> {
    let token = body
        .access_token
        .as_deref()
        .ok_or("accessToken is required")?;
    if token.is_empty()
        || token.len() > 8192
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~+/=".contains(&byte))
    {
        return Err("supplied OAuth token is invalid".into());
    }
    let project = body
        .quota_project
        .as_deref()
        .ok_or("quotaProject is required")?
        .trim();
    let project_id = (6..=30).contains(&project.len())
        && project
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_lowercase)
        && project
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && project
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    let project_number = !project.is_empty()
        && project.len() <= 20
        && project.bytes().all(|byte| byte.is_ascii_digit());
    if !project_id && !project_number {
        return Err("quota project is invalid".into());
    }
    Ok(GoogleAccount {
        access_token: token.to_owned(),
        quota_project: project.to_owned(),
        expires_at_unix_secs: body.expires_at_unix_secs,
    })
}

fn polly_account(body: &CloudSpeechWrite) -> Result<PollyAccount, String> {
    let key = body
        .access_key_id
        .as_deref()
        .ok_or("accessKeyId is required")?;
    let secret = body
        .secret_access_key
        .as_deref()
        .ok_or("secretAccessKey is required")?;
    let session = body
        .session_token
        .as_deref()
        .filter(|value| !value.is_empty());
    if !(16..=128).contains(&key.len())
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        || !(16..=128).contains(&secret.len())
        || !secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/+=_-".contains(&byte))
        || session.is_some_and(|value| {
            value.len() > 16384
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"/+=_.-".contains(&byte))
        })
    {
        return Err("explicit AWS credentials are invalid".into());
    }
    Ok(PollyAccount {
        access_key_id: key.to_owned(),
        secret_access_key: secret.to_owned(),
        session_token: session.map(str::to_owned),
        expires_at_unix_secs: body.expires_at_unix_secs,
    })
}

fn valid_region(region: &str) -> bool {
    matches!(
        region,
        "us-east-1"
            | "us-east-2"
            | "us-west-1"
            | "us-west-2"
            | "af-south-1"
            | "ap-east-1"
            | "ap-southeast-5"
            | "ap-south-1"
            | "ap-northeast-3"
            | "ap-northeast-2"
            | "ap-southeast-1"
            | "ap-southeast-2"
            | "ap-southeast-7"
            | "ap-northeast-1"
            | "ca-central-1"
            | "eu-central-1"
            | "eu-west-1"
            | "eu-west-2"
            | "eu-west-3"
            | "eu-south-2"
            | "eu-north-1"
            | "eu-central-2"
            | "me-south-1"
            | "sa-east-1"
    )
}

fn read_config<T: for<'de> Deserialize<'de>>(
    providers: &toml::map::Map<String, toml::Value>,
    name: &str,
) -> Result<Option<T>, String> {
    providers
        .get(name)
        .map(|value| {
            value
                .clone()
                .try_into()
                .map_err(|_| format!("{name} configuration is invalid"))
        })
        .transpose()
}

fn providers(root: &toml::Value) -> Result<toml::map::Map<String, toml::Value>, String> {
    Ok(root
        .get("providers")
        .map(|value| value.as_table().cloned().ok_or("providers must be a table"))
        .transpose()?
        .unwrap_or_default())
}

fn view(root: &toml::Value, revision: &ConfigRevision) -> Result<Value, String> {
    let providers = providers(root)?;
    let google = read_config::<GoogleConfig>(&providers, "google_tts")?;
    let polly = read_config::<PollyConfig>(&providers, "polly")?;
    Ok(json!({
        "cloudSpeechAccountsSchema": 1,
        "configRevision": revision,
        "googleTts": google.as_ref().map(|config| config.accounts.iter().map(|row| {
            let id = account_id_google(row);
            json!({
                "accountId": id, "quotaProject": row.quota_project,
                "expiresAtUnixSecs": row.expires_at_unix_secs,
                "policy": policy_for(&providers, "google-tts", &id),
            })
        }).collect::<Vec<_>>()).unwrap_or_default(),
        "polly": {"region": polly.as_ref().map(|config| config.region.as_str()).unwrap_or("us-east-1"),
            "accounts": polly.as_ref().map(|config| config.accounts.iter().map(|row| {
                let id = account_id_polly(&config.region, row);
                json!({
                    "accountId": id,
                    "accessKeyHint": row.access_key_id.chars().take(4).collect::<String>(),
                    "hasSessionToken": row.session_token.is_some(),
                    "expiresAtUnixSecs": row.expires_at_unix_secs,
                    "policy": policy_for(&providers, "polly", &id),
                })
            }).collect::<Vec<_>>()).unwrap_or_default()},
    }))
}

fn policy_for(
    providers: &toml::map::Map<String, toml::Value>,
    provider: &str,
    id: &str,
) -> ProviderAccountPolicy {
    providers
        .get("accountPolicies")
        .and_then(toml::Value::as_table)
        .and_then(|table| table.get(provider))
        .and_then(toml::Value::as_table)
        .and_then(|rows| rows.get(id))
        .cloned()
        .and_then(|value| value.try_into().ok())
        .unwrap_or_default()
}

fn set_policy(
    providers: &mut toml::map::Map<String, toml::Value>,
    provider: &str,
    id: &str,
    policy: ProviderAccountPolicy,
) -> Result<(), String> {
    let policy = policy.normalized()?;
    let rows = providers
        .entry("accountPolicies".to_owned())
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or("accountPolicies must be a table")?
        .entry(provider.to_owned())
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or("provider account policies must be a table")?;
    rows.insert(
        id.to_owned(),
        toml::Value::try_from(policy).map_err(|_| "account policy could not be encoded")?,
    );
    Ok(())
}

fn remove_policy(providers: &mut toml::map::Map<String, toml::Value>, provider: &str, id: &str) {
    if let Some(rows) = providers
        .get_mut("accountPolicies")
        .and_then(toml::Value::as_table_mut)
        .and_then(|table| table.get_mut(provider))
        .and_then(toml::Value::as_table_mut)
    {
        rows.remove(id);
    }
}

fn mutate(root: &mut toml::Value, body: &CloudSpeechWrite) -> Result<(), String> {
    let table = root
        .as_table_mut()
        .ok_or("gateway configuration root must be a table")?;
    let providers = table
        .entry("providers")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or("providers must be a table")?;
    match body.provider.as_str() {
        "google-tts" => {
            let mut config =
                read_config::<GoogleConfig>(providers, "google_tts")?.unwrap_or_default();
            match body.action {
                Action::Add => {
                    let row = google_account(body)?;
                    let id = account_id_google(&row);
                    if config
                        .accounts
                        .iter()
                        .any(|existing| account_id_google(existing) == id)
                    {
                        return Err("account already exists".into());
                    }
                    config.accounts.push(row);
                }
                Action::Configure => {
                    let id = body.account_id.as_deref().ok_or("accountId is required")?;
                    if !config
                        .accounts
                        .iter()
                        .any(|row| account_id_google(row) == id)
                    {
                        return Err("account no longer exists; refresh the account list".into());
                    }
                    let policy = body
                        .account_policy
                        .clone()
                        .ok_or("accountPolicy is required")?;
                    set_policy(providers, "google-tts", id, policy)?;
                }
                Action::Remove => {
                    let id = body.account_id.as_deref().ok_or("accountId is required")?;
                    let index = config
                        .accounts
                        .iter()
                        .position(|row| account_id_google(row) == id)
                        .ok_or("account no longer exists; refresh the account list")?;
                    config.accounts.remove(index);
                    remove_policy(providers, "google-tts", id);
                }
            }
            if config.accounts.is_empty() {
                providers.remove("google_tts");
            } else {
                providers.insert(
                    "google_tts".into(),
                    toml::Value::try_from(config)
                        .map_err(|_| "Google accounts could not be encoded")?,
                );
            }
        }
        "polly" => {
            let existing = read_config::<PollyConfig>(providers, "polly")?;
            let region = body
                .region
                .as_deref()
                .or_else(|| existing.as_ref().map(|config| config.region.as_str()))
                .unwrap_or("us-east-1")
                .to_owned();
            if !valid_region(&region) {
                return Err("Polly region is unsupported".into());
            }
            if let Some(config) = &existing {
                if !config.accounts.is_empty() && config.region != region {
                    return Err("remove existing Polly accounts before changing region".into());
                }
            }
            let mut config = existing.unwrap_or_else(|| PollyConfig {
                region: region.clone(),
                accounts: Vec::new(),
            });
            config.region = region;
            match body.action {
                Action::Add => {
                    let row = polly_account(body)?;
                    let id = account_id_polly(&config.region, &row);
                    if config
                        .accounts
                        .iter()
                        .any(|existing| account_id_polly(&config.region, existing) == id)
                    {
                        return Err("account already exists".into());
                    }
                    config.accounts.push(row);
                }
                Action::Configure => {
                    let id = body.account_id.as_deref().ok_or("accountId is required")?;
                    if !config
                        .accounts
                        .iter()
                        .any(|row| account_id_polly(&config.region, row) == id)
                    {
                        return Err("account no longer exists; refresh the account list".into());
                    }
                    let policy = body
                        .account_policy
                        .clone()
                        .ok_or("accountPolicy is required")?;
                    set_policy(providers, "polly", id, policy)?;
                }
                Action::Remove => {
                    let id = body.account_id.as_deref().ok_or("accountId is required")?;
                    let index = config
                        .accounts
                        .iter()
                        .position(|row| account_id_polly(&config.region, row) == id)
                        .ok_or("account no longer exists; refresh the account list")?;
                    config.accounts.remove(index);
                    remove_policy(providers, "polly", id);
                }
            }
            if config.accounts.is_empty() {
                providers.remove("polly");
            } else {
                providers.insert(
                    "polly".into(),
                    toml::Value::try_from(config)
                        .map_err(|_| "Polly accounts could not be encoded")?,
                );
            }
        }
        _ => return Err("unsupported cloud speech provider".into()),
    }
    Ok(())
}

pub(super) async fn get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> (StatusCode, Json<Value>) {
    if super::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::GATEWAY_VIEW,
    )
    .await
    .is_err()
    {
        return failure(
            StatusCode::FORBIDDEN,
            "insufficient permissions: gateway.view",
        );
    }
    let Some(path) = super::gateway_config_path() else {
        return failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine gateway config path",
        );
    };
    let result = tokio::task::spawn_blocking(move || {
        let transaction = ConfigFileTransaction::acquire(&path)?;
        let root = super::gateway_config_document(&transaction)
            .map_err(|_| ConfigCommitError::InvalidFile)?;
        Ok::<_, ConfigCommitError>((transaction.snapshot().revision().clone(), root))
    })
    .await;
    let Ok(Ok((revision, root))) = result else {
        return failure(
            StatusCode::BAD_GATEWAY,
            "gateway configuration is unavailable",
        );
    };
    match view(&root, &revision) {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(error) => failure(StatusCode::BAD_REQUEST, error),
    }
}

pub(super) async fn put(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<CloudSpeechWrite>,
) -> (StatusCode, Json<Value>) {
    if super::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .is_err()
    {
        return failure(
            StatusCode::FORBIDDEN,
            "insufficient permissions: gateway.configure",
        );
    }
    let Some(path) = super::gateway_config_path() else {
        return failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine gateway config path",
        );
    };
    let mut transaction =
        match tokio::task::spawn_blocking(move || ConfigFileTransaction::acquire(&path)).await {
            Ok(Ok(transaction)) => transaction,
            Ok(Err(error)) => return super::gateway_config_transaction_error(error),
            Err(_) => {
                return failure(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "gateway configuration transaction could not start",
                );
            }
        };
    let revision = transaction.snapshot().revision().clone();
    if revision != body.expected_revision {
        return super::gateway_config_transaction_error(ConfigCommitError::Conflict {
            current_revision: revision,
        });
    }
    let mut root = match super::gateway_config_document(&transaction) {
        Ok(root) => root,
        Err(error) => return failure(StatusCode::BAD_REQUEST, error),
    };
    if let Err(error) = mutate(&mut root, &body) {
        return failure(StatusCode::BAD_REQUEST, error);
    }
    let bytes = match toml::to_string_pretty(&root) {
        Ok(value) => value.into_bytes(),
        Err(_) => {
            return failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "gateway configuration could not be encoded",
            );
        }
    };
    let config_revision =
        match tokio::task::spawn_blocking(move || transaction.commit(&revision, &bytes)).await {
            Ok(Ok(revision)) => revision,
            Ok(Err(error)) => return super::gateway_config_transaction_error(error),
            Err(_) => {
                return failure(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "gateway configuration transaction could not finish",
                );
            }
        };
    super::record_gateway_control(
        &state,
        "gateway.cloud_speech_account.update",
        "gateway_cloud_speech_account",
        Some(&body.provider),
        &caller,
    )
    .await;
    let application = state
        .gateway
        .apply_provider_revision(&config_revision)
        .await;
    (
        StatusCode::OK,
        Json(
            json!({"success":true,"persisted":true,"configRevision":config_revision,"provider":body.provider,"gateway_application":application}),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_editor_add_remove_and_redacts_secrets() {
        let mut root = toml::Value::Table(Default::default());
        let revision = ConfigRevision::parse(&"a".repeat(64)).unwrap();
        let mut body = CloudSpeechWrite {
            action: Action::Add,
            provider: "google-tts".into(),
            expected_revision: revision.clone(),
            account_id: None,
            account_policy: None,
            access_token: Some("test-token-123".into()),
            quota_project: Some("sample-project".into()),
            access_key_id: None,
            secret_access_key: None,
            session_token: None,
            expires_at_unix_secs: Some(4_000_000_000),
            region: None,
        };
        mutate(&mut root, &body).unwrap();
        let safe = view(&root, &revision).unwrap();
        assert!(!safe.to_string().contains("test-token-123"));
        let id = safe["googleTts"][0]["accountId"]
            .as_str()
            .unwrap()
            .to_owned();
        body.action = Action::Configure;
        body.account_id = Some(id.clone());
        body.account_policy = Some(ProviderAccountPolicy {
            drain_threshold_percent: None,
            name: "Backup".into(),
            enabled: false,
            priority: 3,
        });
        mutate(&mut root, &body).unwrap();
        let configured = view(&root, &revision).unwrap();
        assert_eq!(configured["googleTts"][0]["policy"]["name"], "Backup");
        assert_eq!(configured["googleTts"][0]["policy"]["enabled"], false);
        assert_eq!(configured["googleTts"][0]["policy"]["priority"], 3);
        assert!(!configured.to_string().contains("test-token-123"));
        body.action = Action::Remove;
        body.account_id = Some(id);
        mutate(&mut root, &body).unwrap();
        assert!(root["providers"]["accountPolicies"]["google-tts"]
            .as_table()
            .unwrap()
            .is_empty());
        assert_eq!(
            view(&root, &revision).unwrap()["googleTts"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }
}

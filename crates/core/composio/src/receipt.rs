//! Read billing metadata before dropping the provider execution envelope.
//! No payload, OAuth token, or raw provider error is retained here.

use anyhow::{bail, Context, Result};
use reqwest::Client;
use ryu_gw_contracts::composio_billing::{
    usd_string_to_micro_usd, ComposioAuthSource, ComposioUsage, ComposioUsageKind,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposioReceipt {
    pub auth_config_id: Option<String>,
    pub connected_account_id: Option<String>,
    pub transaction_id: String,
    pub usage: ComposioUsage,
}

pub(crate) fn identifier(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        bail!("Invalid Composio billing identifier");
    }
    Ok(value)
}

async fn metadata_request(client: &Client, base: &str, key: &str, path: &str) -> Result<Value> {
    let response = client
        .get(format!("{}/{path}", base.trim_end_matches('/')))
        .header("x-api-key", key)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .context("Composio billing metadata unavailable")?;
    if !response.status().is_success() {
        bail!("Composio billing metadata returned {}", response.status());
    }
    response
        .json()
        .await
        .context("Invalid Composio billing metadata")
}

pub fn premium_charge(value: Option<&Value>) -> Result<Option<u64>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    // Execution-log metadata uses an exact USD string; Session responses use
    // the InstantCharge object. Both describe the final provider transaction.
    if let Some(amount) = value.as_str() {
        return Ok(Some(
            usd_string_to_micro_usd(amount).map_err(anyhow::Error::msg)?,
        ));
    }
    if value.get("currency").and_then(Value::as_str) != Some("USD")
        || value.get("charged_by").and_then(Value::as_str) != Some("composio")
    {
        bail!("Unsupported Composio premium charge currency or owner");
    }
    let amount = value
        .get("amount")
        .and_then(Value::as_str)
        .context("Missing exact Composio premium amount")?;
    Ok(Some(
        usd_string_to_micro_usd(amount).map_err(anyhow::Error::msg)?,
    ))
}

pub async fn auth_source(
    client: &Client,
    base: &str,
    key: &str,
    auth_config_id: &str,
) -> Result<ComposioAuthSource> {
    let id = identifier(auth_config_id)?;
    let config = metadata_request(client, base, key, &format!("auth_configs/{id}")).await?;
    if config.get("id").and_then(Value::as_str) != Some(id) {
        bail!("Composio billing auth configuration mismatch");
    }
    match config.get("is_composio_managed").and_then(Value::as_bool) {
        Some(true) => Ok(ComposioAuthSource::ManagedApp),
        Some(false) => Ok(ComposioAuthSource::OwnApp),
        None => bail!("Missing Composio auth billing classification"),
    }
}

/// The execution identity the server selected for one metered call, stated
/// explicitly so a receipt is never derived from a log that disagrees with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpectedExecutionIdentity<'a> {
    /// The server pinned this connected account in the execute request. The
    /// log must name exactly this account and the auth configuration the
    /// provider records for it.
    ConnectedAccount(&'a str),
    /// The server sent only its entity (`user_id`) and let Composio select the
    /// entity's account. A log naming an account is accepted only when a
    /// separate account lookup shows that account belongs to this entity and
    /// uses the logged auth configuration. A log naming no account (an
    /// auth-free tool) or Composio's `instant_account` is accepted only when
    /// the log itself records this entity as the caller; Instant also needs
    /// its verified premium charge.
    Entity(&'a str),
}

const INSTANT_ACCOUNT: &str = "instant_account";

/// What the provider records for one connected account, read independently of
/// the execution log.
struct ConnectedAccountRecord {
    auth_config_id: String,
    owner: String,
}

/// The provider-recorded owner (`user_id`) and auth configuration of one
/// connected account.
async fn connected_account_record(
    client: &Client,
    base: &str,
    key: &str,
    connected_account_id: &str,
) -> Result<ConnectedAccountRecord> {
    let id = identifier(connected_account_id)?;
    let value = metadata_request(client, base, key, &format!("connected_accounts/{id}")).await?;
    let account = if value.get("id").is_some() {
        &value
    } else {
        value.get("data").unwrap_or(&value)
    };
    if account.get("id").and_then(Value::as_str) != Some(id) {
        bail!("Composio billing connected-account lookup mismatch");
    }
    let owner = account
        .get("user_id")
        .and_then(Value::as_str)
        .filter(|owner| !owner.is_empty())
        .context("Missing Composio connected-account owner")?;
    let auth_config_id = account
        .get("auth_config")
        .and_then(|config| config.get("id"))
        .or_else(|| account.get("auth_config_id"))
        .and_then(Value::as_str)
        .context("Missing Composio connected-account auth configuration")?;
    Ok(ConnectedAccountRecord {
        auth_config_id: identifier(auth_config_id)?.to_owned(),
        owner: owner.to_owned(),
    })
}

/// The caller entity the log itself records. Every place it is recorded must
/// agree; a log that records none yields `None`.
fn logged_entity(log: &Value) -> Result<Option<&str>> {
    let mut found: Option<&str> = None;
    for value in [
        log.get("metadata")
            .and_then(|metadata| metadata.get("user_id")),
        log.get("user_id"),
    ]
    .into_iter()
    .flatten()
    .filter(|value| !value.is_null())
    {
        let entity = value
            .as_str()
            .filter(|entity| !entity.is_empty())
            .context("Invalid Composio billing log entity")?;
        if found.is_some_and(|previous| previous != entity) {
            bail!("Composio billing log names two entities");
        }
        found = Some(entity);
    }
    Ok(found)
}

/// The logged account must match the provider's own record of it: the
/// configuration the log names is the one the account actually uses.
fn verify_account_config(record: &ConnectedAccountRecord, logged: Option<&str>) -> Result<()> {
    if logged != Some(record.auth_config_id.as_str()) {
        bail!("Composio billing auth-configuration mismatch");
    }
    Ok(())
}

/// Check the log's connected account, auth configuration and caller against
/// the server-selected identity before any billing field of the log is used.
async fn verify_log_identity(
    client: &Client,
    base: &str,
    key: &str,
    expected: ExpectedExecutionIdentity<'_>,
    log: &Value,
    logged_account: Option<&str>,
    logged_config: Option<&str>,
) -> Result<()> {
    match expected {
        ExpectedExecutionIdentity::ConnectedAccount(expected) => {
            let expected = identifier(expected)?;
            if logged_account != Some(expected) {
                bail!("Composio billing connected-account mismatch");
            }
            let record = connected_account_record(client, base, key, expected).await?;
            verify_account_config(&record, logged_config)?;
        }
        ExpectedExecutionIdentity::Entity(entity) => {
            if entity.trim().is_empty() {
                bail!("Metered Composio execution has no server-selected entity");
            }
            match logged_account {
                // No owned account to check: an auth-free tool or Composio's
                // shared Instant account. Only the log's own caller record
                // ties it to this entity, so it must be present and match.
                None | Some(INSTANT_ACCOUNT) => {
                    if logged_entity(log)? != Some(entity) {
                        bail!("Composio billing log does not name the executing entity");
                    }
                    if logged_account.is_none() && logged_config.is_some() {
                        bail!("Composio billing log names a configuration without an account");
                    }
                }
                Some(account) => {
                    let record = connected_account_record(client, base, key, account).await?;
                    if record.owner != entity {
                        bail!("Composio billing connected account belongs to another entity");
                    }
                    verify_account_config(&record, logged_config)?;
                }
            }
        }
    }
    Ok(())
}

/// Direct execution does not return Instant charges. Its log metadata does,
/// even when ZDR is enabled. Lookup by the server-issued log ID, never a slug.
pub async fn execution_receipt(
    client: &Client,
    base: &str,
    key: &str,
    execution: &Value,
    expected: ExpectedExecutionIdentity<'_>,
) -> Result<ComposioReceipt> {
    let id = identifier(
        execution
            .get("log_id")
            .and_then(Value::as_str)
            .context("Composio execution did not return a billing log ID")?,
    )?;
    let log = metadata_request(client, base, key, &format!("logs/tool_execution/{id}")).await?;
    if log.get("id").and_then(Value::as_str) != Some(id) {
        bail!("Composio billing log mismatch");
    }
    let metadata = log
        .get("metadata")
        .and_then(Value::as_object)
        .context("Missing Composio billing log metadata")?;
    let connected_account_id = match metadata.get("connected_account_id") {
        None | Some(Value::Null) => None,
        Some(value) => {
            Some(identifier(value.as_str().context(
                "Invalid Composio billing connected-account identity",
            )?)?)
        }
    };
    let auth_config_id = match metadata.get("auth_config_id") {
        None | Some(Value::Null) => None,
        Some(value) => Some(identifier(
            value
                .as_str()
                .context("Invalid Composio billing auth configuration")?,
        )?),
    };
    verify_log_identity(
        client,
        base,
        key,
        expected,
        &log,
        connected_account_id,
        auth_config_id,
    )
    .await?;
    let premium = premium_charge(metadata.get("instant_charge"))?;
    let instant = connected_account_id == Some(INSTANT_ACCOUNT);
    if premium.is_none() && instant {
        bail!("Composio Instant execution has no verified premium charge yet");
    }
    let source = if premium.is_some() || instant {
        ComposioAuthSource::Instant
    } else if let Some(id) = auth_config_id {
        auth_source(client, base, key, id).await?
    } else {
        // Auth-free tools have no auth configuration. A connected-account call
        // without its configuration cannot be priced reliably.
        if connected_account_id.is_some() {
            bail!("Missing Composio connected-account billing classification");
        }
        ComposioAuthSource::OwnApp
    };
    Ok(ComposioReceipt {
        auth_config_id: auth_config_id.map(str::to_owned),
        connected_account_id: connected_account_id.map(str::to_owned),
        transaction_id: id.to_owned(),
        usage: ComposioUsage {
            kind: ComposioUsageKind::ToolCall,
            auth_source: source,
            direct_execution: true,
            premium_charge_micro_usd: premium,
            ..Default::default()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shared_typescript_receipt_matches_the_gateway_charge_contract() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../gateway/contracts/fixtures/composio-billing.json"
        ))
        .unwrap();
        let receipt: ComposioReceipt = serde_json::from_value(golden["receipt"].clone()).unwrap();
        let policy = ryu_gw_contracts::composio_billing::ComposioBillingPolicy {
            zero_data_retention: true,
            ..Default::default()
        };
        let charge =
            ryu_gw_contracts::composio_billing::price_composio_usage(&receipt.usage, &policy, 1)
                .unwrap();
        assert_eq!(
            charge.total_micro_usd,
            golden["withZdrCostMicroUsd"].as_u64().unwrap()
        );
    }

    #[test]
    fn exact_premium_amount_is_not_multiplied_or_rounded_down() {
        assert_eq!(
            premium_charge(Some(
                &json!({"amount":"0.008","currency":"USD","charged_by":"composio"})
            ))
            .unwrap(),
            Some(8_000)
        );
        assert_eq!(
            premium_charge(Some(
                &json!({"amount":"0.0000001","currency":"USD","charged_by":"composio"})
            ))
            .unwrap(),
            Some(1)
        );
        assert_eq!(premium_charge(Some(&Value::Null)).unwrap(), None);
        assert!(premium_charge(Some(
            &json!({"amount":"0.008","currency":"EUR","charged_by":"composio"})
        ))
        .is_err());
    }

    /// A loopback Composio stand-in answering `GET <path>` from `routes` (404
    /// otherwise). Returns its base URL.
    fn spawn_metadata_server(routes: Vec<(&'static str, Value)>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(300)));
                let mut request = Vec::new();
                let mut chunk = [0_u8; 2048];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&chunk[..read]),
                    }
                }
                let request = String::from_utf8_lossy(&request);
                let path = request.split_whitespace().nth(1).unwrap_or("").to_owned();
                let (status, body) = routes
                    .iter()
                    .find(|(route, _)| *route == path)
                    .map_or(("404 Not Found", "{}".to_owned()), |(_, body)| {
                        ("200 OK", body.to_string())
                    });
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://{addr}")
    }

    fn log(account: Option<&str>, auth_config: Option<&str>) -> Value {
        json!({
            "id": "log_1",
            "metadata": {
                "connected_account_id": account,
                "auth_config_id": auth_config,
            },
        })
    }

    /// A log that also records which entity made the call.
    fn entity_log(account: Option<&str>, entity: &str, extra: Value) -> Value {
        let mut log = log(account, None);
        let metadata = log["metadata"].as_object_mut().unwrap();
        metadata.insert("user_id".to_owned(), json!(entity));
        if let Value::Object(extra) = extra {
            metadata.extend(extra);
        }
        log
    }

    fn account(id: &str, owner: &str, auth_config: &str) -> Value {
        json!({ "id": id, "user_id": owner, "auth_config": { "id": auth_config } })
    }

    async fn receipt_for(
        routes: Vec<(&'static str, Value)>,
        expected: ExpectedExecutionIdentity<'_>,
    ) -> Result<ComposioReceipt> {
        let base = spawn_metadata_server(routes);
        execution_receipt(
            &Client::new(),
            &base,
            "test-key",
            &json!({ "log_id": "log_1", "data": {} }),
            expected,
        )
        .await
    }

    fn managed_config() -> (&'static str, Value) {
        (
            "/auth_configs/ac_managed",
            json!({ "id": "ac_managed", "is_composio_managed": true }),
        )
    }

    fn own_config() -> (&'static str, Value) {
        (
            "/auth_configs/ac_own",
            json!({ "id": "ac_own", "is_composio_managed": false }),
        )
    }

    #[tokio::test]
    async fn a_pinned_account_receipt_needs_a_log_naming_that_account() {
        let matching = receipt_for(
            vec![
                (
                    "/logs/tool_execution/log_1",
                    log(Some("ca_tenant"), Some("ac_managed")),
                ),
                (
                    "/connected_accounts/ca_tenant",
                    account("ca_tenant", "org_1:user_1", "ac_managed"),
                ),
                managed_config(),
            ],
            ExpectedExecutionIdentity::ConnectedAccount("ca_tenant"),
        )
        .await
        .expect("matching log yields a receipt");
        assert_eq!(matching.connected_account_id.as_deref(), Some("ca_tenant"));
        assert_eq!(matching.auth_config_id.as_deref(), Some("ac_managed"));
        assert_eq!(matching.usage.auth_source, ComposioAuthSource::ManagedApp);

        for logged in [Some("ca_other"), None] {
            let error = receipt_for(
                vec![
                    (
                        "/logs/tool_execution/log_1",
                        log(logged, Some("ac_managed")),
                    ),
                    (
                        "/connected_accounts/ca_tenant",
                        account("ca_tenant", "org_1:user_1", "ac_managed"),
                    ),
                    managed_config(),
                ],
                ExpectedExecutionIdentity::ConnectedAccount("ca_tenant"),
            )
            .await
            .expect_err("a log naming another or no account is never billed");
            assert!(error.to_string().contains("connected-account mismatch"));
        }
    }

    #[tokio::test]
    async fn a_pinned_account_receipt_refuses_a_log_with_another_auth_config() {
        // The right account, but the log names a managed configuration the
        // account does not use: its pricing class is never taken from it.
        for logged_config in [Some("ac_managed"), None] {
            let error = receipt_for(
                vec![
                    (
                        "/logs/tool_execution/log_1",
                        log(Some("ca_tenant"), logged_config),
                    ),
                    (
                        "/connected_accounts/ca_tenant",
                        account("ca_tenant", "org_1:user_1", "ac_own"),
                    ),
                    managed_config(),
                    own_config(),
                ],
                ExpectedExecutionIdentity::ConnectedAccount("ca_tenant"),
            )
            .await
            .expect_err("a mismatched configuration is never priced");
            assert!(error.to_string().contains("auth-configuration mismatch"));
        }

        // An account record with no configuration cannot vouch for the log.
        assert!(receipt_for(
            vec![
                (
                    "/logs/tool_execution/log_1",
                    log(Some("ca_tenant"), Some("ac_managed")),
                ),
                (
                    "/connected_accounts/ca_tenant",
                    json!({ "id": "ca_tenant", "user_id": "org_1:user_1" }),
                ),
                managed_config(),
            ],
            ExpectedExecutionIdentity::ConnectedAccount("ca_tenant"),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn an_entity_selected_receipt_verifies_the_logged_account_owner() {
        // Composio picked the entity's own account: billed under that account.
        let owned = receipt_for(
            vec![
                (
                    "/logs/tool_execution/log_1",
                    log(Some("ca_entity"), Some("ac_managed")),
                ),
                (
                    "/connected_accounts/ca_entity",
                    account("ca_entity", "org_1:user_1", "ac_managed"),
                ),
                managed_config(),
            ],
            ExpectedExecutionIdentity::Entity("org_1:user_1"),
        )
        .await
        .expect("an account the entity owns yields a receipt");
        assert_eq!(owned.connected_account_id.as_deref(), Some("ca_entity"));
        assert_eq!(owned.usage.auth_source, ComposioAuthSource::ManagedApp);

        // A log naming another entity's account (stale, cross-wired, or
        // compromised metadata) is refused before its classification is used.
        let foreign = receipt_for(
            vec![
                (
                    "/logs/tool_execution/log_1",
                    log(Some("ca_foreign"), Some("ac_managed")),
                ),
                (
                    "/connected_accounts/ca_foreign",
                    json!({ "data": account("ca_foreign", "org_2:user_9", "ac_managed") }),
                ),
                managed_config(),
            ],
            ExpectedExecutionIdentity::Entity("org_1:user_1"),
        )
        .await
        .expect_err("another entity's account is never billed here");
        assert!(foreign.to_string().contains("another entity"));

        // The entity's own account, but a configuration it does not use.
        let wrong_config = receipt_for(
            vec![
                (
                    "/logs/tool_execution/log_1",
                    log(Some("ca_entity"), Some("ac_managed")),
                ),
                (
                    "/connected_accounts/ca_entity",
                    account("ca_entity", "org_1:user_1", "ac_own"),
                ),
                managed_config(),
                own_config(),
            ],
            ExpectedExecutionIdentity::Entity("org_1:user_1"),
        )
        .await
        .expect_err("a mismatched configuration is never priced");
        assert!(wrong_config.to_string().contains("auth-configuration"));

        // An account whose owner cannot be read fails closed.
        assert!(receipt_for(
            vec![
                (
                    "/logs/tool_execution/log_1",
                    log(Some("ca_unknown"), Some("ac_managed"))
                ),
                managed_config(),
            ],
            ExpectedExecutionIdentity::Entity("org_1:user_1"),
        )
        .await
        .is_err());

        // A blank entity is not an identity.
        assert!(receipt_for(
            vec![(
                "/logs/tool_execution/log_1",
                entity_log(None, "  ", json!({}))
            )],
            ExpectedExecutionIdentity::Entity("  "),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn an_auth_free_entity_receipt_needs_the_log_to_name_that_entity() {
        // The log records this entity as the caller of an auth-free tool.
        let auth_free = receipt_for(
            vec![(
                "/logs/tool_execution/log_1",
                entity_log(None, "org_1:user_1", json!({})),
            )],
            ExpectedExecutionIdentity::Entity("org_1:user_1"),
        )
        .await
        .expect("an auth-free call by this entity yields a receipt");
        assert_eq!(auth_free.connected_account_id, None);
        assert_eq!(auth_free.usage.auth_source, ComposioAuthSource::OwnApp);

        // A cross-wired auth-free log: another entity's call, or no caller at
        // all, is never billed to this entity.
        for cross_wired in [
            entity_log(None, "org_2:user_9", json!({})),
            log(None, None),
            json!({ "id": "log_1", "user_id": "org_1:user_1",
                    "metadata": { "user_id": "org_2:user_9" } }),
        ] {
            let error = receipt_for(
                vec![("/logs/tool_execution/log_1", cross_wired)],
                ExpectedExecutionIdentity::Entity("org_1:user_1"),
            )
            .await
            .expect_err("an auth-free log not naming this entity is refused");
            assert!(
                error.to_string().contains("executing entity")
                    || error.to_string().contains("two entities"),
                "{error}"
            );
        }

        // No account but a configuration: not an auth-free call.
        assert!(receipt_for(
            vec![
                (
                    "/logs/tool_execution/log_1",
                    entity_log(
                        None,
                        "org_1:user_1",
                        json!({ "auth_config_id": "ac_managed" })
                    ),
                ),
                managed_config(),
            ],
            ExpectedExecutionIdentity::Entity("org_1:user_1"),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn an_instant_entity_receipt_needs_the_log_to_name_that_entity() {
        let charge = json!({ "instant_charge": "0.008" });
        let instant = receipt_for(
            vec![(
                "/logs/tool_execution/log_1",
                entity_log(Some(INSTANT_ACCOUNT), "org_1:user_1", charge.clone()),
            )],
            ExpectedExecutionIdentity::Entity("org_1:user_1"),
        )
        .await
        .expect("this entity's Instant call yields a receipt");
        assert_eq!(instant.usage.auth_source, ComposioAuthSource::Instant);
        assert_eq!(instant.usage.premium_charge_micro_usd, Some(8_000));

        for cross_wired in [
            entity_log(Some(INSTANT_ACCOUNT), "org_2:user_9", charge.clone()),
            {
                let mut log = log(Some(INSTANT_ACCOUNT), None);
                log["metadata"]["instant_charge"] = json!("0.008");
                log
            },
        ] {
            let error = receipt_for(
                vec![("/logs/tool_execution/log_1", cross_wired)],
                ExpectedExecutionIdentity::Entity("org_1:user_1"),
            )
            .await
            .expect_err("another entity's Instant charge is never billed here");
            assert!(error.to_string().contains("executing entity"));
        }

        // This entity's Instant call without its verified premium charge.
        assert!(receipt_for(
            vec![(
                "/logs/tool_execution/log_1",
                entity_log(Some(INSTANT_ACCOUNT), "org_1:user_1", json!({})),
            )],
            ExpectedExecutionIdentity::Entity("org_1:user_1"),
        )
        .await
        .is_err());
    }

    #[test]
    fn billing_ids_cannot_change_the_request_path() {
        for value in ["../secrets", "id?other=1", "", "https://other"] {
            assert!(identifier(value).is_err());
        }
        assert!(identifier("log_abc-123").is_ok());
    }
}

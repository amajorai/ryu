//! Network secrets for a disposable Box: values its egress proxy substitutes
//! for placeholders on HTTPS requests to bound hosts, so the Box never holds
//! them (`networkSecrets` on `POST /v1/boxes`).

use super::*;

/// The most network secrets one Box accepts (the Box service's limit).
pub const MAX_BOX_NETWORK_SECRETS: usize = 16;
const MAX_HOSTS_PER_SECRET: usize = 16;

/// One value the Box's egress proxy puts in place of `placeholder`, only in
/// HTTPS requests to `hosts`.
#[derive(Clone, PartialEq, Eq)]
pub struct BoxNetworkSecret {
    pub placeholder: String,
    pub hosts: Vec<String>,
    pub value: SecretString,
}

impl fmt::Debug for BoxNetworkSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BoxNetworkSecret")
            .field("placeholder", &self.placeholder)
            .field("hosts", &self.hosts)
            .finish_non_exhaustive()
    }
}

/// `__RYU_SECRET_<16-64 letters or digits>__`, as the Box service accepts it.
pub fn is_network_secret_placeholder(value: &str) -> bool {
    value
        .strip_prefix("__RYU_SECRET_")
        .and_then(|rest| rest.strip_suffix("__"))
        .is_some_and(|id| {
            (16..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

fn validate(secrets: &[BoxNetworkSecret], network: &BoxNetwork) -> Result<(), BoxApiError> {
    if secrets.len() > MAX_BOX_NETWORK_SECRETS {
        return Err(invalid_request(format!(
            "a Box accepts at most {MAX_BOX_NETWORK_SECRETS} network secrets"
        )));
    }
    if matches!(network, BoxNetwork::None) {
        return Err(invalid_request(
            "network secrets need network egress or an allowlist",
        ));
    }
    for secret in secrets {
        let value = secret.value.expose_secret();
        if !is_network_secret_placeholder(&secret.placeholder)
            || secret.hosts.is_empty()
            || secret.hosts.len() > MAX_HOSTS_PER_SECRET
            || value.is_empty()
            || value.contains(['\r', '\n', '\0'])
        {
            return Err(invalid_request(
                "a network secret needs a placeholder, 1 to 16 hosts and a single-line value",
            ));
        }
    }
    Ok(())
}

/// The one-use tenant secret names a create stores its values under.
fn staging_names(count: usize) -> Vec<String> {
    let batch = uuid::Uuid::new_v4().simple().to_string();
    (0..count)
        .map(|index| format!("RYU_NET_{batch}_{index}"))
        .collect()
}

impl BoxSessionClient {
    /// Create a disposable Box whose egress proxy substitutes `secrets`, then
    /// wait until it is ready. Each value is stored as a sealed tenant secret
    /// under a one-use name only for the create call and removed right after
    /// it, whatever the outcome: from then on only the Box's egress proxy
    /// holds it. A Box service that cannot substitute refuses with
    /// `not_supported`, and nothing is created.
    pub async fn create_disposable_with_network_secrets(
        &self,
        spec: &DisposableBoxSpec,
        idempotency_key: &str,
        secrets: &[BoxNetworkSecret],
    ) -> Result<WorkspaceId, BoxApiError> {
        self.create_disposable_with_egress(spec, idempotency_key, secrets, None)
            .await
    }

    /// [`Self::create_disposable_with_network_secrets`] that also relays
    /// Core's credential broker into the Box when `relay` is set (check
    /// [`Self::relays_broker`] first). The relay's token travels only in the
    /// create body, to the Box's egress sidecar.
    pub async fn create_disposable_with_egress(
        &self,
        spec: &DisposableBoxSpec,
        idempotency_key: &str,
        secrets: &[BoxNetworkSecret],
        relay: Option<&BoxBrokerRelay>,
    ) -> Result<WorkspaceId, BoxApiError> {
        if secrets.is_empty() && relay.is_none() {
            return self.create_disposable(spec, idempotency_key).await;
        }
        validate_labels(&spec.labels)?;
        if !secrets.is_empty() {
            validate(secrets, &spec.network)?;
        }
        if let Some(relay) = relay {
            relay.validate(&spec.network)?;
        }
        let names = staging_names(secrets.len());
        let mut stored = Vec::with_capacity(names.len());
        let mut outcome = Ok(());
        for (name, secret) in names.iter().zip(secrets) {
            outcome = self
                .request(
                    reqwest::Method::PUT,
                    &format!("/secrets/{name}"),
                    Some(json!({ "value": secret.value.expose_secret() })),
                    None,
                    None,
                )
                .await
                .map(drop);
            if outcome.is_err() {
                break;
            }
            stored.push(name.as_str());
        }
        let created = match outcome {
            Ok(()) => {
                let mut body = create_body(spec);
                if let Some(relay) = relay {
                    body["brokerRelay"] = relay.to_json();
                }
                if !secrets.is_empty() {
                    body["networkSecrets"] = Value::Array(
                        names
                            .iter()
                            .zip(secrets)
                            .map(|(name, secret)| {
                                json!({
                                    "secret": name,
                                    "placeholder": secret.placeholder,
                                    "hosts": secret.hosts,
                                })
                            })
                            .collect(),
                    );
                }
                self.post_create(body, idempotency_key).await
            }
            Err(error) => Err(error),
        };
        for name in stored {
            if self
                .request(
                    reqwest::Method::DELETE,
                    &format!("/secrets/{name}"),
                    None,
                    None,
                    None,
                )
                .await
                .is_err()
            {
                tracing::warn!(
                    secret = name,
                    "A staged Box network secret could not be removed"
                );
            }
        }
        let id = created?;
        self.wait_until_ready(&id).await?;
        Ok(id)
    }
}

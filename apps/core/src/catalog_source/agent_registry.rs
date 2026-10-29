//! A federated, user-added **agent registry** source ([`CatalogKind::Agent`]).
//!
//! A custom Agent source with a `base_url` points at a registry that speaks the
//! Ryu Marketplace catalog HTTP shape for the `agent` kind:
//!
//! - `GET {base}/api/marketplace/catalog?kind=agent&query=…&limit=…` →
//!   `{ items: [card…] }`
//! - `GET {base}/api/marketplace/catalog/detail?kind=agent&id=…` →
//!   `{ manifest, descriptor, signature }`, where `descriptor` carries the
//!   portable agent template (`{ template: { kind: "agent", … } }`).
//!
//! This is deliberately NOT a [`super::RyuMarketplaceSource`] with an overridden
//! base: that first-party source uses an unguarded client (so a localhost dev
//! marketplace works) and forwards the caller's buyer bearer. A user-supplied
//! third-party URL gets neither:
//!
//! - every fetch goes through the SSRF-guarded, body-capped
//!   [`crate::server::guarded_get_bytes`] (https only, no private/loopback
//!   targets, DNS-pinned, no redirects, bounded body);
//! - no Ryu account bearer or install session is ever attached.
//!
//! Install trust is the same fail-closed gate as the first-party marketplace
//! ([`super::sources::marketplace_trust_anchor`]): the detail's `signature` over
//! `{ descriptor, manifest }` must verify against the runtime
//! `RYU_MARKETPLACE_PUBLIC_KEY`, else the Marketplace key compiled into the build.
//! A shipped build with neither refuses; only a dev or test build falls back to
//! the local Gateway's resident key. The registry-supplied `signingPublicKey`
//! is never a trust anchor. An unsigned or tampered listing browses but never
//! installs. Core still strips privilege-bearing template fields at install
//! (`AgentTemplate::sanitize_for_untrusted_install`).

use anyhow::{Context, Result};
use serde_json::Value;

use super::sources::{
    envelope_key, marketplace_trust_anchor, require_install_entitlement, urlencode_component,
    urlencode_path, verify_marketplace_install_at,
};
use super::{CatalogKind, CatalogQuery, CatalogSource, InstallDescriptor};

/// Upper bound on cards requested per search page.
const MAX_SEARCH_LIMIT: usize = 100;

/// A custom agent registry speaking the marketplace catalog shape.
#[derive(Debug, Clone)]
pub struct AgentRegistrySource {
    pub id: String,
    pub display_name: String,
    /// Registry API base (trailing `/` trimmed at use).
    pub base_url: String,
}

impl AgentRegistrySource {
    pub fn new(id: String, display_name: String, base_url: String) -> Self {
        Self {
            id,
            display_name,
            base_url,
        }
    }

    fn base(&self) -> &str {
        self.base_url.trim().trim_end_matches('/')
    }

    fn search_url(&self, query: &str, limit: usize, offset: Option<u64>) -> String {
        let cursor = offset.map_or_else(String::new, |offset| format!("&cursor={offset}"));
        format!(
            "{}/api/marketplace/catalog?kind=agent&query={}&limit={}{cursor}",
            self.base(),
            urlencode_component(query.trim()),
            limit.clamp(1, MAX_SEARCH_LIMIT),
        )
    }

    fn detail_url(&self, id: &str, install: bool) -> String {
        let operation = if install { "&operation=install" } else { "" };
        format!(
            "{}/api/marketplace/catalog/detail?kind=agent&id={}{operation}",
            self.base(),
            urlencode_path(id.trim()),
        )
    }

    /// SSRF-guarded, body-capped JSON GET. No credentials are attached.
    async fn fetch_json(url: &str) -> Result<Value> {
        let body = crate::server::guarded_get_bytes(url)
            .await
            .with_context(|| format!("fetching agent registry {url}"))?;
        serde_json::from_slice(&body).with_context(|| format!("parsing agent registry {url}"))
    }

    /// Map one registry card onto the plain agent card shape the Agents tab
    /// renders (the same projection the first-party marketplace emits).
    fn card_to_value(&self, card: &Value) -> Option<Value> {
        let id = card.get("id").and_then(Value::as_str)?.trim();
        if id.is_empty() {
            return None;
        }
        let text = |key: &str| card.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(serde_json::json!({
            "id": id,
            "name": text("name").unwrap_or_else(|| id.to_owned()),
            "description": text("description"),
            "author": text("author").unwrap_or_else(|| self.display_name.clone()),
            "version": text("version"),
            "install_source": text("installSource"),
            "installed": false,
            "icon_url": text("iconUrl"),
            "category": text("category"),
            "rating_average": card.get("ratingAverage").and_then(Value::as_f64).unwrap_or(0.0),
            "rating_count": card.get("ratingCount").and_then(Value::as_u64).unwrap_or(0),
            "source": self.display_name,
        }))
    }

    fn envelope(
        &self,
        cards: Vec<Value>,
        next_cursor: Option<String>,
        note: Option<&str>,
    ) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert(
            envelope_key(CatalogKind::Agent).to_owned(),
            Value::Array(cards),
        );
        obj.insert(
            "next_cursor".to_owned(),
            next_cursor.map_or(Value::Null, Value::String),
        );
        if let Some(note) = note {
            obj.insert("note".to_owned(), Value::String(note.to_owned()));
        }
        Value::Object(obj)
    }

    fn cards_from_list(&self, list: &Value) -> Vec<Value> {
        list.get("items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|card| self.card_to_value(card))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Verify a fetched detail and map it to the agent install descriptor. The
    /// signature gate runs before any mapping; a missing, invalid, or
    /// unverifiable signature refuses the install.
    async fn descriptor_from_detail(
        &self,
        client: &reqwest::Client,
        id: &str,
        detail: Value,
        verify_url: &str,
        public_key: Option<&str>,
    ) -> Result<InstallDescriptor> {
        require_install_entitlement(id, &detail)?;
        verify_marketplace_install_at(client, id, &detail, verify_url, public_key).await?;
        let descriptor = detail.get("descriptor").cloned().unwrap_or(Value::Null);
        let raw = if descriptor.is_null() {
            detail
        } else {
            descriptor
        };
        Ok(InstallDescriptor {
            kind: CatalogKind::Agent,
            source_id: self.id.clone(),
            repo_id: id.to_owned(),
            files: Vec::new(),
            raw,
        })
    }
}

impl CatalogSource for AgentRegistrySource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Agent
    }

    /// Degrades to an empty, labelled envelope when the registry is unreachable
    /// or rejected by the egress guard, like the other federated sources.
    async fn search(&self, _client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let limit = if q.limit == 0 { 40 } else { q.limit };
        let offset = super::parse_marketplace_cursor(q.cursor.as_deref())?;
        match Self::fetch_json(&self.search_url(&q.query, limit, offset)).await {
            Ok(list) => {
                // Pass on only a cursor this registry could accept back.
                let next_cursor =
                    super::parse_marketplace_cursor(list.get("nextCursor").and_then(Value::as_str))
                        .ok()
                        .flatten()
                        .map(|next| next.to_string());
                Ok(self.envelope(self.cards_from_list(&list), next_cursor, None))
            }
            Err(error) => Ok(self.envelope(Vec::new(), None, Some(&format!("{error:#}")))),
        }
    }

    async fn detail(&self, _client: &reqwest::Client, id: &str) -> Result<Value> {
        Self::fetch_json(&self.detail_url(id, false)).await
    }

    async fn install_descriptor(
        &self,
        client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        let public_key = marketplace_trust_anchor()?;
        let detail = Self::fetch_json(&self.detail_url(id, true)).await?;
        let gateway = crate::sidecar::gateway::gateway_url();
        let verify_url = format!("{}/v1/manifests/verify", gateway.trim_end_matches('/'));
        self.descriptor_from_detail(client, id, detail, &verify_url, public_key.as_deref())
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> AgentRegistrySource {
        AgentRegistrySource::new(
            "acme-agents".into(),
            "Acme Agents".into(),
            "https://agents.example.com/".into(),
        )
    }

    #[test]
    fn urls_follow_the_marketplace_catalog_shape() {
        let src = source();
        assert_eq!(
            src.search_url(" code review ", 0, None),
            "https://agents.example.com/api/marketplace/catalog?kind=agent&query=code%20review&limit=1"
        );
        assert!(src.search_url("", 10_000, None).ends_with("&limit=100"));
        assert!(src
            .search_url("", 40, Some(80))
            .ends_with("&limit=40&cursor=80"));
        assert_eq!(
            src.detail_url("acme/reviewer", true),
            "https://agents.example.com/api/marketplace/catalog/detail?kind=agent&id=acme/reviewer&operation=install"
        );
        assert!(!src.detail_url("x", false).contains("operation"));
    }

    #[test]
    fn cards_map_to_the_agents_envelope_and_skip_idless_rows() {
        let src = source();
        let list = serde_json::json!({ "items": [
            { "id": "acme/reviewer", "name": "Reviewer", "ratingAverage": 4.5, "ratingCount": 3 },
            { "name": "no id" },
            { "id": "  " },
        ]});
        let envelope = src.envelope(src.cards_from_list(&list), None, None);
        let agents = envelope["agents"].as_array().unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["id"], "acme/reviewer");
        assert_eq!(agents[0]["author"], "Acme Agents");
        assert_eq!(agents[0]["rating_count"], 3);
        assert!(envelope["next_cursor"].is_null());
        assert!(envelope.get("note").is_none());
    }

    #[tokio::test]
    async fn search_degrades_to_labelled_empty_envelope_on_blocked_egress() {
        // A loopback/plain-http base is refused by the SSRF guard: the browse
        // must degrade, not error.
        let src = AgentRegistrySource::new("l".into(), "Local".into(), "http://127.0.0.1:1".into());
        let page = src
            .search(&reqwest::Client::new(), &CatalogQuery::default())
            .await
            .unwrap();
        assert_eq!(page["agents"].as_array().unwrap().len(), 0);
        assert!(page["note"].as_str().is_some_and(|n| !n.is_empty()));
    }

    #[tokio::test]
    async fn detail_and_install_refuse_private_targets() {
        let src = AgentRegistrySource::new("l".into(), "Local".into(), "http://127.0.0.1:1".into());
        let client = reqwest::Client::new();
        assert!(src.detail(&client, "a").await.is_err());
        assert!(src.install_descriptor(&client, "a").await.is_err());
    }

    #[tokio::test]
    async fn unsigned_listing_is_refused_before_any_mapping() {
        let error = source()
            .descriptor_from_detail(
                &reqwest::Client::new(),
                "acme/reviewer",
                serde_json::json!({ "manifest": {}, "descriptor": { "template": {} } }),
                "http://127.0.0.1:1/v1/manifests/verify",
                None,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("no signature"));
    }

    #[tokio::test]
    async fn signed_listing_maps_descriptor_and_tampering_is_refused() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, Verifier};
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
        let verifying_key = signing_key.verifying_key();
        let app = axum::Router::new().route(
            "/v1/manifests/verify",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| async move {
                let valid = body
                    .get("signature")
                    .and_then(Value::as_str)
                    .and_then(|v| base64::engine::general_purpose::STANDARD.decode(v).ok())
                    .and_then(|bytes| ed25519_dalek::Signature::from_slice(&bytes).ok())
                    .is_some_and(|signature| {
                        verifying_key
                            .verify(&serde_json::to_vec(&body["manifest"]).unwrap(), &signature)
                            .is_ok()
                    });
                axum::Json(serde_json::json!({ "valid": valid }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let verify_url = format!("http://{address}/v1/manifests/verify");

        let template = serde_json::json!({ "template": { "kind": "agent", "name": "Reviewer" } });
        let mut detail = serde_json::json!({
            "manifest": { "id": "acme/reviewer", "version": "1.0.0" },
            "descriptor": template,
        });
        let payload = serde_json::json!({
            "descriptor": detail["descriptor"],
            "manifest": detail["manifest"],
        });
        let signature = signing_key.sign(&serde_json::to_vec(&payload).unwrap());
        detail["signature"] = serde_json::json!(
            base64::engine::general_purpose::STANDARD.encode(signature.to_bytes())
        );

        let client = reqwest::Client::new();
        let src = source();
        let descriptor = src
            .descriptor_from_detail(&client, "acme/reviewer", detail.clone(), &verify_url, None)
            .await
            .unwrap();
        assert_eq!(descriptor.kind, CatalogKind::Agent);
        assert_eq!(descriptor.source_id, "acme-agents");
        assert_eq!(descriptor.raw, template);

        let mut tampered = detail.clone();
        tampered["descriptor"]["template"]["name"] = serde_json::json!("Evil");
        assert!(src
            .descriptor_from_detail(&client, "acme/reviewer", tampered, &verify_url, None)
            .await
            .is_err());
        server.abort();
    }
}

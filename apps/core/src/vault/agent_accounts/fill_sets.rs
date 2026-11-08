//! Vault sets attached to one agent browser session (roadmap P1-13).
//!
//! An agent fills its own accounts ([`super`]) on its own. Filling one of the
//! user's items (any login-shaped vault item, in any environment) needs the
//! user to attach it first: a **fill set** names the items one agent's browser
//! session may fill, each bound to one site. A set is immutable. It cannot be
//! widened or narrowed after it is created; the user revokes it and attaches a
//! new one. While a set is active for an agent, a second one is refused, so an
//! agent never fills from more than one set.
//!
//! The first fill pins the set to the browser session that asked (the sidecar's
//! own per-lane id, never one the agent chooses). A fill from any other browser
//! session is refused, so a restarted browser or another lane of the same agent
//! cannot use what was attached to the first one. Sets live in Core's memory
//! only and expire (one hour by default, a day at most); a Core restart drops
//! them, which fails closed.
//!
//! The agent addresses an attached item by its handle (`attached:<n>`), which
//! `chromium.list_accounts` reports beside its own accounts. The value is
//! released only to the filling sidecar, only for an https page of the item's
//! site, and every release is audited as an item reveal by the agent.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::{page_matches_host, parse_site, FillField};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;
use crate::vault::items::{FieldType, ItemCoords, ItemView};
use crate::vault::VaultError;

/// Most items one set may attach.
pub const MAX_ITEMS: usize = 32;
/// Lifetime of a set when the request names none.
pub const DEFAULT_TTL_SECS: u64 = 60 * 60;
/// Longest lifetime a set may ask for.
pub const MAX_TTL_SECS: u64 = 24 * 60 * 60;
/// Prefix of the handle an agent fills an attached item by.
pub const HANDLE_PREFIX: &str = "attached:";
/// Most sets kept at once (active or not yet pruned).
const MAX_SETS: usize = 1024;
/// Longest browser session id a sidecar may report.
const MAX_SESSION_LEN: usize = 128;

/// One item to attach.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemInput {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    pub key: String,
    /// The site the item fills on. Defaults to the item's first `url` field.
    #[serde(default)]
    pub site: Option<String>,
    /// Login URLs a session Box fill may submit the password to.
    #[serde(default)]
    pub submit_urls: Vec<String>,
    /// Allow a session Box fill without a login URL (the user's opt-in: the
    /// agent can then capture the value on any page of the site).
    #[serde(default)]
    pub box_unbound: bool,
}

/// `POST /api/vault/fill-sets`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInput {
    pub agent_id: String,
    pub items: Vec<ItemInput>,
    #[serde(default)]
    pub ttl_secs: Option<u64>,
}

/// One attached item, as the user and the agent see it (never a value).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttachedItem {
    pub handle: String,
    pub environment: String,
    pub path: String,
    pub key: String,
    pub kind: String,
    pub site: String,
    pub host: String,
    /// Which fill fields the item can serve.
    pub fields: Vec<FillField>,
    /// Login URLs a session Box fill may submit the password to.
    pub submit_urls: Vec<String>,
    /// The user allowed a session Box fill without a login URL.
    pub box_unbound: bool,
    /// Whether a session Box fill of this item is bound to login URLs.
    pub login_url_bound: bool,
    /// The item's id when attached: a different item recreated under the same
    /// key is not the one the user attached.
    #[serde(skip)]
    pub item_id: String,
}

impl AttachedItem {
    pub fn coords(&self) -> Result<ItemCoords> {
        ItemCoords::new(Some(&self.environment), Some(&self.path), &self.key)
    }
}

/// An immutable set of items attached to one agent's browser session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FillSet {
    pub id: String,
    pub agent_id: String,
    pub items: Vec<AttachedItem>,
    pub created_at: i64,
    pub expires_at: i64,
    /// Whether a browser session has claimed the set.
    pub claimed: bool,
    #[serde(skip)]
    browser_session: Option<String>,
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

fn not_found(message: impl Into<String>) -> anyhow::Error {
    VaultError::NotFound(message.into()).into()
}

fn denied(message: impl Into<String>) -> anyhow::Error {
    VaultError::Denied(message.into()).into()
}

/// The item field that serves `fill`, if any. Usernames come from a text
/// field named like one (else the first text field), emails from an `email`
/// field, passwords from a `password` field, codes from a `totp` field.
pub fn field_for(view: &ItemView, fill: FillField) -> Option<&str> {
    let typed = |wanted: FieldType| {
        view.fields
            .iter()
            .filter(move |f| f.has_value && f.def.field_type == wanted)
            .map(|f| f.def.name.as_str())
    };
    match fill {
        FillField::Password => typed(FieldType::Password).next(),
        FillField::Totp => typed(FieldType::Totp).next(),
        FillField::Email => typed(FieldType::Email).next(),
        FillField::Username => {
            let named = |name: &str| matches!(name, "username" | "user" | "login" | "user_name");
            typed(FieldType::Text)
                .find(|name| named(&name.to_ascii_lowercase()))
                .or_else(|| typed(FieldType::Text).next())
        }
    }
}

const ALL_FIELDS: [FillField; 4] = [
    FillField::Username,
    FillField::Email,
    FillField::Password,
    FillField::Totp,
];

/// Check one item and describe it for a set. Cards are refused: their number
/// and code fill only under a card approval.
pub fn attach(view: &ItemView, input: &ItemInput, index: usize) -> Result<AttachedItem> {
    if view.card.is_some() {
        return Err(invalid(format!(
            "item `{}` is a card; cards fill only through card approvals",
            view.key
        )));
    }
    let site = match input
        .site
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(site) => site.to_owned(),
        None => view
            .fields
            .iter()
            .find(|f| f.def.field_type == FieldType::Url)
            .and_then(|f| f.value.clone())
            .ok_or_else(|| {
                invalid(format!(
                    "item `{}` has no url field; pass the site it fills on",
                    view.key
                ))
            })?,
    };
    let (site, host) = parse_site(&site)?;
    let submit_urls = super::fill_target::validate_submit_urls(&host, &input.submit_urls)?;
    let fields: Vec<FillField> = ALL_FIELDS
        .into_iter()
        .filter(|fill| field_for(view, *fill).is_some())
        .collect();
    if fields.is_empty() {
        return Err(invalid(format!(
            "item `{}` has no username, email, password or authenticator value to fill",
            view.key
        )));
    }
    Ok(AttachedItem {
        handle: format!("{HANDLE_PREFIX}{}", index + 1),
        environment: view.environment.clone(),
        path: view.path.clone(),
        key: view.key.clone(),
        kind: view.kind.clone(),
        site,
        host,
        fields,
        login_url_bound: !submit_urls.is_empty(),
        submit_urls,
        box_unbound: input.box_unbound,
        item_id: view.id.clone(),
    })
}

/// Validate a create request and load its items into a new set.
pub async fn build(store: &PluginSecretStore, input: &CreateInput, now: i64) -> Result<FillSet> {
    let agent_id = input.agent_id.trim();
    if agent_id.is_empty() || agent_id.len() > 128 || agent_id.chars().any(char::is_control) {
        return Err(invalid(
            "agent_id must be one line of at most 128 characters",
        ));
    }
    if input.items.is_empty() || input.items.len() > MAX_ITEMS {
        return Err(invalid(format!("attach 1 to {MAX_ITEMS} items")));
    }
    let ttl = input.ttl_secs.unwrap_or(DEFAULT_TTL_SECS);
    if ttl == 0 || ttl > MAX_TTL_SECS {
        return Err(invalid(format!("ttl_secs must be 1 to {MAX_TTL_SECS}")));
    }
    let mut items: Vec<AttachedItem> = Vec::with_capacity(input.items.len());
    for (index, item) in input.items.iter().enumerate() {
        let coords = ItemCoords::new(item.environment.as_deref(), item.path.as_deref(), &item.key)?;
        let view = store.item_get(&coords, true).await?;
        if items.iter().any(|existing| existing.item_id == view.id) {
            return Err(invalid(format!("item `{}` is attached twice", view.key)));
        }
        items.push(attach(&view, item, index)?);
    }
    Ok(FillSet {
        id: crate::vault::random_token("fs_"),
        agent_id: agent_id.to_owned(),
        items,
        created_at: now,
        expires_at: now.saturating_add(i64::try_from(ttl * 1000).unwrap_or(i64::MAX)),
        claimed: false,
        browser_session: None,
    })
}

/// Validate the browser session a sidecar reported.
fn browser_session(raw: Option<&str>) -> Result<&str> {
    let session = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            denied(
                "attached items fill only in an agent browser session that reports its session id",
            )
        })?;
    if session.len() > MAX_SESSION_LEN || session.chars().any(char::is_control) {
        return Err(invalid("browser_session is malformed"));
    }
    if session.starts_with(boxes::BOX_SESSION_PREFIX) {
        return Err(denied(
            "browser_session `box:` is reserved for session Boxes",
        ));
    }
    Ok(session)
}

/// Every set Core holds, keyed by id.
#[derive(Debug, Default)]
pub struct Registry {
    sets: Mutex<HashMap<String, FillSet>>,
}

impl Registry {
    fn lock(&self, now: i64) -> MutexGuard<'_, HashMap<String, FillSet>> {
        let mut sets = self
            .sets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        sets.retain(|_, set| set.expires_at > now);
        sets
    }

    /// Store a new set, refusing a second active set for the same agent.
    pub fn insert(&self, set: FillSet, now: i64) -> Result<FillSet> {
        let mut sets = self.lock(now);
        if sets
            .values()
            .any(|existing| existing.agent_id == set.agent_id)
        {
            return Err(VaultError::Conflict(
                "this agent already has an attached vault set; revoke it first".into(),
            )
            .into());
        }
        if sets.len() >= MAX_SETS {
            return Err(VaultError::Conflict("too many attached vault sets".into()).into());
        }
        sets.insert(set.id.clone(), set.clone());
        Ok(set)
    }

    /// Active sets, optionally only one agent's, oldest first.
    pub fn list(&self, agent_id: Option<&str>, now: i64) -> Vec<FillSet> {
        let mut out: Vec<FillSet> = self
            .lock(now)
            .values()
            .filter(|set| agent_id.is_none_or(|agent| set.agent_id == agent))
            .cloned()
            .collect();
        out.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        out
    }

    pub fn get(&self, id: &str, now: i64) -> Option<FillSet> {
        self.lock(now).get(id).cloned()
    }

    pub fn revoke(&self, id: &str, now: i64) -> Option<FillSet> {
        self.lock(now).remove(id)
    }

    /// The attached item `handle` of `agent_id`'s active set, for a fill from
    /// `session`. The first fill claims the set for its browser session.
    pub fn claim(
        &self,
        agent_id: &str,
        session: Option<&str>,
        handle: &str,
        now: i64,
    ) -> Result<AttachedItem> {
        let session = browser_session(session)?;
        self.pin(agent_id, session, handle, now)
    }

    /// The item `handle` of `agent_id`'s active set, pinning the set to
    /// `session` on first use and refusing any other session.
    fn pin(&self, agent_id: &str, session: &str, handle: &str, now: i64) -> Result<AttachedItem> {
        let mut sets = self.lock(now);
        let set = sets
            .values_mut()
            .find(|set| set.agent_id == agent_id)
            .ok_or_else(|| {
                not_found("no vault items are attached to this agent's browser session")
            })?;
        match set.browser_session.as_deref() {
            Some(bound) if bound != session => {
                return Err(denied(
                    "the attached vault items belong to another browser session; ask the user to attach them again",
                ))
            }
            Some(_) => {}
            None => {
                set.browser_session = Some(session.to_owned());
                set.claimed = true;
            }
        }
        set.items
            .iter()
            .find(|item| item.handle == handle)
            .cloned()
            .ok_or_else(|| not_found(format!("no attached item `{handle}`")))
    }
}

/// The process-wide registry.
pub fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::default)
}

/// Release one field of an attached item to a sidecar filling the page at
/// `page_url`, which must be an https page of the item's site. Audited as an
/// item reveal by `actor`; a `totp` fill releases the current code only.
pub async fn release(
    store: &PluginSecretStore,
    item: &AttachedItem,
    fill: FillField,
    page_url: &str,
    actor: &AuditActor,
) -> Result<String> {
    if !page_matches_host(page_url, &item.host) {
        return Err(denied(format!(
            "attached item `{}` fills only on https pages of {}",
            item.handle, item.host
        )));
    }
    release_field(store, item, fill, actor, field_for).await
}

/// Reveal the field `choose` picks for `fill` from the attached item, after
/// the caller checked the page. Audited as an item reveal by `actor`.
async fn release_field(
    store: &PluginSecretStore,
    item: &AttachedItem,
    fill: FillField,
    actor: &AuditActor,
    choose: for<'a> fn(&'a ItemView, FillField) -> Option<&'a str>,
) -> Result<String> {
    let coords = item.coords()?;
    let view = match store.item_get(&coords, false).await {
        Ok(view) if view.id == item.item_id => view,
        Ok(_) => return Err(not_found("the attached item was replaced; attach it again")),
        Err(error) => return Err(error),
    };
    let name = choose(&view, fill)
        .ok_or_else(|| {
            not_found(format!(
                "attached item `{}` has no {}",
                item.handle,
                fill.as_str()
            ))
        })?
        .to_owned();
    let value = store.item_reveal(&coords, &name, actor).await?;
    if fill == FillField::Totp {
        return crate::vault::totp::current_code_from_seed_value(&value)
            .ok_or_else(|| anyhow::anyhow!("stored authenticator seed is unusable"));
    }
    Ok(value)
}

mod boxes;
pub use boxes::{field_for_box, release_box};

#[cfg(test)]
#[path = "fill_sets_tests.rs"]
mod tests;

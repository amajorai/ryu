//! Session Box fills of attached items (design
//! `docs/vault-env-session-parity/box-fill-verb/` 1.2 steps 4 to 8).
//!
//! A Box pins a set under the reserved session `box:<box id>`, which no
//! sidecar can report ([`super::browser_session`] refuses the prefix), so only
//! Core's Box fill path can name a Box. Authorization peeks at the set
//! without pinning it; the set is pinned only after the Box prepared the fill
//! and Core checked the page, so a refused fill never pre-pins a set.
//!
//! A username fill in a Box needs a field named like one: the first-text
//! fallback of [`field_for`] could type an unrelated text field.

use super::*;
use crate::vault::agent_accounts::fill_target::box_page_matches;

/// The reserved browser session prefix of a session Box.
pub(crate) const BOX_SESSION_PREFIX: &str = "box:";
const MAX_BOX_ID_LEN: usize = 64;

/// `box:<box_id>`, for a Box id of letters, digits and `_`.
fn box_session(box_id: &str) -> Result<String> {
    let valid = !box_id.is_empty()
        && box_id.len() <= MAX_BOX_ID_LEN
        && box_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_');
    if !valid {
        return Err(invalid("the Box id is malformed"));
    }
    Ok(format!("{BOX_SESSION_PREFIX}{box_id}"))
}

/// [`field_for`] for a Box fill: a username comes only from a text field
/// named `username`, `user`, `login` or `user_name`.
pub fn field_for_box(view: &ItemView, fill: FillField) -> Option<&str> {
    if fill != FillField::Username {
        return field_for(view, fill);
    }
    view.fields
        .iter()
        .filter(|f| f.has_value && f.def.field_type == FieldType::Text)
        .map(|f| f.def.name.as_str())
        .find(|name| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "username" | "user" | "login" | "user_name"
            )
        })
}

impl Registry {
    /// The set id and item `handle` of `agent_id`'s active set, when the set
    /// is unclaimed or claimed by this Box. Does not pin the set.
    pub(crate) fn peek_box(
        &self,
        agent_id: &str,
        box_id: &str,
        handle: &str,
        now: i64,
    ) -> Result<(String, AttachedItem)> {
        let session = box_session(box_id)?;
        let sets = self.lock(now);
        let set = sets
            .values()
            .find(|set| set.agent_id == agent_id)
            .ok_or_else(|| not_found("no vault items are attached to this agent"))?;
        if set
            .browser_session
            .as_deref()
            .is_some_and(|bound| bound != session)
        {
            return Err(denied(
                "the attached vault items belong to another browser session; ask the user to attach them again",
            ));
        }
        let item = set
            .items
            .iter()
            .find(|item| item.handle == handle)
            .cloned()
            .ok_or_else(|| not_found(format!("no attached item `{handle}`")))?;
        Ok((set.id.clone(), item))
    }

    /// Pin `agent_id`'s set `set_id` to this Box and return item `handle`.
    /// Refused when the set changed since [`Self::peek_box`] (revoked and
    /// attached again, or claimed by another session) or the item differs.
    pub(crate) fn claim_box(
        &self,
        agent_id: &str,
        box_id: &str,
        set_id: &str,
        expected: &AttachedItem,
        now: i64,
    ) -> Result<AttachedItem> {
        let session = box_session(box_id)?;
        let mut sets = self.lock(now);
        let set = sets
            .get_mut(set_id)
            .filter(|set| set.agent_id == agent_id)
            .ok_or_else(|| not_found("the attached vault set was revoked"))?;
        let item = set
            .items
            .iter()
            .find(|item| item.handle == expected.handle && item.item_id == expected.item_id)
            .cloned()
            .ok_or_else(|| not_found("the attached item changed; ask the user again"))?;
        match set.browser_session.as_deref() {
            Some(bound) if bound != session => Err(denied(
                "the attached vault items belong to another browser session; ask the user to attach them again",
            )),
            Some(_) => Ok(item),
            None => {
                set.browser_session = Some(session);
                set.claimed = true;
                Ok(item)
            }
        }
    }
}

/// Release one field of an attached item for a Box fill whose page Core
/// checked: `page_url` must be `https` on exactly one of `page_hosts`. The
/// username comes from [`field_for_box`]. Audited as an item reveal.
pub async fn release_box(
    store: &PluginSecretStore,
    item: &AttachedItem,
    fill: FillField,
    page_url: &str,
    page_hosts: &[String],
    actor: &AuditActor,
) -> Result<String> {
    if !box_page_matches(page_url, page_hosts) {
        return Err(denied(format!(
            "attached item `{}` fills only on https pages of {}",
            item.handle, item.host
        )));
    }
    release_field(store, item, fill, actor, field_for_box).await
}

#[cfg(test)]
#[path = "boxes_tests.rs"]
mod tests;

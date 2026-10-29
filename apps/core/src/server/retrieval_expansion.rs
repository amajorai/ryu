//! Query expansion (multi-query rewriting and HyDE) for the retrieval routes.
//!
//! The expansion logic (prompts, parsing, fail-open handling) lives in
//! `ryu_rag::expansion`; this module supplies the model: a [`QueryRewriter`]
//! over Core's governed Gateway side-model call ([`super::call_side_model`]), so
//! an expansion passes through the same router, policy, budget, and audit path
//! as any other side-model request. The model is the request's
//! `expansion_model` (only for a caller who may pick models, see
//! [`caller_may_pick_model`]), else the `retrieval-expansion-model` preference,
//! else the node default model.

use ryu_rag::expansion::{expand_query, ExpandedQuery, ExpansionOptions, QueryRewriter};
use serde::Deserialize;

use super::ServerState;

/// Preference naming the model used for retrieval query expansion.
pub(crate) const EXPANSION_MODEL_PREF: &str = "retrieval-expansion-model";
/// Preference naming that model's reasoning effort.
pub(crate) const EXPANSION_EFFORT_PREF: &str = "retrieval-expansion-effort";

/// The expansion fields shared by `POST /api/retrieval/search` and
/// `POST /api/spaces/:id/search`. Flattened into each request body.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ExpansionRequest {
    /// Number of alternative phrasings to search with (0–5).
    #[serde(default)]
    pub(crate) multi_query: Option<usize>,
    /// Also search with a hypothetical answer passage (HyDE).
    #[serde(default)]
    pub(crate) hyde: Option<bool>,
    /// Model for the rewrite calls; overrides the preference. Ignored unless the
    /// caller may pick models ([`caller_may_pick_model`]): the call runs on the
    /// node's Gateway token, so any member with search access could otherwise
    /// run a model the org does not allow them, with the reply returned.
    #[serde(default)]
    pub(crate) expansion_model: Option<String>,
}

impl ExpansionRequest {
    pub(crate) fn options(&self) -> ExpansionOptions {
        ExpansionOptions {
            multi_query: self.multi_query.unwrap_or(0),
            hyde: self.hyde.unwrap_or(false),
        }
    }
}

/// Whether `caller` may choose the expansion model. On an org-bound node only an
/// organization owner or admin may: the rewrite is a Gateway completion on the
/// node's own token, so a member's choice would bypass their per-user model
/// allowlist and budget. On a personal node, whoever reaches the route is the
/// node's owner (or a device they paired).
pub(crate) fn caller_may_pick_model(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> bool {
    use crate::identity_verify::OrgRole;
    if super::node_org_id().is_none() {
        return true;
    }
    caller
        .as_ref()
        .is_some_and(|caller| matches!(caller.role, OrgRole::Owner | OrgRole::Admin))
}

/// A [`QueryRewriter`] that completes through the local Gateway.
struct GatewayRewriter<'a> {
    state: &'a ServerState,
    model: String,
    effort: String,
}

#[async_trait::async_trait]
impl QueryRewriter for GatewayRewriter<'_> {
    async fn complete(&self, system: &str, user: &str) -> anyhow::Result<String> {
        super::call_side_model(
            self.state,
            &crate::sidecar::gateway::SidePurpose::RetrievalExpansion,
            &self.model,
            &self.effort,
            system,
            user,
        )
        .await
        .map_err(|error| anyhow::anyhow!(error))
    }
}

/// Resolve the expansion model: an explicit override, else the feature
/// preference (or node default selection), else the registry default.
async fn expansion_model(state: &ServerState, override_model: Option<&str>) -> (String, String) {
    if let Some(model) = override_model.map(str::trim).filter(|m| !m.is_empty()) {
        return (model.to_owned(), String::new());
    }
    crate::agent_selection::resolve_side_model(
        &state.preferences,
        EXPANSION_MODEL_PREF,
        Some(EXPANSION_EFFORT_PREF),
    )
    .await
    .map(|resolved| (resolved.model, resolved.effort))
    .unwrap_or_else(|| (crate::registry::DEFAULT_LLM_MODEL.to_owned(), String::new()))
}

/// Run the requested expansions for `query`. A no-op request makes no model
/// call and returns just the query; a failed rewrite fails open with a warning.
pub(crate) async fn expand(
    state: &ServerState,
    query: &str,
    request: &ExpansionRequest,
    may_pick_model: bool,
) -> ExpandedQuery {
    let options = request.options();
    if options.is_noop() {
        return ExpandedQuery {
            queries: vec![query.to_owned()],
            ..Default::default()
        };
    }
    let override_model = request
        .expansion_model
        .as_deref()
        .filter(|_| may_pick_model);
    let (model, effort) = expansion_model(state, override_model).await;
    let rewriter = GatewayRewriter {
        state,
        model,
        effort,
    };
    expand_query(&rewriter, query, &options).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_fields_map_to_options() {
        let request: ExpansionRequest =
            serde_json::from_value(serde_json::json!({ "multi_query": 3, "hyde": true })).unwrap();
        assert_eq!(
            request.options(),
            ExpansionOptions {
                multi_query: 3,
                hyde: true
            }
        );
        let empty: ExpansionRequest = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(empty.options().is_noop());
    }
}

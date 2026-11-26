//! `host.spaces_search` - semantic retrieval over a Space, limited to the calling
//! app's own `app:<plugin_id>` documents like every other `host.spaces_*` verb.
//! One reviewed owner, the official Sites package, keeps whole-Space search (see
//! [`REVIEWED_WHOLE_SPACE_SEARCHERS`]).

use super::*;

/// Reviewed owners whose `spaces.search` still reaches every document of the
/// Space. Sites answers a visitor's question from a Space the site owner bound
/// to the Site, and that Space holds the user's pages and files, not documents
/// Sites created. The id is compared after trim and lower case, the rule of
/// `REVIEWED_WORKFLOW_AUTHORS` in `packages/app-host/src/workflow-authoring-guard.ts`.
/// A listed id is necessary and not sufficient, see
/// [`PluginHookBridge::searches_whole_space`].
const REVIEWED_WHOLE_SPACE_SEARCHERS: &[&str] =
    &[crate::plugins::builtins::SITES_PLUGIN_ID, "com.ryu.sites"];

/// Whether `plugin_id`, trimmed and lower-cased, is exactly a reviewed id. An id
/// that only starts or ends with a reviewed id never matches.
pub(super) fn is_reviewed_whole_space_searcher_id(plugin_id: &str) -> bool {
    let id = plugin_id.trim().to_lowercase();
    REVIEWED_WHOLE_SPACE_SEARCHERS.contains(&id.as_str())
}

impl PluginHookBridge {
    /// Search a Space for the app. The caller's Space ACL still applies (the
    /// public `search_space` handler checks it), and the metadata filter keeps
    /// every hit inside documents of kind `app:<plugin_id>`, so the `spaces:docs`
    /// grant never reads the user's pages, files, meeting notes or another app's
    /// documents. The filter runs before ranking, so the limit counts own hits.
    pub(super) async fn spaces_search(&self, args: Value) -> InvokeOutcome {
        let space_id = match args.get("space_id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() && id.len() <= 100 => id.to_owned(),
            _ => return err("space_id is required".to_owned()),
        };
        let query = match args.get("query").and_then(Value::as_str) {
            Some(query) if !query.trim().is_empty() && query.len() <= 8_000 => query.to_owned(),
            _ => return err("query must contain 1 to 8000 bytes".to_owned()),
        };
        let filter = self.search_filter().await;
        let response = crate::server::search_space(
            axum::extract::State(self.state.clone()),
            axum::Extension(self.verified_caller.clone()),
            axum::extract::Path(space_id),
            axum::Json(crate::server::SearchBody {
                query,
                limit: args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(8)
                    .clamp(1, 50) as usize,
                link_expansion: None,
                filter,
                ..Default::default()
            }),
        )
        .await;
        let status = response.status();
        if !status.is_success() {
            return err(format!("Space retrieval denied or unavailable ({status})"));
        }
        match axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024).await {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => ok(value),
                Err(_) => err("Invalid Space retrieval response".to_owned()),
            },
            Err(_) => err("Space retrieval response exceeds limit".to_owned()),
        }
    }

    /// The retrieval filter of this call. Every app gets the own-documents
    /// filter. The one exception is a reviewed whole-Space searcher, which
    /// searches with no kind filter, as every app did before this rule.
    async fn search_filter(&self) -> Option<Value> {
        if self.searches_whole_space().await {
            return None;
        }
        Some(own_docs_filter(&self.plugin_id))
    }

    /// Whether this bridge's owner keeps whole-Space search. Both must hold.
    /// The owner id is a reviewed id, and the manifest Core holds for exactly
    /// that id is an official package. `tier_for_manifest` gives Core tier only
    /// to the manifest compiled into this binary or to a signed package from the
    /// official marketplace, so a package that merely carries the id is filtered
    /// like any other app. No manifest for the id also means filtered.
    async fn searches_whole_space(&self) -> bool {
        if !is_reviewed_whole_space_searcher_id(&self.plugin_id) {
            return false;
        }
        let manifests = self.state.app_manifests.read().await;
        manifests
            .iter()
            .find(|manifest| manifest.id == self.plugin_id)
            .is_some_and(|manifest| {
                crate::plugins::builtins::tier_for_manifest(manifest)
                    == crate::plugin_manifest::PluginTier::Core
            })
    }
}

/// The retrieval filter that admits only documents the app owns. `plugin_id` is
/// the bridge's path-bound owner id, never a value the frame or hook supplies.
pub(super) fn own_docs_filter(plugin_id: &str) -> Value {
    json!({ "kind": { "$eq": format!("app:{plugin_id}") } })
}

#[cfg(test)]
#[path = "spaces_search_test.rs"]
mod tests;

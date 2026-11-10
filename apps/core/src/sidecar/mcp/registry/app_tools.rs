//! App-registered tools and derived ext-API routes.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Register an in-memory tool exposed by an enabled app (tool-as-Runnable,
    /// M3). The tool is immediately visible in `list_all_tools()` without any
    /// process spawn. If a tool with the same id is already registered, the
    /// existing entry is replaced so re-enabling an app is idempotent.
    ///
    /// The `server` field is set to `"app"` so the tool can be found in
    /// allowlists with the entry `"app"`.
    pub fn register_app_tool(&self, id: String, name: String, description: Option<String>) {
        self.register_app_tool_tagged(id, name, description, None);
    }

    /// Like [`register_app_tool`](Self::register_app_tool) but records the resolved
    /// declarative backend as an [`AppToolBackendTag`] so the catalog can surface a
    /// `command` tool as [`catalog::ToolKind::Command`]. The server Tool handler
    /// passes the tag it derives from `ToolConfig::resolve_backend`.
    pub fn register_app_tool_tagged(
        &self,
        id: String,
        name: String,
        description: Option<String>,
        app_backend: Option<AppToolBackendTag>,
    ) {
        let id = canonical_tool_id(&id);
        let name = canonical_tool_id(&name);

        // A capability verb id (`web.search`, `browser.navigate`, …) is reserved
        // by the facade. Letting a plugin register one would shadow the swappable
        // layer with a fixed implementation — the exact coupling the facade exists
        // to prevent — so the registration is refused rather than silently winning
        // or silently losing. The plugin's own native id is unaffected; only the
        // reserved verb id is off limits.
        if capability_tools::verb_by_id(&id).is_some() {
            tracing::warn!(
                "refusing app tool registration for '{id}': that id is a reserved capability verb \
                 served by the layer facade"
            );
            return;
        }
        // A Core built-in server id (`channel.send`, `spaces.get_page`) is likewise
        // reserved: a plugin tool registered under it would intercept agent calls
        // meant for Core. `app_tool_registered_id` already keeps such slugs under
        // `app.<slug>`; this refuses any other path that hands over a raw id.
        if builtin_servers::is_builtin_server_id(&id) {
            tracing::warn!(
                "refusing app tool registration for '{id}': that id is in a Core built-in tool \
                 server namespace"
            );
            return;
        }
        let tool = RegistryTool {
            description,
            app_backend,
            ..RegistryTool::candidate(&id, APP_TOOL_SERVER, &name)
        };
        if let Ok(mut tools) = self.app_tools.lock() {
            tools.retain(|t| t.id != id);
            tools.push(tool);
        }
        // Self-built widgets are cached by server/URI, so an app tool update must
        // retire the old HTML before the same URI can be served again.
        if let Ok(mut cache) = self.resource_cache.lock() {
            cache.clear();
        }
        // A newly available provider tool can make a capability verb serveable.
        capability_tools::invalidate();
    }

    #[cfg(test)]
    pub(crate) fn register_test_app_tool_descriptor(&self, mut tool: RegistryTool) {
        tool.id = canonical_tool_id(&tool.id);
        tool.name = canonical_tool_id(&tool.name);
        if let Ok(mut tools) = self.app_tools.lock() {
            tools.retain(|candidate| candidate.id != tool.id);
            tools.push(tool);
        }
        capability_tools::invalidate();
    }

    /// Remove an app-registered tool by id. Called when a plugin is disabled so
    /// its tools stop being listable, searchable, and callable. Idempotent:
    /// removing an id that isn't present is a no-op.
    pub fn unregister_app_tool(&self, id: &str) {
        let id = canonical_tool_id(id);
        if let Ok(mut tools) = self.app_tools.lock() {
            tools.retain(|t| t.id != id);
        }
        // A disabled app must not leave its cached widget resource available to
        // the resource-read endpoint, and a re-enable must not reuse old HTML.
        if let Ok(mut cache) = self.resource_cache.lock() {
            cache.clear();
        }
        // A removed provider tool can make a capability verb unserveable.
        capability_tools::invalidate();
    }

    // ── Derived ext-API routes (search-gated, never listed) ───────────────────

    /// Replace the derived ext-API routes owned by one **sidecar** of `plugin_id`.
    ///
    /// `sidecar_key` is the manager's namespaced sidecar name
    /// (`<plugin_id>/<spec.name>`, minted by
    /// [`crate::sidecar::manifest_sidecar::namespaced_name`]) — never the bare plugin
    /// id, except in the degenerate wrapper below.
    ///
    /// ## Why the key is the SIDECAR and not the plugin
    ///
    /// The Healthy-edge hook that calls this is armed **per sidecar**, because
    /// [`crate::ext_api::lower`] pairs one sidecar's `http.mount` with that same
    /// sidecar's declared `http.routes`. Keying the map by plugin instead made the two
    /// halves disagree: the moment a manifest carried two `http` sidecars, whichever
    /// reported healthy second would *overwrite* the first's rows, and the re-wake
    /// guard would then answer "already lowered" for the plugin as a whole — so the
    /// loser never got a second chance and the winner was decided by health-poll
    /// ordering, i.e. differently on every boot.
    ///
    /// That is latent rather than live only by luck: exactly one shipped manifest
    /// (`finetune`) declares two sidecars today, and its second one happens to carry
    /// no `http` block, so nothing is armed for it. The next app that declares a
    /// second HTTP sidecar — or the next time `finetune`'s second sidecar grows one —
    /// would silently lose half its derived tools with no error anywhere. Keying by
    /// sidecar removes the failure mode instead of relying on that coincidence.
    ///
    /// Dispatch is unaffected: [`Self::ext_api_route`] resolves a *tool id* by
    /// scanning every entry's rows, never by reconstructing a key.
    ///
    /// Called on a manifest sidecar's **Healthy** edge with the output of
    /// [`crate::ext_api::lower`]; [`Self::clear_ext_api_routes`] is its inverse, on
    /// deactivate. Replace rather than merge, because a sidecar that came back with
    /// a new spec must not keep serving rows from the old one.
    ///
    /// ## The two caps, and why this plane has them when `app_tools` does not
    ///
    /// [`Self::register_app_tool_tagged`] has **neither** a cardinality cap nor an
    /// ownership check — its removal is a bare `retain(|t| t.id != id)`, so any
    /// caller can unregister any tool, and any app may register unboundedly many.
    /// Those are real gaps in that plane; they are survivable there only because
    /// every app tool is *hand-declared* in a manifest a human wrote, so the count
    /// is small by construction and the ids are curated.
    ///
    /// Neither of those is true here. Nobody curates a derived set: it is one row
    /// per `operationId` in a document a build tool generated, so a mid-size
    /// sidecar contributes hundreds of rows with machine names, and every one of
    /// them is a candidate the ranker must score on every search. So this plane
    /// does **not** inherit those gaps:
    ///
    /// - keyed by owning plugin, so a clear can only ever remove that plugin's own
    ///   rows — the ownership check `app_tools` lacks;
    /// - [`EXT_API_PER_PLUGIN_CAP`] bounds a single app's contribution;
    /// - [`EXT_API_GLOBAL_CAP`] bounds the node-wide total, so N installed apps
    ///   cannot each sit under the per-plugin cap and still collectively make
    ///   search quadratically slower.
    ///
    /// Both caps **truncate rather than reject**: a partially derived app is still
    /// useful, an empty one is not, and the surviving prefix is deterministic
    /// (`lower` mints GET-first in a stable order, so the reads — the safe,
    /// high-value half — are the half that survives). The global cap is spent
    /// first-come, which means "app 7 gets 12 of its 60 because apps 1-6 filled the
    /// budget" is possible and order-dependent. That is accepted deliberately: the
    /// alternative is a fair-share re-balance that would silently *remove* rows
    /// from an already-running app whenever an unrelated app woke up, and a tool
    /// that vanishes mid-session is worse than one that never appeared. Both
    /// truncations log what they dropped. The per-plugin cap is summed across ALL of
    /// that plugin's sidecars ([`ext_api_key_owned_by`]), so splitting a surface into
    /// two sidecars is not a way to buy twice the budget.
    pub fn set_ext_api_routes_for_sidecar(
        &self,
        plugin_id: &str,
        sidecar_key: &str,
        routes: Vec<crate::ext_api::ExtApiRoute>,
    ) {
        let Ok(mut map) = self.ext_api.lock() else {
            tracing::warn!("ext_api routes for '{sidecar_key}' dropped: registry mutex poisoned");
            return;
        };
        let mut routes = routes;

        // The per-plugin budget counts this plugin's OTHER sidecars, so the cap stays
        // a per-app number after the re-key. Excluding this key is deliberate for the
        // same reason the global sum below excludes it: these rows REPLACE whatever
        // that sidecar contributed before, so counting the old ones would shrink a
        // sidecar that fit perfectly well a moment ago, on nothing but a re-wake.
        let sibling_rows: usize = map
            .iter()
            .filter(|(key, _)| key.as_str() != sidecar_key && ext_api_key_owned_by(key, plugin_id))
            .map(|(_, r)| r.len())
            .sum();
        let plugin_budget = EXT_API_PER_PLUGIN_CAP.saturating_sub(sibling_rows);
        if routes.len() > plugin_budget {
            tracing::warn!(
                "ext_api: '{sidecar_key}' derived {} operations but '{plugin_id}' has only \
                 {plugin_budget} of its per-plugin cap of {EXT_API_PER_PLUGIN_CAP} left \
                 ({sibling_rows} already spent by its other sidecars); keeping the first \
                 {plugin_budget}",
                routes.len()
            );
            routes.truncate(plugin_budget);
        }

        // The node-wide budget counts every OTHER entry's rows — this sidecar's
        // previous rows are about to be replaced, so counting them would make a
        // re-wake shrink an app that fit perfectly well a moment ago.
        let others: usize = map
            .iter()
            .filter(|(key, _)| key.as_str() != sidecar_key)
            .map(|(_, r)| r.len())
            .sum();
        let remaining = EXT_API_GLOBAL_CAP.saturating_sub(others);
        if routes.len() > remaining {
            tracing::warn!(
                "ext_api: '{sidecar_key}' keeps {remaining} of {} derived operations; the \
                 node-wide cap of {EXT_API_GLOBAL_CAP} is already {others} full",
                routes.len()
            );
            routes.truncate(remaining);
        }

        // An empty vec is still STORED, not skipped: the key's presence is what
        // `has_ext_api_routes_for_sidecar` answers, and a sidecar whose spec
        // legitimately lowers to zero reachable operations must not be re-lowered on
        // every Healthy edge for the rest of the session. (A sidecar truncated to zero
        // by a full budget lands here too, and re-lowering would not win it room.)
        map.insert(sidecar_key.to_owned(), routes);
    }

    /// Single-sidecar convenience over [`Self::set_ext_api_routes_for_sidecar`], where
    /// the key IS the plugin id.
    ///
    /// That degenerate form is legal under the keying invariant — `ext_api_key_owned_by`
    /// matches a key equal to the plugin id as well as one under `<plugin_id>/` — so a
    /// plugin-scoped clear still reaches it. Kept for callers (and tests) that only ever
    /// deal with one contribution per app; the production Healthy-edge path uses the
    /// sidecar-keyed form so two HTTP sidecars cannot overwrite each other.
    pub fn set_ext_api_routes(&self, plugin_id: &str, routes: Vec<crate::ext_api::ExtApiRoute>) {
        self.set_ext_api_routes_for_sidecar(plugin_id, plugin_id, routes);
    }

    /// Drop every derived route owned by `plugin_id` (deactivate/uninstall/update).
    ///
    /// **Plugin-scoped on purpose, while the store is sidecar-keyed.** Both call sites
    /// (`deactivate_plugin`, `update_app_handler`) know only the plugin id, and the
    /// event they are reacting to — the app is gone, or its manifest changed — retires
    /// *every* sidecar that app owns. So this sweeps by ownership rather than removing
    /// one key; a plain `map.remove(plugin_id)` would leave a second sidecar's rows
    /// searchable and callable for an app that is no longer enabled.
    ///
    /// Still ownership-scoped by construction — it cannot reach another app's rows the
    /// way an id-matching `retain` over one flat bag could. Idempotent.
    pub fn clear_ext_api_routes(&self, plugin_id: &str) {
        if let Ok(mut map) = self.ext_api.lock() {
            map.retain(|key, _| !ext_api_key_owned_by(key, plugin_id));
        }
    }

    /// Whether **any** sidecar of `plugin_id` has had its spec lowered in this process.
    ///
    /// The read model's question ("does this app contribute derived tools yet"), NOT
    /// the re-wake guard — see [`Self::has_ext_api_routes_for_sidecar`] for that. Using
    /// this one at the latch is precisely the bug the sidecar keying exists to fix: it
    /// answers `true` as soon as the app's *first* HTTP sidecar has lowered, which
    /// would make every later sidecar of the same app skip its own fetch forever.
    ///
    /// True for a plugin whose lowering produced **zero** routes as well — that is
    /// a completed lowering with an empty result, not a missing one.
    pub fn has_ext_api_routes(&self, plugin_id: &str) -> bool {
        self.ext_api
            .lock()
            .is_ok_and(|map| map.keys().any(|key| ext_api_key_owned_by(key, plugin_id)))
    }

    /// Whether THIS sidecar has already had its spec lowered in this process.
    ///
    /// **The re-wake guard.** A manifest sidecar can cross into Healthy many times
    /// in one session (restart, health flap, upgrade), and lowering is not free —
    /// it fetches and parses the sidecar's OpenAPI document. The Healthy-edge
    /// handler tests this first and skips the whole fetch when the answer is yes,
    /// so the work happens once per activation per sidecar rather than once per flap.
    /// [`Self::clear_ext_api_routes`] on deactivate is what re-arms it — and because
    /// that clear is plugin-scoped, it re-arms every sidecar of the app at once, which
    /// is the pairing this two-method split exists to keep straight.
    ///
    /// True for a sidecar whose lowering produced **zero** routes as well — that is
    /// a completed lowering with an empty result, not a missing one, and re-running
    /// it would produce the same empty result.
    pub fn has_ext_api_routes_for_sidecar(&self, sidecar_key: &str) -> bool {
        self.ext_api
            .lock()
            .is_ok_and(|map| map.contains_key(sidecar_key))
    }

    /// Resolve one derived route by its fully-qualified tool id.
    ///
    /// Scans every plugin's rows rather than parsing the owner back out of the id:
    /// the id carries the plugin *slug*, and slugification is lossy (`@ryu/crm` and
    /// `ryu-crm` both slug to `ryu_crm`), so recovering the key from the id would be
    /// a guess. The scan is over a bounded set — see the caps on
    /// [`Self::set_ext_api_routes`].
    pub(in crate::sidecar::mcp) fn ext_api_route(
        &self,
        tool_id: &str,
    ) -> Option<crate::ext_api::ExtApiRoute> {
        let tool_id = canonical_tool_id(tool_id);
        let map = self.ext_api.lock().ok()?;
        map.values().flatten().find(|r| r.id == tool_id).cloned()
    }
}

#[cfg(test)]
#[path = "../tests/app_tools.rs"]
mod tests;

#[cfg(test)]
#[path = "../tests/native_app_tools.rs"]
mod native_tests;

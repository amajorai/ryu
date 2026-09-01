//! Core-side binding for the extracted unified tool catalog (#474, P1).
//!
//! The catalog *contract + ranker + describe-shaping* (the portable data layer)
//! now lives in the [`ryu_tool_registry`] crate. This module is the thin kernel
//! glue that binds it to the [`McpRegistry`] sidecar object:
//!
//! - the `RegistryTool` → [`ToolDescriptor`] ingest adapter ([`descriptor_from`]),
//! - the built-in server inventory classification ([`classify_kind`]), which
//!   depends on Core's concrete sidecar server inventory (`SELF_BUILD_SERVER`,
//!   the built-in server list) and so cannot live in the crate,
//! - the live, key-gated Composio fetch ([`composio_candidates`]),
//! - the Agent-Skill merge ([`McpRegistry::skill_candidates`] /
//!   [`McpRegistry::describe_skill`]), which turns two discovery doors into one, and
//! - the two [`McpRegistry`] methods ([`McpRegistry::search_scoped`] /
//!   [`McpRegistry::describe`]) that gather kernel state and delegate the pure
//!   work to [`ryu_tool_registry::run_search`] /
//!   [`ryu_tool_registry::describe_from_parts`] / [`ryu_tool_registry::describe_composio`].
//!
//! The Contract-1 types are re-exported so existing `mcp::catalog::…` call sites
//! (the `/api/tools/{search,describe}` handlers, the mcp_bridge meta-tool) keep
//! resolving unchanged.
//!
//! Placement (CLAUDE.md §1): discovering *what tools exist* and ranking them is
//! orchestration → Core. The allowlist verdict / budget / audit is Gateway.

use serde_json::Value;

pub use ryu_tool_registry::{
    DescribedArg, DescribedTool, ToolDescriptor, ToolKind, ToolRanker, RANKER_PREF_KEY,
};

use super::{AppToolBackendTag, McpRegistry, RegistryTool};

/// Built-in server names — their tools are classified [`ToolKind::Builtin`].
const BUILTIN_SERVERS: &[&str] = &[
    super::sandbox::SERVER_NAME,
    super::notify_tool::SERVER_NAME,
    super::artifact_tool::SERVER_NAME,
    super::channel_tool::SERVER_NAME,
    super::search_conversations::SERVER_NAME,
    super::threads::SERVER_NAME,
    super::delegate::SERVER_NAME,
    super::skills_tool::SERVER_NAME,
    super::ui_tool::SERVER_NAME,
];

/// Classify a fully-qualified tool id (`<server>.<tool>`) into a [`ToolKind`].
///
/// `composio.*` → Composio; a built-in server segment → Builtin; the synthetic
/// `app` server (tool-as-Runnable) → App; the self-build server → Builtin;
/// anything else → Mcp. Bound to Core's sidecar server inventory, so it stays
/// kernel-side rather than in the crate.
pub fn classify_kind(id: &str, server: &str) -> ToolKind {
    if server == super::composio::SERVER_NAME {
        return ToolKind::Composio;
    }
    let _ = id;
    if server == "app" {
        return ToolKind::App;
    }
    if server == super::SELF_BUILD_SERVER || BUILTIN_SERVERS.contains(&server) {
        return ToolKind::Builtin;
    }
    ToolKind::Mcp
}

/// Resolve a registry row's [`ToolKind`], honoring its `app_backend` tag: a
/// `command`-tagged app tool surfaces as [`ToolKind::Command`] (so `?kind=command`
/// selects it); every other row — including http/inline_deno/alias app tools —
/// falls back to inventory-based [`classify_kind`]. This is the ONE place the
/// deliberate command-vs-App asymmetry lives; `classify_kind`'s signature (and its
/// tests) are untouched.
fn kind_for(tool: &RegistryTool) -> ToolKind {
    if tool.app_backend == Some(AppToolBackendTag::Command) {
        return ToolKind::Command;
    }
    classify_kind(&tool.id, &tool.server)
}

/// Build a descriptor from a registry tool (`Option<String>` → `String`). The
/// `RegistryTool`→[`ToolDescriptor`] ingest adapter — bound to Core's registry
/// row type, so it stays kernel-side; the arg extraction reuses the crate's
/// [`ryu_tool_registry::arg_summary`].
fn descriptor_from(tool: &RegistryTool) -> ToolDescriptor {
    let (arg_names, arg_descriptions) = ryu_tool_registry::arg_summary(tool.input_schema.as_ref());
    ToolDescriptor {
        id: tool.id.clone(),
        name: tool.name.clone(),
        description: tool.description.clone().unwrap_or_default(),
        kind: kind_for(tool),
        arg_names,
        arg_descriptions,
        score: None,
        meta: tool.meta.clone(),
        widget_accessible: tool.widget_accessible,
        output_template: tool.output_template.clone(),
    }
}

impl McpRegistry {
    // There is deliberately no three-argument `search(query, kind, limit)`
    // convenience any more. It existed as "the unscoped, agent-less default" and
    // forwarded to `search_scoped(.., &[])` — and the one production caller that
    // used it, `GET /api/tools/search`, was the plane whose missing skill scoping
    // this method's own doc comment used to describe as an open hole. A shorter
    // name that silently means "show every skill on the node" is how that hole got
    // there; every caller now names its scope, and `&[]` still means "every enabled
    // skill" for the agent-less callers (workflows, monitors, the approval engine)
    // that genuinely want it.

    /// Search the unified catalog: MCP + built-ins + Composio + plugin tools + Core
    /// self-API + **Agent Skills**. `kind` filters by source plane (`None` = any).
    /// Composio is pulled in **live** (capped at 50) only when a key is configured
    /// and `kind` includes Composio; it is never in `list_all_tools`.
    ///
    /// Gathers kernel state (registry rows + live Composio + enabled skills) and
    /// delegates the filter/merge/rank to [`ryu_tool_registry::run_search`]. Ranking
    /// uses the pref-selected [`ToolRanker`] (Needle 2 default); the Semantic
    /// ranker's embedder and Needle 2 selector are built lazily.
    ///
    /// ## `skills_allowlist` — where every plane gets its value
    ///
    /// This is the calling agent's **skill** allowlist (`AgentRecord.skills`), the
    /// same list `skills.search` / `skills.load` scope on; empty = every enabled
    /// skill. It is a different list from the tool allowlist, so it has to be
    /// threaded here rather than applied afterwards. Every caller today:
    ///
    /// - agent-less callers → empty → identical to `skills.search`'s own default;
    /// - the ACP plane → resolved from the bound agent in
    ///   `mcp_bridge::dispatch_tool_search` (and, so the two cannot be played against
    ///   each other, in `dispatch_describe` via [`Self::describe_scoped`]) from the
    ///   same agent id and the same `AgentRecord.skills` field the `skills` provider
    ///   reads at dispatch. So on that plane `tool_search` and `skills.search` show
    ///   the same skills;
    /// - **`GET /api/tools/search?agent=X`** → resolved from the same store and the
    ///   same field, in `server::agent_skill_allowlist`. This is also what scopes the
    ///   openai-compat chat plane, whose tool loop reaches this method through that
    ///   route (`apps/gateway/src/tools/catalog_client.rs`).
    ///
    ///   The chat plane's id is the same one Core resolves the *injection* allowlist
    ///   from for the same turn — `adapters::resolve_binding(effective_agent_id,
    ///   &agent_store)` calls `store.get(id)` and reads `.skills`, and that same
    ///   `effective_agent_id` is what leaves as the `x-ryu-agent-id` header. So the
    ///   id is known to live in `AgentStore`'s space; this is traced, not assumed.
    ///   **But** the gateway only honors that header when the API key is a
    ///   `trusted_forwarder` (`pipeline::mod`, `eff_agent_id`); otherwise `agent_id`
    ///   is `None`, no `?agent=` is sent, and the search is unscoped — every enabled
    ///   skill, as for any agent-less caller. That is the pre-existing identity
    ///   posture, not something this scoping introduced: a request that cannot prove
    ///   which agent it is has no allowlist to be narrowed to.
    ///
    /// That handler ALSO narrows afterwards with `ToolDescriptor::matches_allowlist`
    /// against the env-derived MCP *tool* allowlist (`AcpAgentRegistry::allowlist_for`
    /// — `RYU_MCP_ALLOWLIST_<AGENT>` then `RYU_MCP_ALLOWLIST`, `None` when neither is
    /// set). That second filter is not a skill gate and never was: its `Skill` arm
    /// gates reaching the `skills` *server*, not an individual skill, and on a stock
    /// node with no such variable it narrows nothing at all. Which is why the skill
    /// list had to be threaded in here — before it was, an agent scoped to two skills
    /// got every enabled skill on the node back as an L1 row (id/name/description),
    /// though `skills.load` still refused the bodies.
    pub async fn search_scoped(
        &self,
        query: &str,
        kind: Option<ToolKind>,
        limit: usize,
        skills_allowlist: &[String],
    ) -> Vec<ToolDescriptor> {
        let mut builtins: Vec<ToolDescriptor> = self
            .list_all_tools()
            .await
            .iter()
            .map(descriptor_from)
            .collect();
        // Core self-API tools (agents driving Ryu itself): OpenAPI-derived, always
        // present, merged HERE so they rank through the same BM25/semantic pass as
        // everything else rather than being appended after truncation. Kind-filtered
        // by `run_search` like any other descriptor.
        builtins.extend(crate::self_api::descriptors());

        // Agent Skills, merged for the same reason and on the same terms: one search
        // door, one ranking pass, `kind`-filtered by `run_search` like anything else.
        // Merged at search time only — skills stay out of `list_all_tools`, so
        // nothing ever offers one as a callable function def.
        let skill_rows = self.skill_candidates(skills_allowlist, &builtins);
        builtins.extend(skill_rows);

        // Derived ext-API routes (an installed app's own OpenAPI surface, lowered
        // by `crate::ext_api`), merged for the third time on the same terms: one
        // search door, one ranking pass, `kind`-filtered by `run_search`.
        //
        // Appended AFTER the skills merge on purpose. `skill_candidates` takes the
        // already-built candidate list to drop id collisions, and that de-dup is
        // about the `skills.*` namespace specifically — a skill slugged `search`
        // colliding with the `skills.search` tool. Derived ids all live under
        // `ryu_ext.`, so they can never take part in that collision, and feeding
        // them in as `already_listed` would only widen a check to a namespace it
        // has nothing to say about.
        builtins.extend(self.ext_api_candidates());

        // Composio: searchable-not-listed. Pull live, capped, key-gated.
        let want_composio = matches!(kind, None | Some(ToolKind::Composio));
        let composio = if want_composio && super::composio::is_configured() {
            composio_candidates(&self.http, query).await
        } else {
            Vec::new()
        };

        let ranker = self.resolve_ranker().await;
        let embedder = matches!(ranker, ToolRanker::Semantic)
            .then(crate::tool_registry_host::CoreToolEmbedder::from_registry);
        let selector = matches!(ranker, ToolRanker::Needle2).then(crate::needle2::selector);
        ryu_tool_registry::run_search_with_selector(
            query,
            builtins,
            composio,
            kind,
            limit,
            ranker,
            embedder
                .as_ref()
                .map(|e| e as &dyn ryu_tool_registry::ToolEmbedder),
            selector
                .as_deref()
                .map(|s| s as &dyn ryu_tool_registry::ToolSelector),
        )
        .await
    }

    /// Enabled, loadable Agent Skills as catalog descriptors (`skills.<slug>`,
    /// [`ToolKind::Skill`]), scoped by `skills_allowlist` (empty = all enabled).
    ///
    /// `already_listed` is the tool half of the candidate set, used to drop the one
    /// genuine collision this namespace has: the `skills` server's own tools are
    /// `skills.search` / `skills.load` / `skills.author`, so a skill whose slug is
    /// literally `search`, `load` or `author` would mint a duplicate id. The **tool**
    /// wins — it is the callable thing, `describe` resolves it first, and a duplicate
    /// id in a ranked list the model picks from by id is worse than a shadowed skill.
    /// The shadowed skill is still reachable through `skills.search` (which returns
    /// bare slugs and so cannot collide) and through `skills.load`. Three slugs, and
    /// this drops them by comparing ids rather than by hardcoding the three names, so
    /// a fourth `skills.*` tool cannot reintroduce the duplicate.
    ///
    /// Returns empty when no skill registry is wired (test/CLI contexts).
    fn skill_candidates(
        &self,
        skills_allowlist: &[String],
        already_listed: &[ToolDescriptor],
    ) -> Vec<ToolDescriptor> {
        let Some(skills) = self.skills.as_ref() else {
            return Vec::new();
        };
        skills
            .enabled_for(skills_allowlist)
            .iter()
            // A body-less record (a plugin skill registered but not materialised on
            // disk) is excluded: `skills.load` has nothing to return for it. See
            // `skills_tool::is_loadable`.
            .filter(|s| super::skills_tool::is_loadable(s))
            .map(super::skills_tool::descriptor_for)
            .filter(|d| !already_listed.iter().any(|t| t.id == d.id))
            .collect()
    }

    /// Every registered derived ext-API route as a catalog descriptor
    /// ([`ToolKind::ExtApi`]).
    ///
    /// ## `kind` is minted here, never inferred
    ///
    /// The kind is written **directly** onto each descriptor rather than being
    /// routed through [`descriptor_from`] / [`kind_for`]. That is not a shortcut,
    /// it is the point: [`classify_kind`] resolves an unknown server segment to
    /// [`ToolKind::Mcp`] as its fallthrough, so a derived row that reached it would
    /// come out labelled `mcp` — with no compile error and no failing test — and
    /// would then be invisible to `?kind=ext-api` while polluting `?kind=mcp`.
    /// Teaching `classify_kind` about `ryu_ext` instead would have been the other
    /// option, but these rows are not `RegistryTool`s at all (they have no server
    /// map entry, no cache row, no dispatch through `tools_for_server`), so they
    /// have nothing to gain from the ingest adapter and one specific thing to lose.
    ///
    /// Returns empty when no app has lowered a spec (the ordinary case on a node
    /// with no OpenAPI-carrying sidecars running).
    fn ext_api_candidates(&self) -> Vec<ToolDescriptor> {
        let Ok(map) = self.ext_api.lock() else {
            return Vec::new();
        };
        map.values()
            .flatten()
            .map(|route| {
                let (arg_names, arg_descriptions) =
                    ryu_tool_registry::arg_summary(Some(&route.input_schema));
                ToolDescriptor {
                    id: route.id.clone(),
                    name: route.name.clone(),
                    description: route.description.clone().unwrap_or_default(),
                    kind: ToolKind::ExtApi,
                    arg_names,
                    arg_descriptions,
                    score: None,
                    meta: None,
                    widget_accessible: false,
                    output_template: None,
                }
            })
            .collect()
    }

    /// Describe a single catalog entry by its fully-qualified id. Returns `None`
    /// when the id is not found. A `composio.*` id is `shallow:true` with a single
    /// freeform `arguments` row (the action's full schema is not listed).
    ///
    /// A `skills.<slug>` id that is not one of the `skills` server's own tools
    /// describes the **Agent Skill** — see [`Self::describe_skill`]. Real tools are
    /// resolved first, so `skills.search` / `skills.load` / `skills.author` always
    /// describe as the tools they are.
    ///
    /// Unscoped, like the `?agent=`-less HTTP route it backs. A caller that knows the
    /// agent should use [`Self::describe_scoped`] instead, or the skill rows a scoped
    /// search just withheld become readable by guessing the id.
    pub async fn describe(&self, id: &str) -> Option<DescribedTool> {
        self.describe_scoped(id, &[]).await
    }

    /// [`Self::describe`], with the calling agent's **skill** allowlist applied to
    /// the skill branch (empty = every enabled skill).
    ///
    /// Only the skill branch is scoped, because only skills have a second, per-agent
    /// list; tool descriptions are governed by the tool allowlist at *call* time, as
    /// they always were. Pairing this with [`Self::search_scoped`] is what makes the
    /// ACP plane's discovery genuinely equal to `skills.search`'s scope: scoping the
    /// search alone would have left `describe` handing back the `name` and
    /// `description` of any skill whose id an agent could guess.
    pub async fn describe_scoped(
        &self,
        id: &str,
        skills_allowlist: &[String],
    ) -> Option<DescribedTool> {
        let normalized_id = super::canonical_tool_id(id);
        let id = normalized_id.as_str();
        // Composio: not in list_all_tools — describe shallowly.
        if id.starts_with("composio.") {
            return Some(ryu_tool_registry::describe_composio(id));
        }

        // Core self-API: not in list_all_tools — described from the OpenAPI route.
        if crate::self_api::is_core_api(id) {
            return crate::self_api::describe(id);
        }

        // Derived ext-API: not in list_all_tools either, so it must be answered
        // here, above the scan, or an id `search` just returned would describe as
        // unknown and the search → describe → call path would dead-end.
        //
        // Unscoped, unlike the skill branch at the bottom of this method — and that
        // asymmetry is deliberate, not the same oversight `describe_scoped` exists
        // to have fixed. A skill has a SECOND, per-agent list (`AgentRecord.skills`)
        // that a scoped search narrows by, so leaving `describe` unscoped there let
        // an agent recover withheld metadata by guessing an id. Derived tools have
        // no such list: they are gated once, at lowering time, on whether the owning
        // app is compiled in, and every agent on the node sees the same set. There
        // is nothing here for a guessed id to recover.
        if crate::ext_api::is_ext_api(id) {
            return self.describe_ext_api(id);
        }

        if let Some(tool) = self.list_all_tools().await.into_iter().find(|t| t.id == id) {
            return Some(ryu_tool_registry::describe_from_parts(
                &tool.id,
                &tool.name,
                tool.description.as_deref().unwrap_or_default(),
                kind_for(&tool),
                tool.input_schema.as_ref(),
            ));
        }

        // Skills: merged into search, absent from `list_all_tools` — so this is the
        // fallback, reached only after every real tool id has failed to match.
        self.describe_skill(id, skills_allowlist)
    }

    /// Describe a `ryu_ext.…` id as the derived HTTP operation it names.
    ///
    /// **This method is why derived tools are callable at all.** Search returns
    /// name + description only (an L1 row), so a model that finds a derived tool
    /// learns its arguments exactly one way: by calling `describe` and reading the
    /// `args` back. Passing the route's `input_schema` through
    /// [`ryu_tool_registry::describe_from_parts`] — the same call the CoreApi arm
    /// makes — is what lowers the spec's `properties` into a real
    /// [`DescribedArg`] list, with `shallow: false` and the full schema echoed in
    /// `parameters`.
    ///
    /// Returning a schema-less `DescribedTool` here would compile, pass a naive
    /// "describe returns Some" test, and leave every derived tool **discoverable
    /// and uncallable** — the model can name it and cannot fill it in. That is not
    /// hypothetical: it is the live state of the app-tool plane, where
    /// `register_app_tool_tagged` builds rows from `RegistryTool::candidate`, whose
    /// `input_schema` is `None`.
    fn describe_ext_api(&self, id: &str) -> Option<DescribedTool> {
        let route = self.ext_api_route(id)?;
        Some(ryu_tool_registry::describe_from_parts(
            &route.id,
            &route.name,
            route.description.as_deref().unwrap_or_default(),
            ToolKind::ExtApi,
            Some(&route.input_schema),
        ))
    }

    /// Describe a `skills.<slug>` id as the Agent Skill it names.
    ///
    /// The result is deliberately **not tool-shaped**: `kind` is [`ToolKind::Skill`]
    /// and `args` is empty, because there is no call to make against this id. The
    /// description carries the literal `skills.load` invocation, so a model that
    /// followed the search → describe path lands on the loader instead of trying to
    /// call the skill. (If it tries anyway, `skills_tool::dispatch` refuses; see that
    /// module's "Discovery is unified, execution is not".)
    ///
    /// Scoped by `skills_allowlist` exactly as `skills.load` is, so an out-of-scope
    /// id is indistinguishable from one that names no skill: both return `None`, which
    /// the HTTP route renders as the same 404 and the ACP bridge as the same
    /// `unknown tool id` error.
    fn describe_skill(&self, id: &str, skills_allowlist: &[String]) -> Option<DescribedTool> {
        let slug = super::skills_tool::slug_from_catalog_id(id)?;
        let skills = self.skills.as_ref()?;
        let record = skills
            .enabled_for(skills_allowlist)
            .into_iter()
            .find(|s| s.id == slug && super::skills_tool::is_loadable(s))?;
        let summary = record.description.unwrap_or_default();
        let lead = if summary.is_empty() {
            String::new()
        } else {
            format!("{summary} ")
        };
        Some(DescribedTool {
            id: id.to_string(),
            name: record.name,
            description: format!(
                "{lead}[Agent Skill — instruction text, not a callable tool.] Do not call \
                 '{id}'. Call {load} with {{\"id\": \"{slug}\"}}, then follow the \
                 instructions it returns for the rest of this turn.",
                load = super::skills_tool::LOAD_TOOL_ID,
            ),
            kind: ToolKind::Skill,
            args: Vec::new(),
            // Not `shallow`: there is no hidden argument schema to warn a caller
            // about. There are no arguments, because there is no call.
            shallow: false,
            parameters: None,
        })
    }

    /// Resolve the active ranker from preferences (Needle 2 default).
    async fn resolve_ranker(&self) -> ToolRanker {
        let pref = match crate::server::preferences::PreferencesStore::open_default() {
            Ok(p) => p.get(RANKER_PREF_KEY).await.ok().flatten(),
            Err(_) => None,
        };
        ToolRanker::from_pref(pref.as_deref())
    }
}

/// Fetch a capped slice of Composio actions as descriptors. Toolkit-agnostic
/// (empty toolkit → catalog drops the empty filter), capped at 50/search. Bound
/// to Core's Composio client, so it stays kernel-side.
async fn composio_candidates(http: &reqwest::Client, query: &str) -> Vec<ToolDescriptor> {
    const CAP: usize = 50;
    let raw = match crate::composio_catalog::list_actions(http, "", query, CAP).await {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!("composio search skipped: {e}");
            return Vec::new();
        }
    };
    raw.get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    let slug = a.get("name").and_then(Value::as_str)?;
                    if slug.is_empty() {
                        return None;
                    }
                    let name = a
                        .get("display_name")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(slug)
                        .to_string();
                    Some(ToolDescriptor {
                        id: format!("composio.{slug}"),
                        name,
                        description: a
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        kind: ToolKind::Composio,
                        arg_names: Vec::new(),
                        arg_descriptions: Vec::new(),
                        score: None,
                        meta: None,
                        widget_accessible: false,
                        output_template: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_kind_by_server() {
        assert_eq!(
            classify_kind("sandbox.run", super::super::sandbox::SERVER_NAME),
            ToolKind::Builtin
        );
        assert_eq!(classify_kind("foo.bar", "foo"), ToolKind::Mcp);
        assert_eq!(
            classify_kind("composio.slack", "composio"),
            ToolKind::Composio
        );
        // `shadow`/`advisor` are now declarative `app`-registered plugin tools
        // (server "app"), not built-in servers — they classify as App like exa.
        assert_eq!(classify_kind("app.thing", "app"), ToolKind::App);
        assert_eq!(
            classify_kind("skills.load", super::super::skills_tool::SERVER_NAME),
            ToolKind::Builtin
        );
    }

    #[test]
    fn description_option_maps_to_empty_string() {
        let tool = RegistryTool::candidate("foo.bar", "foo", "bar");
        let d = descriptor_from(&tool);
        assert_eq!(d.description, "");
        assert_eq!(d.kind, ToolKind::Mcp);
    }

    #[tokio::test]
    async fn command_tagged_tool_classifies_and_searches_as_command() {
        let reg = McpRegistry::empty();
        // A command-tagged app tool …
        reg.register_app_tool_tagged(
            "app.exa_search".into(),
            "exa_search".into(),
            Some("Search the web".into()),
            Some(AppToolBackendTag::Command),
        );
        // … and an http-tagged one (which must stay classified as App).
        reg.register_app_tool_tagged(
            "app.other".into(),
            "other".into(),
            None,
            Some(AppToolBackendTag::Http),
        );

        // descriptor_from → Command, and search(kind=Command) selects it.
        let results = reg
            .search_scoped("exa_search", Some(ToolKind::Command), 25, &[])
            .await;
        assert!(
            results
                .iter()
                .any(|d| d.id == "app.exa_search" && d.kind == ToolKind::Command),
            "command tool must be surfaced + selected by kind=command"
        );
        // The http app tool is NOT a command (asymmetry) — absent from kind=Command.
        assert!(
            results.iter().all(|d| d.id != "app.other"),
            "http app tool must not appear under kind=command"
        );

        // describe honors the tag on both sites.
        let described = reg.describe("app.exa_search").await.expect("described");
        assert_eq!(described.kind, ToolKind::Command);
        let http_desc = reg.describe("app.other").await.expect("described");
        assert_eq!(http_desc.kind, ToolKind::App);
    }

    // ── Agent Skills in the one catalog ──────────────────────────────────────

    fn skill(id: &str, name: &str, desc: &str, body: &str) -> ryu_skills::SkillRecord {
        ryu_skills::SkillRecord {
            id: id.to_owned(),
            name: name.to_owned(),
            description: Some(desc.to_owned()),
            instructions: body.to_owned(),
            allowed_tools: vec![],
            enabled: true,
            always_on: false,
        }
    }

    fn registry_with_skills(skills: Vec<ryu_skills::SkillRecord>) -> McpRegistry {
        let reg = ryu_skills::SkillRegistry::empty();
        reg.replace_for_test(skills);
        McpRegistry::empty().with_skills(reg)
    }

    /// The point of the whole change: one query ranks tools and skills together,
    /// and the row says which it got.
    #[tokio::test]
    async fn search_returns_tools_and_skills_from_one_query() {
        let reg = registry_with_skills(vec![skill(
            "merge-conflicts",
            "Resolve merge conflicts",
            "resolve a git merge conflict safely",
            "## Purpose\nresolve conflicts",
        )]);
        reg.register_app_tool_tagged(
            "app.git_status".into(),
            "git_status".into(),
            Some("show the git working tree status".into()),
            Some(AppToolBackendTag::Http),
        );

        let results = reg
            .search_scoped("git conflict status", None, 25, &[])
            .await;
        let skill_row = results
            .iter()
            .find(|d| d.id == "skills.merge-conflicts")
            .expect("the skill is in the merged catalog");
        assert_eq!(skill_row.kind, ToolKind::Skill, "the row names its plane");
        assert_eq!(skill_row.name, "Resolve merge conflicts");
        let tool_row = results
            .iter()
            .find(|d| d.id == "app.git_status")
            .expect("the tool is still in the merged catalog");
        assert_eq!(tool_row.kind, ToolKind::App);
    }

    /// `?kind=skill` is the filtered view of the one catalog, and every other
    /// filter still excludes skills.
    #[tokio::test]
    async fn kind_filter_selects_and_excludes_skills() {
        let reg = registry_with_skills(vec![skill(
            "web-research",
            "Web research",
            "search the web methodically",
            "## Purpose\nresearch",
        )]);
        reg.register_app_tool_tagged(
            "app.web_search".into(),
            "web_search".into(),
            Some("search the web".into()),
            Some(AppToolBackendTag::Http),
        );

        let only_skills = reg
            .search_scoped("web search", Some(ToolKind::Skill), 25, &[])
            .await;
        assert!(!only_skills.is_empty());
        assert!(
            only_skills.iter().all(|d| d.kind == ToolKind::Skill),
            "kind=skill must return skills only: {only_skills:?}"
        );

        let only_apps = reg
            .search_scoped("web search", Some(ToolKind::App), 25, &[])
            .await;
        assert!(
            only_apps.iter().all(|d| d.kind != ToolKind::Skill),
            "a non-skill filter must not leak skill rows"
        );
    }

    /// The one genuine id collision in this namespace: a skill slugged `search`
    /// would mint `skills.search`, which is the search TOOL's id. The tool wins,
    /// and the skill row is dropped rather than duplicating an id the model picks
    /// from.
    #[tokio::test]
    async fn a_skill_slug_colliding_with_a_skills_tool_is_dropped_from_the_catalog() {
        let reg = registry_with_skills(vec![skill(
            "search",
            "A skill called search",
            "this collides with skills.search",
            "## Purpose\ncollide",
        )]);
        let results = reg.search_scoped("search", None, 25, &[]).await;
        let rows: Vec<&ToolDescriptor> =
            results.iter().filter(|d| d.id == "skills.search").collect();
        assert_eq!(rows.len(), 1, "exactly one row may own an id: {rows:?}");
        assert_eq!(
            rows[0].kind,
            ToolKind::Builtin,
            "the callable tool wins the id, not the skill"
        );
        // …and `describe` agrees with `search` about who owns it.
        let described = reg.describe("skills.search").await.expect("described");
        assert_eq!(described.kind, ToolKind::Builtin);
        assert!(
            !described.args.is_empty(),
            "the search tool keeps its real argument schema"
        );
    }

    /// `describe` on a skill leads the model to `skills.load` and gives it nothing
    /// to call.
    #[tokio::test]
    async fn describe_on_a_skill_points_at_the_loader() {
        let reg = registry_with_skills(vec![skill(
            "pdf-processing",
            "Process PDFs",
            "extract text from a PDF",
            "## Purpose\npdf",
        )]);
        let d = reg
            .describe("skills.pdf-processing")
            .await
            .expect("a merged skill must be describable");
        assert_eq!(d.kind, ToolKind::Skill);
        assert!(
            d.args.is_empty(),
            "there are no arguments, there is no call"
        );
        assert!(d.parameters.is_none());
        assert!(
            d.description
                .contains(super::super::skills_tool::LOAD_TOOL_ID),
            "describe must name the loader: {}",
            d.description
        );
        assert!(
            d.description.contains("\"id\": \"pdf-processing\""),
            "describe must spell out the bare id skills.load takes: {}",
            d.description
        );
        // An id in the namespace that names no skill is simply unknown.
        assert!(reg.describe("skills.nope").await.is_none());
    }

    /// A plugin-registered skill with no instruction body has nothing to load, so
    /// it must not be advertised. `register_app_skill` creates exactly this record
    /// on plugin enable.
    #[tokio::test]
    async fn a_registered_but_unmaterialised_plugin_skill_is_not_advertised() {
        let skills = ryu_skills::SkillRegistry::empty();
        skills.register_app_skill(
            "app.summarize".into(),
            "Summarize".into(),
            Some("App-registered skill (skill_id: summarize)".into()),
        );
        let reg = McpRegistry::empty().with_skills(skills);

        let results = reg.search_scoped("summarize", None, 25, &[]).await;
        assert!(
            results.iter().all(|d| d.id != "skills.app.summarize"),
            "a body-less skill must not be offered: {results:?}"
        );
        assert!(reg.describe("skills.app.summarize").await.is_none());
    }

    /// `search_scoped` applies the calling agent's SKILL allowlist — the same
    /// predicate `skills.search` / `skills.load` use — while the plain `search`
    /// entry point stays unscoped (agent-less callers see every enabled skill).
    #[tokio::test]
    async fn search_scoped_narrows_skills_to_the_agents_skill_allowlist() {
        let reg = registry_with_skills(vec![
            skill("mine", "Mine", "a skill I may load", "## Purpose\nmine"),
            skill(
                "theirs",
                "Theirs",
                "a skill I may not load",
                "## Purpose\ntheirs",
            ),
        ]);

        let scoped = reg
            .search_scoped("skill", None, 25, &["mine".to_string()])
            .await;
        assert!(scoped.iter().any(|d| d.id == "skills.mine"));
        assert!(
            scoped.iter().all(|d| d.id != "skills.theirs"),
            "an out-of-allowlist skill must not appear: {scoped:?}"
        );

        // Empty allowlist = every enabled skill (enabled_for's back-compat default),
        // which is what the unscoped `search` entry point passes.
        let unscoped = reg.search_scoped("skill", None, 25, &[]).await;
        assert!(unscoped.iter().any(|d| d.id == "skills.mine"));
        assert!(unscoped.iter().any(|d| d.id == "skills.theirs"));
    }

    /// **The end-to-end execution boundary.** A model handed `skills.<slug>` by the
    /// merged catalog may try to call it. This exercises the real routing —
    /// `call_tool` → `split_tool_id` → the `skills` provider → `skills_tool::dispatch`
    /// — and asserts it refuses and names the loader, rather than dispatching or
    /// dying with an opaque "malformed tool id".
    ///
    /// Both allowlist postures are covered: an unrestricted caller (`None`, which is
    /// what a `"*"` tool-policy request lowers to) and a caller explicitly granted
    /// the `skills` server. Neither may turn a skill into a function call.
    #[tokio::test]
    async fn calling_a_skill_catalog_id_as_a_tool_is_refused_end_to_end() {
        let reg = registry_with_skills(vec![skill(
            "pdf-processing",
            "Process PDFs",
            "extract text",
            "## Purpose\npdf",
        )]);
        // It really is in the catalog — otherwise this test would pass vacuously.
        assert!(reg
            .search_scoped("pdf", None, 25, &[])
            .await
            .iter()
            .any(|d| d.id == "skills.pdf-processing"));

        for allowlist in [
            None,
            Some(vec!["skills".to_string()]),
            Some(vec!["skills.pdf-processing".to_string()]),
        ] {
            let err = reg
                .call_tool(
                    "skills.pdf-processing",
                    serde_json::json!({}),
                    allowlist.as_deref(),
                )
                .await
                .expect_err("a skill id must never execute as a tool");
            let msg = err.to_string();
            assert!(
                msg.contains("not a callable tool")
                    || msg.contains("not in this agent's allowlist"),
                "unexpected refusal for {allowlist:?}: {msg}"
            );
        }

        // The refusal is specifically the skill-aware one for a caller that IS
        // allowed to reach the skills server (the allowlist branch cannot mask it).
        let msg = reg
            .call_tool(
                "skills.pdf-processing",
                serde_json::json!({}),
                Some(&["skills".to_string()]),
            )
            .await
            .expect_err("refused")
            .to_string();
        assert!(
            msg.contains(super::super::skills_tool::LOAD_TOOL_ID),
            "{msg}"
        );

        // …while the real `skills.load` tool still works through the same path.
        let loaded = reg
            .call_tool(
                super::super::skills_tool::LOAD_TOOL_ID,
                serde_json::json!({ "id": "pdf-processing" }),
                Some(&["skills".to_string()]),
            )
            .await
            .expect("skills.load is a real tool");
        assert_eq!(loaded["ok"], serde_json::json!(true), "{loaded}");
        assert_eq!(loaded["instructions"], serde_json::json!("## Purpose\npdf"));
    }

    /// Scoping the search but not `describe` would have let an agent recover, by
    /// guessing `skills.<slug>`, the exact L1 metadata the scoped search withheld.
    /// An out-of-scope id must be indistinguishable from a nonexistent one.
    #[tokio::test]
    async fn describe_scoped_hides_skills_outside_the_agents_allowlist() {
        let reg = registry_with_skills(vec![
            skill("mine", "Mine", "a skill I may load", "## Purpose\nmine"),
            skill(
                "theirs",
                "Theirs",
                "a skill I may not load",
                "## Purpose\ntheirs",
            ),
        ]);
        let allow = ["mine".to_string()];

        assert!(reg.describe_scoped("skills.mine", &allow).await.is_some());
        assert!(
            reg.describe_scoped("skills.theirs", &allow).await.is_none(),
            "an out-of-allowlist skill must describe as unknown"
        );
        // Same verdict as an id that names nothing at all.
        assert!(reg.describe_scoped("skills.nope", &allow).await.is_none());

        // Tool descriptions are untouched by the skill allowlist — only the skill
        // branch is scoped.
        assert!(reg
            .describe_scoped(super::super::skills_tool::LOAD_TOOL_ID, &allow)
            .await
            .is_some());

        // The unscoped entry point (the `?agent=`-less HTTP route) is unchanged.
        assert!(reg.describe("skills.theirs").await.is_some());
    }

    /// No skill registry wired (test/CLI contexts) ⇒ no skill rows, no panic.
    #[tokio::test]
    async fn search_without_a_skill_registry_yields_no_skill_rows() {
        let reg = McpRegistry::empty();
        let results = reg.search_scoped("anything", None, 25, &[]).await;
        assert!(results.iter().all(|d| d.kind != ToolKind::Skill));
        assert!(reg.describe("skills.whatever").await.is_none());
    }

    // ── Derived ext-API routes in the one catalog ────────────────────────────

    /// A derived route with a real two-property schema — the arguments are the
    /// whole point of `describe_ext_api`, so a schema-less fixture would make
    /// every assertion below vacuous.
    fn ext_route(id: &str, plugin: &str, method: &str, name: &str) -> crate::ext_api::ExtApiRoute {
        crate::ext_api::ExtApiRoute {
            id: id.to_owned(),
            plugin_id: plugin.to_owned(),
            method: method.to_owned(),
            url: format!("core:/api/ext/{plugin}/contacts"),
            name: name.to_owned(),
            description: Some("search the CRM contact book by name".to_owned()),
            header_params: vec![],
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "free-text contact query" },
                    "limit": { "type": "integer", "description": "max rows to return" },
                },
                "required": ["query"],
            }),
        }
    }

    /// **The load-bearing invariant.** Derived rows are search-gated, never listed:
    /// per-turn context cost is exactly zero because function definitions come only
    /// from `tools_for_agent` → `list_all_tools`, and one sidecar can contribute
    /// hundreds of operations.
    ///
    /// The positive control is not decoration. Asserting only the absence would
    /// pass identically if `set_ext_api_routes` silently stored nothing at all, so
    /// the same test first proves the row is real and reachable through `search`.
    #[tokio::test]
    async fn derived_tools_are_absent_from_list_all_tools() {
        let reg = McpRegistry::empty();
        reg.set_ext_api_routes(
            "@ryu/crm",
            vec![ext_route(
                "ryu_ext.ryu_crm.post_tools_search",
                "@ryu/crm",
                "POST",
                "Search contacts",
            )],
        );

        // Positive control: the row exists and search can find it.
        let found = reg.search_scoped("contact search", None, 25, &[]).await;
        assert!(
            found
                .iter()
                .any(|d| d.id == "ryu_ext.ryu_crm.post_tools_search"),
            "the derived row must be reachable through search: {found:?}"
        );

        // …and is absent from BOTH listing paths — `list_all_tools` itself and the
        // per-turn `tools_for_agent` view that lowers into function definitions.
        let listed = reg.list_all_tools().await;
        assert!(
            listed.iter().all(|t| !crate::ext_api::is_ext_api(&t.id)),
            "derived tools must never be listed: {:?}",
            listed.iter().map(|t| &t.id).collect::<Vec<_>>()
        );
        let for_agent = reg.tools_for_agent(None).await;
        assert!(
            for_agent.iter().all(|t| !crate::ext_api::is_ext_api(&t.id)),
            "derived tools must never reach an agent's function definitions"
        );
    }

    /// Derived rows rank in the one catalog and carry their own plane, so
    /// `?kind=ext-api` selects them and every other filter excludes them.
    #[tokio::test]
    async fn derived_tools_appear_in_search_with_ext_api_kind() {
        let reg = McpRegistry::empty();
        reg.set_ext_api_routes(
            "@ryu/crm",
            vec![ext_route(
                "ryu_ext.ryu_crm.get_api_contacts",
                "@ryu/crm",
                "GET",
                "List contacts",
            )],
        );
        reg.register_app_tool_tagged(
            "app.crm_sync".into(),
            "crm_sync".into(),
            Some("sync the CRM contact book".into()),
            Some(AppToolBackendTag::Http),
        );

        let row = reg
            .search_scoped("contacts", None, 25, &[])
            .await
            .into_iter()
            .find(|d| d.id == "ryu_ext.ryu_crm.get_api_contacts")
            .expect("the derived route is in the merged catalog");
        assert_eq!(
            row.kind,
            ToolKind::ExtApi,
            "the row must name its plane — a fallthrough to Mcp would be silent"
        );
        assert_eq!(row.name, "List contacts");
        assert!(
            row.arg_names.iter().any(|a| a == "query"),
            "the L1 row still summarises its args: {:?}",
            row.arg_names
        );

        let only_ext = reg
            .search_scoped("contacts", Some(ToolKind::ExtApi), 25, &[])
            .await;
        assert!(!only_ext.is_empty());
        assert!(
            only_ext.iter().all(|d| d.kind == ToolKind::ExtApi),
            "kind=ext-api must return derived rows only: {only_ext:?}"
        );
        assert!(only_ext
            .iter()
            .any(|d| d.id == "ryu_ext.ryu_crm.get_api_contacts"));

        // …and a different filter does not leak them.
        let only_apps = reg
            .search_scoped("contacts", Some(ToolKind::App), 25, &[])
            .await;
        assert!(
            only_apps.iter().all(|d| d.kind != ToolKind::ExtApi),
            "a non-ext-api filter must not leak derived rows: {only_apps:?}"
        );
    }

    /// The single most important assertion in this stage: search hands back name +
    /// description only, so a derived tool is callable ONLY if `describe` returns
    /// its arguments. A schema-less answer here leaves every derived tool
    /// discoverable and uncallable.
    #[tokio::test]
    async fn describe_ext_api_returns_arguments() {
        let reg = McpRegistry::empty();
        reg.set_ext_api_routes(
            "@ryu/crm",
            vec![ext_route(
                "ryu_ext.ryu_crm.post_tools_search",
                "@ryu/crm",
                "POST",
                "Search contacts",
            )],
        );

        let d = reg
            .describe("ryu_ext.ryu_crm.post_tools_search")
            .await
            .expect("a derived route must be describable");
        assert_eq!(d.kind, ToolKind::ExtApi);
        assert!(
            !d.shallow,
            "the full schema is known, so this is not shallow"
        );
        assert!(
            d.parameters.is_some(),
            "the raw JSON Schema must be echoed for a caller that wants it"
        );

        let query = d
            .args
            .iter()
            .find(|a| a.name == "query")
            .expect("describe must lower the schema's properties into args");
        assert_eq!(query.r#type, "string");
        assert_eq!(query.description, "free-text contact query");
        assert!(query.required, "the schema's `required` list must survive");
        let limit = d
            .args
            .iter()
            .find(|a| a.name == "limit")
            .expect("every property, not just the first");
        assert!(!limit.description.is_empty());
        assert!(!limit.required);

        // The scoped entry point agrees — the skill allowlist has no say here.
        assert!(reg
            .describe_scoped(
                "ryu_ext.ryu_crm.post_tools_search",
                &["some-unrelated-skill".to_string()]
            )
            .await
            .is_some());

        // An id in the namespace that names no route is simply unknown.
        assert!(reg.describe("ryu_ext.ryu_crm.get_nope").await.is_none());
    }

    /// The per-plugin cap truncates rather than rejects, and it keeps the FIRST
    /// rows — `ext_api::lower` mints GET-first in a documented, deterministic
    /// order, so "the first N" means the reads survive. Asserting only the count
    /// would pass under a hash-ordered truncation that drops a different 60 every
    /// boot.
    #[tokio::test]
    async fn set_ext_api_routes_enforces_the_per_plugin_cap() {
        let over = super::super::EXT_API_PER_PLUGIN_CAP + 25;
        let routes: Vec<_> = (0..over)
            .map(|i| {
                ext_route(
                    &format!("ryu_ext.ryu_crm.get_op_{i:03}"),
                    "@ryu/crm",
                    "GET",
                    "Contacts operation",
                )
            })
            .collect();
        let reg = McpRegistry::empty();
        reg.set_ext_api_routes("@ryu/crm", routes);

        let rows = reg
            .search_scoped("contacts", Some(ToolKind::ExtApi), 1000, &[])
            .await;
        assert_eq!(
            rows.len(),
            super::super::EXT_API_PER_PLUGIN_CAP,
            "one app may not contribute an unbounded number of derived rows"
        );
        // The surviving prefix is the FIRST N, in mint order.
        assert!(
            reg.describe("ryu_ext.ryu_crm.get_op_000").await.is_some(),
            "the first operation must survive truncation"
        );
        assert!(
            reg.describe(&format!(
                "ryu_ext.ryu_crm.get_op_{:03}",
                super::super::EXT_API_PER_PLUGIN_CAP - 1
            ))
            .await
            .is_some(),
            "…through the last one under the cap"
        );
        assert!(
            reg.describe(&format!(
                "ryu_ext.ryu_crm.get_op_{:03}",
                super::super::EXT_API_PER_PLUGIN_CAP
            ))
            .await
            .is_none(),
            "…and the first one over it is dropped, not swapped in"
        );
    }

    /// Deactivating one app drops that app's derived rows and NOTHING else. The
    /// map is keyed by owner precisely so this cannot become `app_tools`' unowned
    /// `retain(|t| t.id != id)`, where any caller can remove any row.
    #[tokio::test]
    async fn clear_ext_api_routes_removes_only_that_plugin() {
        let reg = McpRegistry::empty();
        reg.set_ext_api_routes(
            "@ryu/crm",
            vec![ext_route(
                "ryu_ext.ryu_crm.get_api_contacts",
                "@ryu/crm",
                "GET",
                "List contacts",
            )],
        );
        reg.set_ext_api_routes(
            "@ryu/quests",
            vec![ext_route(
                "ryu_ext.ryu_quests.get_api_quests_id",
                "@ryu/quests",
                "GET",
                "Get a quest",
            )],
        );
        assert!(reg.has_ext_api_routes("@ryu/crm"));
        assert!(reg.has_ext_api_routes("@ryu/quests"));

        reg.clear_ext_api_routes("@ryu/crm");

        assert!(
            !reg.has_ext_api_routes("@ryu/crm"),
            "the re-wake guard re-arms"
        );
        assert!(reg.has_ext_api_routes("@ryu/quests"));
        assert!(reg
            .describe("ryu_ext.ryu_crm.get_api_contacts")
            .await
            .is_none());
        assert!(reg
            .describe("ryu_ext.ryu_quests.get_api_quests_id")
            .await
            .is_some());
        let rows = reg
            .search_scoped("quest contacts", Some(ToolKind::ExtApi), 25, &[])
            .await;
        assert_eq!(rows.len(), 1, "only the other app's rows remain: {rows:?}");

        // Idempotent, and an unknown plugin id is a no-op rather than a wipe.
        reg.clear_ext_api_routes("@ryu/crm");
        reg.clear_ext_api_routes("@ryu/never-installed");
        assert!(reg.has_ext_api_routes("@ryu/quests"));

        // A lowering that produced zero routes still counts as done — the guard is
        // key presence, so a spec with nothing reachable is not re-fetched forever.
        reg.set_ext_api_routes("@ryu/empty", vec![]);
        assert!(reg.has_ext_api_routes("@ryu/empty"));
    }

    #[tokio::test]
    async fn search_excludes_composio_without_key() {
        // Serialize against every test that mutates the composio auth cache /
        // key env (process-global), so the "no key" state holds for this body.
        let _lock = crate::sidecar::gateway::lock_managed_node_env();
        crate::composio_auth::set_key("");
        std::env::remove_var("RYU_COMPOSIO_API_KEY");
        std::env::remove_var("COMPOSIO_API_KEY");
        let reg = McpRegistry::empty();
        let results = reg.search_scoped("anything", None, 25, &[]).await;
        assert!(
            results.iter().all(|d| d.kind != ToolKind::Composio),
            "no Composio results when no key configured"
        );
    }
}

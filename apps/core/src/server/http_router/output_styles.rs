//! The HTTP router: `create_router`, the protected route table and the per-surface route builders: `output_style_registry` through `audit_agent_control`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// The process-global output-style registry ([`ryu_output_styles`]), initialised on
/// first touch.
///
/// # Why an accessor and not a `ServerState` field
///
/// Two callers need this registry and they are not ordered with respect to each
/// other. `create_router` builds the HTTP surface (main.rs:1650) *after* it spawns
/// the `onStartup` activation pass (main.rs:1613), and that pass is where an enabled
/// plugin's contributed styles are re-registered after a restart
/// ([`sync_plugin_output_styles`]). Publishing the registry as a side effect of
/// building the router — which is what [`ryu_output_styles::routes`] does on its own
/// — would therefore lose a race: the boot pass would register into a throwaway
/// handle while the handlers read an empty one. Initialising on first touch makes
/// whichever caller arrives first the one that publishes, and the crate's
/// `OnceLock` makes the loser's `set` a harmless no-op (both then read the winner's
/// `Arc`, which is the same disk scan).
///
/// [`ryu_output_styles::set_data_dir`] is also called here as a fallback for embedded
/// callers; normal startup publishes it before plugin activation. The legacy
/// selection file and the profile-aware user styles root must resolve against the
/// real (possibly relocated) data folder, not the crate's `$RYU_DIR`/`~/.ryu`
/// fallback. Both are `OnceLock`s, so the ordering only has to hold on the first
/// call, which this fn guarantees by construction.
pub(in crate::server) fn output_style_registry() -> &'static ryu_output_styles::OutputStyleRegistry
{
    if let Some(registry) = ryu_output_styles::global_registry() {
        return registry;
    }
    ryu_output_styles::set_data_dir(crate::paths::ryu_dir());
    ryu_output_styles::set_global_registry(ryu_output_styles::OutputStyleRegistry::load());
    ryu_output_styles::global_registry()
        .expect("the output-style registry was just published (OnceLock::set or a racing set)")
}

/// The `/api/output-styles/*` surface (list / read / author / select), served
/// **ungated** on the protected chain.
///
/// # Why no `AppGate`, unlike every sibling feature router above
///
/// An output style is a Core-level axis — the same kind of thing as the selected
/// model or the default agent — not an app feature. Three of its four sources
/// (user, project, managed; design §3) have nothing to do with any plugin, and the
/// authoring surface writes the user root. Gating this on `@ryu/output-styles` would
/// mean disabling the plugin that ships the ten built-in profiles also took away the
/// styles the user wrote themselves, plus the profile selector that assigns them.
///
/// This is *not* the [`collect_plugin_store_tabs`] carve-out ("the declaration is
/// ungated, the data behind it keeps its own gate") — there is no gate to keep. The
/// honesty requirement that carve-out exists to satisfy is met a different way here:
/// a disabled plugin's styles genuinely leave the registry, because
/// [`sync_plugin_output_styles`] unregisters them on the disable seam. So the
/// endpoint stays reachable while its *contents* still respect enablement, which is
/// the property that actually matters.
///
/// Paths come from the crate as **relative** routes, so this `nest`s rather than
/// `merge`s (the opposite of `skills_routes`): nothing else in Core serves anything
/// under `/api/output-styles`, so the crate owns the whole prefix.
///
/// Generic over the state for the same reason the crate's own `routes` is: not one
/// handler here extracts `State`, they all read the process-global registry. Prod
/// instantiates it at `ServerState` (inferred by the `.merge` in `create_router`);
/// [`output_styles_route_tests`] instantiates it at `()` and drives the real
/// function rather than a hand-rebuilt stand-in of it.
pub(in crate::server) fn output_styles_routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new().nest(
        "/api/output-styles",
        ryu_output_styles::routes::<S>(ryu_output_styles::OutputStylesCtx::new(
            output_style_registry().clone(),
        )),
    )
}

/// Register (or, with `enabled == false`, unregister) every output style a plugin
/// contributes, so the registry's plugin bag tracks the enable/disable seams.
///
/// The whole `source` is handed to [`ryu_output_styles::OutputStyleRegistry::register_plugin_style`],
/// frontmatter included: design §4 keeps `parse_output_style_md` the ONE parser for
/// disk styles and plugin styles alike, so a contribution's frontmatter is the single
/// source of truth for its `name` / `description` / `keep-coding-instructions` and no
/// second code path can disagree about what they mean.
///
/// # Ids are used verbatim, NOT namespaced by the owning plugin
///
/// The obvious collision-proofing — registering `<plugin>:<id>` — is wrong here, and
/// in two independent ways:
///
/// 1. **It would make the style unforkable.** `ryu_output_styles::store::validate_id`
///    rejects `:` and `/` because the id is a path component (`<id>.md`) in the user
///    root, so `PUT /api/output-styles/@ryu%2Foutput-styles:eli5` — the "edit a plugin
///    style" action, which design §6 defines as *fork it into the user root* — could
///    never write its file.
/// 2. **It would break the shadowing the merge order exists for.**
///    `OutputStyleRegistry::all` deliberately merges the plugin bag *below* the disk
///    records so a user's `eli5.md` wins over the plugin's `eli5`. A namespaced
///    plugin id can never collide with a disk id (which is always a file stem), so
///    the fork would appear as a second row next to the original instead of
///    replacing it — and a style copied out of `~/.claude/output-styles`, which
///    design §1 promises works unchanged, would never shadow anything.
///
/// The residual risk is two enabled plugins contributing the same style id: the
/// second registration replaces the first, and disabling either removes the row. That
/// is the same last-writer-wins shape `register_app_tool` and `register_app_skill`
/// already have for their own flat id spaces, and unlike them it is recoverable by
/// re-enabling. Trading it away would cost the fork.
///
/// Best-effort per style: a malformed contribution is logged and skipped, never fatal
/// to the enable. `register_plugin_style` returning `Err` is the only way a broken
/// style body becomes visible, so it is logged at `warn`, not swallowed.
pub(in crate::server) fn sync_plugin_output_styles(
    manifest: &crate::plugin_manifest::PluginManifest,
    enabled: bool,
) {
    let Some(contributes) = &manifest.contributes else {
        return;
    };
    if contributes.output_styles.is_empty() {
        return;
    }
    let registry = output_style_registry();
    for style in &contributes.output_styles {
        if !enabled {
            registry.unregister_plugin_style(&style.id);
            continue;
        }
        // `source` is absent when the manifest reached us un-hydrated (the install
        // ingest paths do not run `hydrate_output_style_files`). Skip loudly: an
        // empty style would silently register a no-op row in the picker.
        let Some(source) = style.source.as_deref() else {
            tracing::warn!(
                plugin = %manifest.id,
                style = %style.id,
                "output style has no inlined source (un-hydrated manifest); skipped"
            );
            continue;
        };
        match registry.register_plugin_style(style.id.clone(), source) {
            Ok(()) => tracing::debug!(
                plugin = %manifest.id,
                style = %style.id,
                "registered plugin-contributed output style"
            ),
            Err(e) => tracing::warn!(
                plugin = %manifest.id,
                style = %style.id,
                "plugin-contributed output style rejected: {e}"
            ),
        }
    }
}

/// The `/api/agents/*` catalog + CRUD + ACP session-management surface, gated on the
/// **Agents App** being enabled.
///
/// A governance-shell leaf: no `requires`. Pre-installed AND **load-bearing** (see
/// [`crate::plugins::builtins::LOAD_BEARING_PLUGINS`]) — the composer fetches the
/// agent list on boot, so the app can never actually be disabled and the gate is
/// transparent. Static segments (`catalog`, `import`) are registered before the `:id`
/// routes so they match first (the original inline order is preserved).
///
/// Every route here is a UI-driven catalog/management call — listing/creating/
/// editing/deleting agents, the ACP session lifecycle (config/auth/logout/sessions/
/// load), thread import, usage, and capabilities. NONE is on the synchronous chat
/// hot path: `/api/chat/stream` resolves the agent through the in-process
/// `AgentStore` and the ACP substrate directly, never by HTTP-looping back through
/// `/api/agents`. The chat-serving substrate itself (`agent_routing/`,
/// `sidecar/adapters/acp.rs`) is kernel and is deliberately NOT part of this router.
/// `/api/pi-config/*` is a separate surface (not under `/api/agents`) and stays on
/// the ungated protected chain.
pub(in crate::server) fn agent_control_audit_route(
    method: &Method,
    path: &str,
) -> Option<(String, String, Option<String>)> {
    if !matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        return None;
    }

    if *method == Method::POST && path == "/api/agents" {
        return None;
    }
    if *method == Method::POST && path == "/api/agents/catalog/install" {
        return Some((
            "agent.catalog.install".to_owned(),
            "agent-catalog".to_owned(),
            None,
        ));
    }
    if *method == Method::POST && path == "/api/agents/catalog/uninstall" {
        return Some((
            "agent.catalog.uninstall".to_owned(),
            "agent-catalog".to_owned(),
            None,
        ));
    }
    if *method == Method::POST && path == "/api/agents/published/install" {
        return Some((
            "agent.published.install".to_owned(),
            "agent-catalog".to_owned(),
            None,
        ));
    }
    if *method == Method::POST && path == "/api/agents/import" {
        return Some(("agent.import".to_owned(), "agent-import".to_owned(), None));
    }
    if *method == Method::POST && path == "/api/import/run" {
        return Some((
            "agent.setup.import".to_owned(),
            "agent-import".to_owned(),
            None,
        ));
    }

    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    if segments.get(0) != Some(&"api") || segments.get(1) != Some(&"agents") {
        return None;
    }
    let agent_id = segments.get(2)?.trim();
    if agent_id.is_empty() || matches!(agent_id, "catalog" | "published") {
        return None;
    }

    let action = match segments.as_slice() {
        ["api", "agents", _] if *method == Method::PUT => "agent.update",
        ["api", "agents", _] if *method == Method::DELETE => "agent.delete",
        ["api", "agents", _, "prompt-versions"] if *method == Method::POST => {
            "agent.prompt-version.create"
        }
        ["api", "agents", _, "prompt-versions", _, "restore"] if *method == Method::POST => {
            "agent.prompt-version.restore"
        }
        ["api", "agents", _, "migrate-to-ryu"] if *method == Method::POST => "agent.migrate",
        ["api", "agents", _, "threads", "import"] if *method == Method::POST => {
            "agent.thread.import"
        }
        ["api", "agents", _, "authenticate"] if *method == Method::POST => "agent.auth.login",
        ["api", "agents", _, "logout"] if *method == Method::POST => "agent.auth.logout",
        ["api", "agents", _, "accounts", "switch"] if *method == Method::POST => {
            "agent.auth.account-switch"
        }
        ["api", "agents", _, "accounts", "remove"] if *method == Method::POST => {
            "agent.auth.account-remove"
        }
        ["api", "agents", _, "sessions", _] if *method == Method::DELETE => "agent.session.delete",
        ["api", "agents", _, "sessions", _] if *method == Method::POST => "agent.session.load",
        ["api", "agents", _, "sessions", _, "load"] if *method == Method::POST => {
            "agent.session.load"
        }
        ["api", "agents", _, "update"] if *method == Method::POST => "agent.runtime.update",
        ["api", "agents", _, "capabilities"] if *method == Method::PUT => {
            "agent.capabilities.update"
        }
        _ => return None,
    };

    Some((
        action.to_owned(),
        format!("agent:{agent_id}"),
        Some(agent_id.to_owned()),
    ))
}

/// Append a Gateway control row for every successful mutating agent-management
/// route. The caller identity comes from Core's verified JWT extension; route
/// parameters are used only as bounded correlation metadata.
pub(in crate::server) async fn audit_agent_control(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    req: Request<axum::body::Body>,
    next: middleware::Next,
) -> axum::response::Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let metadata = agent_control_audit_route(&method, &path);
    let response = next.run(req).await;
    if response.status().is_success() {
        if let Some((action, target, agent_id)) = metadata {
            record_gateway_control_attributed(
                &state,
                &action,
                &target,
                Some("successful Core agent-management mutation"),
                &caller,
                agent_id.as_deref(),
            )
            .await;
        }
    }
    response
}

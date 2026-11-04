//! The HTTP router: `create_router`, the protected route table and the per-surface route builders: `spaces_routes` through `require_managed_activity_boundary`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// The `/api/spaces/*` surface, gated on the **Spaces App** being enabled.
///
/// The routes are unchanged and still mounted exactly once — they just live in
/// their own `Router` so a single `route_layer` can wrap all of them, exactly as
/// [`meetings_routes`] does. Same gate, same middleware, no second path.
///
/// # Why Spaces is gated at all
///
/// Spaces is the *dependency target* of the graph (`Meetings`, `Whiteboard`, and
/// `Canvas` all declare `requires.apps = [@ryu/spaces]`). An App whose `enabled`
/// bit governs nothing would make that graph decorative: the Store renders a live
/// Switch for Spaces, and flipping it must actually turn the capability off. With
/// this gate, "disabled" has the same teeth for Spaces that it has for Meetings.
///
/// # What is (deliberately) NOT gated
///
/// Only the HTTP surface is refused. Core's *in-process* uses of `state.spaces` —
/// chat/RAG retrieval, `meetings_api::save_notes_to_space`, the artifact tool's
/// `store.create_file` — are untouched, and that is correct: gating a route governs
/// what *callers* may reach, not what the crate may do internally. Every HTTP caller
/// of `/api/spaces/*` is a Spaces UI surface (desktop/web/cli/tui/extension/native)
/// or a plugin already protected by a `requires` edge, so a disabled Spaces degrades
/// exactly the surfaces the user just turned off — and never a background path.
///
/// `/api/graph` (the cross-space link graph) and `/api/embedding/*` keep their own
/// prefixes and are not under this per-Space AppGate; they are global, not
/// per-Space. `/api/graph` is nonetheless tenancy-filtered per caller (SPACE_READ +
/// `caller_doc_filter`), so on a bound node it never leaks a private document's
/// title or link topology cross-tenant.
///
/// Spaces is pre-installed (`plugins::builtins::CORE_PREINSTALLED`) and is seeded before
/// its dependents, so on any normal install the gate is transparent.
pub(in crate::server) fn spaces_routes(app_store: &PluginStore) -> Router<ServerState> {
    Router::new()
        .merge(space_imports::routes())
        .route(
            "/api/spaces/import",
            post(import_space_package).layer(DefaultBodyLimit::max(
                space_portable::MAX_SPACE_PACKAGE_BODY_BYTES,
            )),
        )
        .route("/api/spaces", get(list_spaces).post(create_space))
        .route("/api/spaces/search", get(search_space_documents))
        .route("/api/spaces/:id", axum::routing::delete(delete_space))
        .route("/api/spaces/:id/name", post(rename_space))
        // Changing the retrieval mode (and rebuilding the entity graph so the change
        // takes effect) is a POST to a scoped sub-path, mirroring `:id/icon` above
        // rather than introducing a PATCH: the process CORS layer's `allow_methods`
        // (GET/POST/PUT/DELETE/OPTIONS) does not include PATCH, so a PATCH route
        // would fail preflight from every browser-hosted surface — a route that
        // exists and cannot be called. Registered above the `route_layer` below so
        // it stays inside the Spaces AppGate.
        .route("/api/spaces/:id/retrieval-mode", post(set_retrieval_mode))
        .route(
            "/api/spaces/:id/retrieval-mode/status",
            get(retrieval_mode_status),
        )
        .route(
            "/api/spaces/:id/retrieval-mode/cancel",
            post(cancel_retrieval_mode),
        )
        .route("/api/spaces/:id/icon", post(set_space_icon))
        .route("/api/spaces/:id/visibility", post(set_space_visibility))
        .route("/api/spaces/:id/export", post(export_space_package))
        .route(
            "/api/spaces/:id/documents",
            get(list_documents).post(ingest_document),
        )
        .route("/api/spaces/:id/pages", post(create_page))
        .route("/api/spaces/:id/databases", post(create_database))
        .route(
            "/api/spaces/:id/databases/:doc_id/query",
            post(query_space_database),
        )
        .route("/api/spaces/:id/whiteboards", post(create_whiteboard))
        // The body limit is DECLARED here, not inherited: a route with no
        // `DefaultBodyLimit` silently caps at axum's implicit 2 MiB, which is how this
        // route came to enforce ~1.5 MiB of file while its handler checked 200 MiB.
        // `SPACE_FILE_BODY_LIMIT` carries the base64 wire ceiling AND the message a
        // rejection prints, so neither can drift from the other.
        .route(
            "/api/spaces/:id/files",
            uploads::SPACE_FILE_BODY_LIMIT.apply(post(create_file)),
        )
        .route(
            "/api/spaces/:id/documents/:doc_id/blob",
            uploads::SPACE_FILE_BODY_LIMIT.apply(get(get_file_blob).put(replace_file_blob)),
        )
        .route(
            "/api/spaces/:id/documents/:doc_id",
            get(get_document)
                .put(update_document)
                .delete(delete_document),
        )
        .route(
            "/api/spaces/:id/documents/:doc_id/access",
            axum::routing::put(set_document_access),
        )
        .route(
            "/api/spaces/:id/documents/:doc_id/icon",
            post(set_document_icon),
        )
        // Was this file's TEXT indexed, or only its filename? See
        // [`crate::space_file_index`] — a silent descriptor-only fallback is the
        // failure this route exists to make visible.
        .route(
            "/api/spaces/:id/documents/:doc_id/index",
            get(get_document_index_status),
        )
        // Page version history (Prompt-Studio-style, server-backed).
        .route(
            "/api/spaces/:id/documents/:doc_id/versions",
            get(list_document_versions).post(create_document_version),
        )
        .route(
            "/api/spaces/:id/documents/:doc_id/versions/:version_id",
            get(get_document_version),
        )
        .route(
            "/api/spaces/:id/documents/:doc_id/versions/:version_id/restore",
            post(restore_document_version),
        )
        .route("/api/spaces/:id/search", post(search_space))
        .route(
            "/api/spaces/:id/chunking",
            get(get_space_chunking).put(set_space_chunking),
        )
        // Wiki page-link graph: backlinks, outgoing links, and graph topology.
        .route(
            "/api/spaces/:id/documents/:doc_id/backlinks",
            get(get_document_backlinks),
        )
        .route(
            "/api/spaces/:id/documents/:doc_id/links",
            get(get_document_links),
        )
        .route("/api/spaces/:id/graph", get(get_space_graph))
        // `route_layer`, not `layer`: the gate runs only on these matched routes,
        // so an unknown path stays a plain 404.
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(
                app_store,
                crate::plugins::builtins::SPACES_PLUGIN_ID,
                "Spaces",
            ),
            require_app_enabled,
        ))
}

// `/api/meetings/*` is served OUT-OF-PROCESS by the `ryu-meetings` sidecar via the
// manifest `public_mount` (the generic ext-proxy loader owns the App gate + the stable
// prefix), so there is no in-process `meetings_routes` merge. Core reaches it only
// through capabilities (hardware ambient ingest: `crate::meeting_capabilities`; the
// Danger Zone row: `data.*`); the sidecar files notes through `spaces.fileNotes`.

// `/api/dashboards/*` is served OUT-OF-PROCESS by the `ryu-dashboards` sidecar via
// the manifest `public_mount` (the generic ext-proxy loader owns the App gate + the
// stable prefix), so there is no in-process `dashboards_routes` merge. Core's
// remaining dashboard couplings (hardware render + nudge + `dashboard_builder`)
// go through the `dashboards.*` capabilities (`crate::dashboard_capabilities`).

/// The `/api/skills/*` + `/api/skills/catalog/*` surface, gated on the **Skills App**
/// being enabled.
///
/// A governance-shell leaf: both route blocks (the skills.sh catalog + the SKILL.md
/// CRUD/version surface) live in this one sub-router so a single `route_layer` gates
/// them together. Skills declares no `requires`; it is the dependency *target* of
/// Learning (`requires.apps = [@ryu/skills]`). Pre-installed, so the gate is
/// transparent on a fresh install.
///
/// Only the HTTP surface is gated — the in-process `state.skills` [`SkillRegistry`]
/// is injected into every outgoing chat turn by `route_chat_stream`, which is
/// untouched: gating a route governs what *callers* may reach, not what the crate
/// does internally. Static literals are registered before the `:id` param routes so
/// matchit resolves them first.
///
/// The `/api/skills` CRUD/version/**activate** leaves live in the extracted
/// [`ryu_skills`] crate (`ryu_skills::routes`, a state-agnostic `Router<ServerState>`
/// that reads the process-global registry Core published). The `catalog`/`updates`/
/// `install-from-source` leaves stay here — they are wired to Core-only machinery
/// (the download center, `catalog_source`, marketplace buyer tokens). Both halves
/// are `.merge`d and gated by one `route_layer`, so the mounted route set + gate is
/// byte-identical to the pre-extraction inline router.
pub(in crate::server) fn skills_routes(state: &ServerState) -> Router<ServerState> {
    let crate_routes =
        ryu_skills::routes::<ServerState>(ryu_skills::SkillsCtx::new(state.skills.clone()));
    Router::new()
        // Skills catalog (browse + install from skills.sh; logic in Core).
        .route("/api/skills/catalog", get(skills_catalog_list))
        .route("/api/skills/catalog/detail", get(skills_catalog_detail))
        .route("/api/skills/catalog/install", post(skills_catalog_install))
        .route("/api/skills/targets", get(skills_targets))
        .route(
            "/api/skills/targets/preferences",
            put(skills_target_preferences_put).delete(skills_target_preferences_delete),
        )
        .route("/api/skills/:id/distribute", post(skills_distribute))
        .route("/api/skills/updates", get(skills_updates))
        .route(
            "/api/skills/install-from-source",
            post(skills_install_from_source),
        )
        // Skill packs (browse/add/install a named collection of skills) + the
        // bundled system-skills sync (reconcile the curated catalog on demand).
        .route(
            "/api/skills/packs",
            get(skills_packs_list).post(skills_packs_add),
        )
        .route("/api/skills/packs/detail", get(skills_packs_detail))
        .route("/api/skills/packs/install", post(skills_packs_install))
        .route("/api/skills/packs/remove", post(skills_packs_remove))
        .route("/api/skills/system", get(skills_system_status))
        .route("/api/skills/system/sync", post(skills_system_sync))
        // Skills CRUD + authoring/version history + activate (desktop SKILL.md
        // editor) — the extracted crate's router, merged under the same gate.
        .merge(crate_routes)
        .route_layer(middleware::from_fn_with_state(
            AppGate::new(
                &state.app_store,
                crate::plugins::builtins::SKILLS_PLUGIN_ID,
                "Skills",
            ),
            require_app_enabled,
        ))
        .route_layer(middleware::from_fn(
            require_managed_skill_authoring_boundary,
        ))
}

pub(in crate::server) async fn require_managed_skill_authoring_boundary(
    req: axum::http::Request<axum::body::Body>,
    next: middleware::Next,
) -> axum::response::Response {
    if crate::sidecar::control_plane::is_managed_node()
        || crate::sidecar::control_plane::registered_org().is_some()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "skill access requires a verified user/resource binding on managed nodes".to_owned(),
        );
    }
    next.run(req).await
}

/// The activity store is node-wide and has no owner/tenant key. Do not expose
/// the host bridge's global feed or write surface on shared/managed nodes until
/// the storage model carries a verified caller binding.
pub(in crate::server) fn activity_routes() -> Router<ServerState> {
    Router::new()
        .route("/api/activity/stream", get(activity_api::activity_stream))
        .route(
            "/api/activity",
            get(activity_api::list_activity).post(activity_api::create_activity),
        )
        .route_layer(middleware::from_fn(require_managed_activity_boundary))
}

pub(in crate::server) async fn require_managed_activity_boundary(
    req: axum::http::Request<axum::body::Body>,
    next: middleware::Next,
) -> axum::response::Response {
    if crate::sidecar::control_plane::is_managed_node()
        || crate::sidecar::control_plane::registered_org().is_some()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "activity feed requires a verified user/resource binding on managed nodes".to_owned(),
        );
    }
    next.run(req).await
}

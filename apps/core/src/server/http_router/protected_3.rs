//! The HTTP router: `create_router`, the protected route table and the per-surface route builders: `protected_routes_3` through `protected_routes_3`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Part 3 of 6 of the protected route table (from
/// `/api/acl/resources/:kind/:id` on). [`create_router`] merges every part in order and
/// then wraps them in the auth layer stack, so a route added here inherits
/// `require_auth` exactly as it did in the single chain.
pub(in crate::server) fn protected_routes_3(state: &ServerState) -> Router<ServerState> {
    Router::new()
        .route(
            "/api/acl/resources/:kind/:id",
            get(acl_get_resource).put(acl_put_resource),
        )
        .route("/api/pair/requests", get(pair_requests))
        .route("/api/pair/approve", post(pair_approve))
        .route("/api/pair/deny", post(pair_deny))
        .route("/api/pair/clients", get(pair_clients))
        .route("/api/pair/clients/:id", delete(pair_revoke))
        .route("/api/hardware/pair", post(hardware_public::pair_device))
        // RHP v1.1 pairing v2 + node identity recovery: protected, like legacy pair.
        .route(
            "/api/hardware/pair/begin",
            post(hardware_public::pair_begin),
        )
        .route(
            "/api/hardware/pair/reveal",
            post(hardware_public::pair_reveal),
        )
        .route(
            "/api/hardware/pair/confirm",
            post(hardware_public::pair_confirm),
        )
        .route(
            "/api/hardware/pair/cancel",
            post(hardware_public::pair_cancel),
        )
        .route(
            "/api/hardware/identity/reset",
            post(hardware_public::hardware_identity_reset),
        )
        .route("/api/node/token/rotate", post(node_token_rotate))
        // ── Webhook ingress seam (#479, P6a): public URL status + backend ─────
        .route("/api/webhook-ingress/status", get(webhook_ingress_status))
        .route(
            "/api/webhook-ingress/backend",
            get(webhook_ingress_get_backend).post(webhook_ingress_set_backend),
        )
        // Unified webhook registry (webhook-unify #3): list every inbound webhook
        // endpoint with its resolved public URL, secret presence + last delivery.
        .route("/api/webhooks", get(webhooks_list))
        // Explicit secret-management surface. The registry never includes secret
        // values; these routes are only reachable through the protected router and
        // the Webhooks app's `webhooks:crud` host capability.
        .route(
            "/api/webhooks/:id/secret",
            get(webhook_secret_get_authorized).post(webhook_secret_set_authorized),
        )
        // ── MCP catalog (browse + install from the official MCP registry; #464) ──
        .route("/api/mcp/catalog", get(mcp_catalog_list))
        .route("/api/mcp/catalog/detail", get(mcp_catalog_detail))
        .route("/api/mcp/catalog/install", post(mcp_catalog_install))
        // Import a REST API's OpenAPI/Swagger spec as gateway-governed `http` tools.
        .route("/api/tools/import/openapi", post(import_openapi_tools))
        // Import a GraphQL endpoint as a single gateway-governed `http` tool.
        .route("/api/tools/import/graphql", post(import_graphql_tool))
        .route("/api/mcp/updates", get(mcp_updates))
        // ── Knowledge catalog (browse + install OKF bundles via the okf module) ──
        .route("/api/knowledge/catalog", get(knowledge_catalog_list))
        .route(
            "/api/knowledge/catalog/detail",
            get(knowledge_catalog_detail),
        )
        .route(
            "/api/knowledge/catalog/install",
            post(knowledge_catalog_install),
        )
        // ── OKF export (emit Ryu's own indexed knowledge as an OKF bundle) ──
        .route("/api/okf/export", post(okf_export))
        // ── Sandbox enable/disable toggle (M6 / issue #190) ──────────────────
        .route("/api/mcp/sandbox/enable", post(sandbox_enable))
        .route("/api/mcp/sandbox/disable", post(sandbox_disable))
        .route("/api/mcp/sandbox/status", get(sandbox_status))
        .route("/api/chat/stream", post(chat_stream_http))
        // Resolve an interactive tool-permission prompt raised mid-turn by an
        // ACP agent (the desktop echoes the chosen option id here to unblock it).
        .route("/api/chat/permission", post(chat_permission))
        // Resolve a structured Question tool call without starting a new chat
        // turn. The answer is delivered to the pending ACP stream by its
        // conversation + stable tool_call_id pair.
        .route("/api/chat/question", post(chat_question))
        .route(
            "/api/chat/forms",
            get(mcp_forms::list).post(mcp_forms::answer),
        )
        .route("/api/chat/cancel", post(chat_cancel))
        .route("/api/chat/control", post(chat_control))
        // Shared background-process surface. Producers publish snapshots and
        // poll the control queue; Core never kills an arbitrary PID itself.
        .route("/api/background/processes", get(list_background_processes))
        .route(
            "/api/background/processes/sync",
            post(sync_background_process),
        )
        .route(
            "/api/background/processes/release",
            post(release_background_process),
        )
        .route(
            "/api/background/processes/control",
            post(control_background_processes),
        )
        .route(
            "/api/background/processes/:process_id/stop",
            post(stop_background_process),
        )
        // Resume a running chat stream (replay + follow an in-flight turn).
        .route(
            "/api/chat/stream/resume/:conversation_id",
            get(chat_stream_resume),
        )
        // Retry one terminal chat turn claimed by the reconnect-retry plugin.
        .route("/api/chat/retry/:conversation_id", post(chat_retry))
        .route(
            "/api/chat/client-tool-result",
            post(chat_client_tool_result),
        )
        // Device tools (phone apps): pairing, catalog, presence and claim.
        // Behind `mobile.device_tools`; device-lane actions are signed.
        .route("/api/device-tools/devices/pair", post(device_tools_pair))
        .route(
            "/api/device-tools/devices/:device_id/approve-pair",
            post(device_tools_approve_pair),
        )
        .route("/api/device-tools/devices", get(device_tools_devices))
        .route(
            "/api/device-tools/devices/:device_id",
            axum::routing::patch(device_tools_patch_device).delete(device_tools_forget_device),
        )
        .route("/api/device-tools/catalog", get(device_tools_catalog))
        .route("/api/device-tools/presence", post(device_tools_presence))
        .route("/api/device-tools/claim", post(device_tools_claim))
        .route("/api/device-tools/confirm", post(device_tools_confirm))
        .route(
            "/api/device-tools/home-accessories",
            post(device_tools_home_accessories),
        )
        .route("/api/device-tools/stream", get(device_tools_stream))
        .route(
            "/api/chat/browser-session-link",
            post(chat_browser_session_link),
        )
        // Next-prompt suggestions (ChatGPT-style follow-up chips) for a turn.
        .route(
            "/api/chat/suggestions",
            post(chat_suggestions::chat_suggestions),
        )
        // Composer predictions: the user's likely next message, as ghost text.
        .route(
            "/api/chat/prediction",
            post(composer_predictions::chat_prediction),
        )
        // ── Channel bot run endpoint (M11 / #226) ───────────────────────────
        // Channel bots (Telegram, Slack, etc.) call this to turn a single inbound
        // text message into an assembled reply, using the Core session/memory path
        // so bot turns share conversation history with the Core conversation store.
        .route("/api/channels/run", post(channel_run))
        // One-time assistant-first opening used by desktop and authorized channel
        // runtimes. This path persists only the assistant reply.
        .route("/api/proactive/opening", post(proactive_opening))
        // The slash-command menu a channel bot publishes: the same union the
        // desktop composer offers (enabled plugins' commands + enabled skills), so
        // `/proof` in Telegram does what `/proof` in the app does.
        .route("/api/channels/commands", get(channel_commands))
        // Retrieval (index/search over memory+space chunks) is the RAG capability's
        // HTTP surface — gated on the (pre-installed) RAG app, in its own sub-router so a
        // single `route_layer` carries the gate. See `retrieval_routes`.
        .merge(retrieval_routes(&state.app_store))
        // Long-term memory CRUD, gated on the (pre-installed) Memory app. See
        // `memory_routes`. The in-process chat auto-recall path is kernel and untouched.
        .merge(memory_routes(&state.app_store))
        // Message reactions are a native desktop renderer plus Core persistence;
        // the plugin owns whether that surface and its data path are available.
        .merge(message_reaction_routes(&state.app_store))
        // Interactive state of `ui.render` widgets (checklists, forms, calculators),
        // restored when the conversation is reopened.
        .merge(agent_ui_state_routes())
        // Side chats keep their in-process model bridge, but the plugin owns the
        // `/btw` lifecycle and whether the persisted side-chat surface is live.
        .merge(side_chat_routes(&state.app_store))
        // Core-owned paid-plan profile bootstrap. The route remains on the
        // protected chain so node auth and verified user identity are attached
        // before its owner/admin + entitlement checks run.
        // Desktop availability heartbeat + gaming mode (async agent questions).
        .merge(presence_api::routes())
        .merge(onboarding_state::routes())
        .merge(hierarchy_api::routes())
        .merge(onboarding_profile::routes())
        .merge(continuity::router())
        .merge(backups::router())
        // ── Danger zone: irreversible bulk "delete all X" (settings) ─────────
        .route("/api/data/counts", get(data_admin::data_counts))
        .route("/api/data/clear", post(data_admin::data_clear))
        .route("/api/data/purge-user", post(data_user_purge::purge_user))
        .route("/api/app-delegations", post(app_route_delegation_api::mint))
        // Full node wipe → fresh state (arms a marker; wipe runs on next boot).
        .route("/api/node/reset", post(data_admin::node_reset))
        .route("/api/conversations", get(list_conversations))
        // Semantic search over past chat messages (the `search_conversations`
        // capability). Static segment registered before `:id` so it never
        // resolves as a conversation id.
        .route(
            "/api/conversations/search",
            get(search_conversations_handler),
        )
        .route(
            "/api/conversations/:id",
            get(get_conversation).delete(delete_conversation),
        )
        // Promote a client-held temporary transcript into a normal saved chat.
        .route(
            "/api/conversations/:id/save",
            post(save_temporary_conversation_handler),
        )
        .route(
            "/api/conversations/:id/participants",
            get(get_participants_handler).post(add_participant_handler),
        )
        // Branch (fork) a conversation into a new chat.
        .route("/api/conversations/:id/fork", post(fork_conversation))
        .route(
            "/api/conversations/:id/messages/:message_id/edit",
            post(edit_message_handler),
        )
        .route(
            "/api/conversations/:id/messages/:message_id/regenerate",
            post(regenerate_message_handler),
        )
        .route(
            "/api/conversations/:id/messages/:message_id/select",
            post(select_version_handler),
        )
        // Rewind code and/or conversation to the checkpoint before a user turn.
        .route(
            "/api/conversations/:id/checkpoints",
            get(chat_checkpoints::list_chat_checkpoints),
        )
        .route(
            "/api/conversations/:id/checkpoints/:checkpoint_id/changes",
            get(chat_checkpoints::chat_checkpoint_changes),
        )
        .route(
            "/api/conversations/:id/checkpoints/:checkpoint_id/restore",
            post(chat_checkpoints::restore_chat_checkpoint),
        )
        // Thumbs 👍/👎 on an assistant reply: persisted on the message and fanned
        // out to the continual-learning reward + RAG-memory sinks (consent-gated).
        .route(
            "/api/conversations/:id/messages/:message_id/feedback",
            post(set_message_feedback_handler),
        )
        .route(
            "/api/conversations/:id/feedback",
            get(get_conversation_feedback_handler),
        )
        // Per-human read markers for shared conversations. The read endpoint is
        // intentionally separate from the message payload so existing history
        // consumers keep their shape while team viewers can hydrate receipts in
        // one bounded request.
        .route(
            "/api/conversations/:id/read",
            post(mark_conversation_messages_read_handler),
        )
        .route(
            "/api/conversations/:id/read-receipts",
            get(get_conversation_read_receipts_handler),
        )
        // What is filling this conversation's context window, by category. Read
        // model for the desktop Context panel; see `sidecar::adapters::context_breakdown`.
        .route(
            "/api/conversations/:id/context",
            get(get_conversation_context_handler),
        )
        // Pin / archive a conversation. Server-backed so coordinator-thread
        // pins/archives and desktop pins share one source of truth and sync
        // across clients (the same columns the `threads` tool writes).
        .route(
            "/api/conversations/:id/pinned",
            post(set_conversation_pinned_handler),
        )
        .route(
            "/api/conversations/:id/archived",
            post(set_conversation_archived_handler),
        )
        .route(
            "/api/conversations/:id/folder",
            post(set_conversation_folder_handler),
        )
        // Link or unlink a GitHub pull request to a chat (several per chat).
        .route(
            "/api/conversations/:id/pull-requests",
            post(set_conversation_pull_request_handler),
        )
        // Manual rename (ChatGPT/Claude-style). Marks the title user-chosen so the
        // background auto-namer leaves it alone.
        .route(
            "/api/conversations/:id/title",
            post(set_conversation_title_handler),
        )
        .route(
            "/api/conversations/:id/retitle",
            post(retitle_conversation_handler),
        )
}

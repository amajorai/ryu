//! Unit tests that lived in inline `#[cfg(test)] mod …` blocks of `server/mod.rs`.
//! They import `crate::server::*`, which reaches the private items they exercise.

pub(crate) mod source_text;

#[cfg(test)]
mod local_peer_trust_tests;

#[cfg(test)]
mod hierarchy_route_policy_tests;

#[cfg(test)]
mod acp_settings_authorization_tests;

#[cfg(test)]
mod usage_history_authority_tests;

#[cfg(test)]
mod local_egress_route_policy_tests;

#[cfg(test)]
mod security_key_route_policy_tests;

#[cfg(test)]
mod user_personalization_route_policy_tests;

#[cfg(test)]
mod voice_route_policy_tests;

#[cfg(test)]
mod gateway_audit_route_policy_tests;

#[cfg(test)]
mod app_delegation_route_policy_tests;

#[cfg(test)]
mod cloud_environment_route_policy_tests;

#[cfg(test)]
mod vault_operator_read_route_policy_tests;

#[cfg(test)]
mod gateway_status_redaction_tests;

#[cfg(test)]
mod managed_user_authorization_tests;

#[cfg(test)]
mod org_claim_missing_tests;

#[cfg(test)]
mod node_scope_tests;

#[cfg(test)]
mod resource_acl_tests;

#[cfg(test)]
mod agent_control_audit_route_tests;

#[cfg(test)]
mod update_check_wire_shape_tests;

#[cfg(test)]
mod navigation_visibility_tests;

#[cfg(test)]
mod browser_model_preparation_tests;

#[cfg(test)]
mod download_event_frames_tests;

#[cfg(test)]
mod team_runnable_agent_tests;

#[cfg(test)]
mod cancel_conversation_turn_tests;

#[cfg(test)]
mod channel_run_contract_tests;

#[cfg(test)]
mod retrieval_index_contract_tests;

#[cfg(test)]
mod official_materialization_tests;

#[cfg(test)]
mod manifest_agent_identity_tests;

#[cfg(test)]
mod contribution_provenance_tests;

#[cfg(test)]
mod builtin_agent_display_name_tests;

#[cfg(test)]
mod published_agent_descriptor_tests;

#[cfg(test)]
mod local_content_tests;

#[cfg(test)]
mod goal_contract_tests;

#[cfg(test)]
mod imported_thread_merge_tests;

#[cfg(test)]
mod api_import_tests;

#[cfg(test)]
mod sidecar_tool_boundary_tests;

#[cfg(test)]
mod local_host_conversation_scope_tests;

/// The Gateway's chat tool loop executes through `/api/mcp/tools/call`. A call
/// it forwards for an unverified caller's turn is narrowed here too, so a denied
/// tool is refused by Core even if the Gateway's own gate were bypassed.
#[cfg(test)]
mod untrusted_caller_tool_call_tests;

#[cfg(test)]
mod mcp_protocol_version_tests;

#[cfg(test)]
mod mcp_config_mutation_tests;

#[cfg(test)]
mod mcp_endpoint_admission_tests;

#[cfg(test)]
mod exec_scan_route_tests;

#[cfg(test)]
mod tool_search_scope_tests;

#[cfg(test)]
mod conversation_team_scope_tests;

#[cfg(test)]
mod new_space_retrieval_mode_tests;

#[cfg(test)]
mod blob_mime_tests;

#[cfg(test)]
mod transient_embedding_api_tests;

#[cfg(test)]
mod skill_catalog_view_tests;

#[cfg(test)]
mod skill_target_api_contract_tests;

#[cfg(test)]
mod forced_update_tests;

#[cfg(test)]
mod gateway_config_write_tests;

#[cfg(test)]
mod gateway_account_policy_tests;

#[cfg(test)]
mod gateway_provider_account_tests;

#[cfg(test)]
mod red_team_campaign_tests;

#[cfg(test)]
mod workflow_run_body_tests;

#[cfg(test)]
mod scheduled_job_visibility_tests;

// NOTE: the former `double_check_tests` module was removed — it tested
// `parse_double_check_verdict`, which was deleted when the goal/double-check path
// moved to the plugin runtime (commit 10ca382c). The stale test broke the core
// test binary; it is gone with the function it covered.

// ── Connection-identity header parsing tests ─────────────────────────────────

#[cfg(test)]
mod remote_auth_tests;

#[cfg(test)]
mod gateway_policy_notice_tests;

#[cfg(test)]
mod gateway_policy_patch_tests;

#[cfg(test)]
mod context_budget_tests;

#[cfg(test)]
mod connection_identity_tests;

// ── Plugins catalog merge tests ──────────────────────────────────────────────

#[cfg(test)]
mod plugin_catalog_tests;

// ── App-enable MCP filter tests (AC3 / issue #169) ───────────────────────────

#[cfg(test)]
mod app_tool_filter_tests;

#[cfg(test)]
mod auto_recall_pref_tests;

#[cfg(test)]
mod fts_recall_pref_tests;

#[cfg(test)]
mod ssrf_host_guard_tests;

#[cfg(test)]
mod agent_egress_screen_tests;

/// The App route gate ([`require_app_enabled`]) — the extension point that makes a
/// feature pluginizable without moving its code out of the crate.
///
/// Tested against a stand-in router rather than the real `/api/meetings/*` mount,
/// because the gate is deliberately independent of [`ServerState`]: it takes only a
/// [`PluginStore`], so it can be exercised end-to-end (real store, real middleware,
/// real refusal body) without standing up a Core. The real mount wires the exact
/// same layer — see `meetings_routes`.
#[cfg(test)]
mod app_gate_tests;

#[cfg(test)]
mod mcp_plugin_governance_tests;

// ── require_auth node-admittance middleware ──────────────────────────────────
//
// The single highest-stakes surface in this file: the node bearer gate every
// protected route inherits. Organization-bound managed nodes also admit a
// verified Better Auth user JWT as a scoped primary bearer; local and unbound
// nodes remain node-token-only. Driven through stand-in Router tests so the
// constant-time node-token match, fail-closed branches, and managed role ceiling
// stay pinned.
//
// `registered_org()` is `None` in tests (only the network-gated registration
// path ever writes it), so managed user-JWT admission remains unavailable and
// every unbound node stays strictly node-token gated.
#[cfg(test)]
mod require_auth_tests;

// ── Pure request/parse/format helpers ────────────────────────────────────────
//
// The thin, DB-less logic scattered through the god module: constant-time token
// compare, header extraction, error-envelope framing, webhook freshness/dedup,
// slug/version/URL helpers, and the unbound-node invariants of the tenancy
// resolvers. Each is a real branch (security carve-out, replay guard, fail-open
// default), not an assertion pad.
#[cfg(test)]
mod pure_helper_tests;

#[cfg(test)]
mod per_resource_gate_tests;

#[cfg(test)]
mod enrolled_unregistered_node_tests;

/// The `/api/output-styles` surface, driven end-to-end through Core's own
/// [`output_styles_routes`] rather than a hand-rebuilt stand-in of it — the mount
/// (prefix, nesting, and the fact that no handler needs `State`) is exactly what a
/// mistake here would break.
///
/// The whole module holds [`ryu_output_styles::OUTPUT_STYLES_ENV_LOCK`]: both env
/// vars it redirects are process-global, and without the lock a parallel test's
/// `remove_var` would drop the redirect mid-run and the `select` write would land in
/// the developer's real `~/.claude/output-styles`.
///
/// One process-global side effect is deliberate and cannot be undone: the first call
/// to [`output_style_registry`] publishes the registry into the crate's `OnceLock`
/// for the rest of the test binary, pointed at this module's tempdir. Nothing else in
/// `ryu-core` touches output styles, so that is contained — but a future test that
/// does must reuse this registry rather than expect a fresh one.
///
/// `await_holding_lock` is allowed on purpose and is the entire point of the guard:
/// the env redirect has to stay in force across the HTTP calls, which are the part
/// that reads it. These are `#[tokio::test]`s on a multi-test runtime, so the
/// deadlock the lint warns about (a blocking guard starving the executor) needs a
/// second task contending for the same mutex — and the mutex is only ever taken by
/// tests that are serialized by it anyway.
#[cfg(test)]
#[allow(clippy::await_holding_lock)]
mod output_styles_route_tests;

#[cfg(test)]
mod acp_selections_query_tests;

#[cfg(test)]
mod agent_resource_permission_runner_tests;

#[cfg(test)]
mod llamacpp_acceleration_tests;

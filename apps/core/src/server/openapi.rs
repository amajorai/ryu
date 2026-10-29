//! OpenAPI spec for the Core HTTP API, generated from the Axum handlers.
//!
//! Handlers are annotated with `#[utoipa::path(...)]` next to their definition in
//! `server/mod.rs`; this module collects them into one [`ApiDoc`]. As a child of
//! `server`, it can reference the parent's private handler functions (and the
//! `__path_*` items the macro generates beside them).
//!
//! The spec is consumed two ways:
//! - `ryu-core --dump-openapi` prints it (used by `apps/fumadocs` to render the
//!   interactive API reference; see `apps/fumadocs/scripts/generate-docs.ts`).
//! - `GET /api/openapi.json` serves it from a running Core.
//!
//! Adding an endpoint is mechanical: put `#[utoipa::path(...)]` on the handler,
//! then add it to the `paths(...)` list below.

use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Ryu Core API",
        version = "0.1.0",
        description = "The local Ryu Core orchestration backend. Default bind 127.0.0.1:7980 (override with --bind / RYU_BIND). When RYU_TOKEN is set, protected routes require `Authorization: Bearer <RYU_TOKEN>`; health and auth routes are public.",
        license(name = "Apache-2.0")
    ),
    servers((url = "http://localhost:7980", description = "Local Core")),
    tags(
        (name = "Health", description = "Liveness, version, and updates."),
        (name = "Auth", description = "Device authorization flow."),
        (name = "Nodes", description = "Node initialization."),
        (name = "Backups", description = "Encrypted S3 backups, schedules, retention and recovery for nodes, Spaces and apps."),
        (name = "Sidecars", description = "Engine/tool/agent install + lifecycle."),
        (name = "Models", description = "Model catalog (HF GGUF) + device fit."),
        (name = "Catalog", description = "Per-kind catalog sources."),
        (name = "Skills", description = "Agent Skills install + activation."),
        (name = "Engines", description = "Engine runtimes + active-engine swap."),
        (name = "Plugins", description = "Plugin (app) catalog + lifecycle."),
        (name = "Agents", description = "Agent CRUD, catalog, import/export."),
        (name = "Prompt Evals", description = "Promptfoo-compatible suites, runs, versions, and human review."),
        (name = "Annotation Queues", description = "Human review queues over runs, messages, and traces, with export to prompt suites."),
        (name = "Teams", description = "Agent teams + members."),
        (name = "MCP", description = "MCP servers, tools, catalog, sandbox."),
        (name = "Actions", description = "Canonical governed Action calls."),
        (name = "Tools", description = "Unified tool catalog (search/describe) + PTC exec."),
        (name = "Chat", description = "Chat, channels, delegation."),
        (name = "Retrieval", description = "Chunk indexing + search."),
        (name = "Conversations", description = "Conversations, sessions, and runs."),
        (name = "Harness", description = "Durable, replayable agent sessions and runs."),
        (name = "Spaces", description = "Spaces/RAG documents + embeddings."),
        (name = "Downloads", description = "Download center."),
        (name = "Worktree", description = "Per-run git worktrees."),
        (name = "Gateway", description = "Gateway config/status/audit (proxied)."),
        (name = "Workflows", description = "Workflow DAG engine."),
        (name = "Preferences", description = "Cross-surface preferences KV."),
        (name = "Vault", description = "Encrypted user-managed secret metadata and bindings."),
        (name = "Usage Review", description = "On-demand conversation and activity reviews."),
        (name = "Presence", description = "User availability and presence settings."),
(name = "Activity", description = "Activity API endpoints."),
        (name = "Approvals", description = "Approvals API endpoints."),
        (name = "Clips", description = "Clips API endpoints."),
        (name = "Composio", description = "Composio API endpoints."),
        (name = "Core", description = "Core API endpoints."),
        (name = "Dashboards", description = "Dashboards API endpoints."),
        (name = "Data", description = "Data API endpoints."),
        (name = "Events", description = "Events API endpoints."),
        (name = "Finetune", description = "Finetune API endpoints."),
        (name = "Git", description = "Git API endpoints."),
        (name = "Hardware", description = "Hardware API endpoints."),
        (name = "Healing", description = "Healing API endpoints."),
        (name = "Knowledge", description = "Knowledge API endpoints."),
        (name = "Learning", description = "Learning API endpoints."),
        (name = "Improvement", description = "Recursive-improvement records and lifecycle transitions."),
        (name = "Media", description = "Media API endpoints."),
        (name = "Meetings", description = "Meetings API endpoints."),
        (name = "Memory", description = "Memory API endpoints."),
        (name = "Monitors", description = "Monitors API endpoints."),
        (name = "Notifications", description = "Notifications API endpoints."),
        (name = "Predict", description = "Predict API endpoints."),
        (name = "Quests", description = "Quests API endpoints."),
        (name = "Recipes", description = "Recipes API endpoints."),
        (name = "Research", description = "Research API endpoints."),
        (name = "Sandboxes", description = "Sandboxes API endpoints."),
        (name = "Support", description = "Support API endpoints."),
        (name = "Voice", description = "Voice API endpoints."),
        (name = "Widgets", description = "Widgets API endpoints."),
    ),
    paths(
        super::qoder_api::global_completions,
        super::qoder_api::cn_completions,
        super::qoder_api::global_models,
        super::qoder_api::cn_models,
        super::backups::overview,
        super::backups::recovery_key,
        super::backups::create_destination,
        super::backups::update_destination,
        super::backups::remove_destination,
        super::backups::test_destination,
        super::backups::list_backups,
        super::backups::save_policy,
        super::backups::remove_policy,
        super::backups::create_backup,
        super::backups::restore_backup,
        super::backups::operation,
        super::health,
        serve_openapi,
        super::get_version,
        super::auth_status,
        super::update_check,
        super::update_apply,
        super::node_init,
        super::auth_login,
        super::auth_logout,
        super::auth_accounts_list,
        super::auth_accounts_switch,
        super::auth_accounts_remove,
        super::get_catalog,
        super::refresh_public_marketplace_catalog,
        super::catalog_scan::scan,
        super::models_catalog_list,
        super::models_catalog_detail,
        super::models_catalog_install,
        super::models_catalog_uninstall,
        super::models_device,
        super::models_context_window,
        super::models_insight,
        super::models_engines,
        super::system_info_handler,
        super::catalog_sources_list,
        super::catalog_sources_add,
        super::catalog_sources_remove,
        super::catalog_sources_select,
        super::skills_catalog_list,
        super::skills_catalog_detail,
        super::skills_catalog_install,
        super::skills_targets,
        super::skills_target_preferences_put,
        super::skills_target_preferences_delete,
        super::skills_distribute,
        super::skills_install_from_source,
        super::onboarding_state::get_skills,
        super::onboarding_state::put_skills,
        // (`skills_activate` + `list_skills` moved to `ryu_skills::api`, merged below)
        super::list_engines,
        super::engine_models,
        super::engine_launch_options,
        super::system_status,
        super::list_apps,
        super::list_apps_catalog,
        super::install_app_from_url,
        super::reload_app_manifests,
        super::mcp_oauth_api::list,
        super::mcp_oauth_api::connect,
        super::mcp_oauth_api::flow,
        super::mcp_oauth_api::disconnect,
        super::install_app_handler,
        super::enable_app_handler,
        super::disable_app_handler,
        super::plugin_uninstall::inventory_handler,
        super::uninstall_app_handler,
        super::update_app_handler,
        super::plugin_rollback::rollback_app_handler,
        super::list_agents,
        super::create_agent,
        super::list_agent_catalog,
        super::install_agent_handler,
        super::uninstall_agent_handler,
        super::import_agent,
        super::published_agent_install,
        super::get_agent,
        super::update_agent,
        super::list_agent_versions,
        super::create_agent_version,
        super::get_agent_version,
        super::restore_agent_version,
        super::list_agent_prompt_versions,
        super::create_agent_prompt_version,
        super::get_agent_prompt_version,
        super::restore_agent_prompt_version,
        super::list_prompt_suites,
        super::create_prompt_suite,
        super::get_prompt_suite,
        super::update_prompt_suite,
        super::delete_prompt_suite,
        super::list_prompt_suite_versions,
        super::create_prompt_suite_version,
        super::get_prompt_suite_version,
        super::restore_prompt_suite_version,
        super::import_prompt_trace,
        super::list_prompt_runs,
        super::save_prompt_run,
        super::get_prompt_run,
        super::rename_prompt_run,
        super::delete_prompt_run,
        super::duplicate_prompt_run,
        super::list_prompt_reviews,
        super::save_prompt_review,
        super::annotation_queues_api::list_annotation_queues,
        super::annotation_queues_api::create_annotation_queue,
        super::annotation_queues_api::get_annotation_queue,
        super::annotation_queues_api::update_annotation_queue,
        super::annotation_queues_api::delete_annotation_queue,
        super::annotation_queues_api::list_annotation_items,
        super::annotation_queues_api::add_annotation_items,
        super::annotation_queues_api::get_annotation_item,
        super::annotation_queues_api::assign_annotation_item,
        super::annotation_queues_api::delete_annotation_item,
        super::annotation_queues_api::submit_annotation_item,
        super::annotation_queues_api::next_annotation_item,
        super::annotation_queues_api::export_annotation_queue,
        super::delete_agent,
        super::export_agent,
        super::list_tools,
        super::migrate_to_ryu,
        super::get_pi_config,
        super::put_pi_config,
        super::get_pi_config_catalog,
        super::configure_pi_provider,
        super::check_pi_provider,
        super::set_pi_model_enabled,
        super::delete_pi_provider,
        super::pi_provider_accounts,
        super::pi_provider_account_switch,
        super::pi_provider_account_remove,
        super::discover_pi_models,
        super::acp_authenticate,
        super::native_accounts::list,
        super::native_accounts::create,
        super::native_accounts::login,
        super::native_accounts::progress,
        super::native_accounts::cancel,
        super::native_accounts::disconnect,
        super::native_accounts::logout,
        super::acp_accounts,
        super::acp_account_switch,
        super::acp_account_remove,
        super::list_acp_sessions_handler,
        super::delete_acp_session_handler,
        super::agent_update_check,
        super::agent_update,
        // Teams `/api/teams/*` handlers live in the out-of-process `ryu-teams`
        // sidecar, which owns their spec too — nothing is merged here (see below).
        super::list_mcp_servers,
        super::create_mcp_server,
        super::list_mcp_tools,
        super::call_mcp_tool,
        super::call_action,
        super::exec_scan,
        super::tools_search,
        super::tools_describe,
        super::tools_exec,
        super::tools_exec_resume,
        super::identity_api::list_identities,
        super::identity_api::create_connection,
        super::identity_api::begin_login,
        super::identity_api::poll_connection,
        super::identity_api::import_connection,
        super::identity_api::delete_connection,
        super::vault_api::list_secrets,
        super::vault_kv_api::get_metadata,
        super::vault_kv_api::patch_metadata,
        super::vault_kv_api::patch_data,
        super::vault_kv_api::subkeys,
        super::vault_kv_api::delete_versions,
        super::vault_kv_api::undelete_versions,
        super::vault_api::put_secret,
        super::vault_api::delete_secret,
        super::vault_api::list_versions,
        super::vault_api::secret_action,
        super::vault_policy_ext_api::capabilities_self,
        super::vault_policy_ext_api::list_control_groups,
        super::vault_policy_ext_api::get_control_group,
        super::vault_policy_ext_api::authorize_control_group,
        super::vault_policy_ext_api::redeem_control_group,
        super::vault_api::export,
        super::vault_api::import,
        super::vault_api::snapshot_export,
        super::vault_api::scan,
        super::vault_api::list_environments,
        super::vault_api::put_environment,
        super::vault_api::delete_environment,
        super::vault_api::list_folders,
        super::vault_api::create_folder,
        super::vault_api::delete_folder,
        super::vault_api::list_imports,
        super::vault_api::add_import,
        super::vault_api::remove_import,
        super::vault_api::list_policies,
        super::vault_api::put_policy,
        super::vault_api::delete_policy,
        super::vault_api::add_binding,
        super::vault_api::remove_binding,
        super::vault_api::list_change_requests,
        super::vault_api::decide_change_request,
        super::vault_api::list_audit,
        super::vault_api::verify_audit,
        super::vault_audit_events_api::list_devices,
        super::vault_audit_events_api::put_device,
        super::vault_audit_events_api::delete_device,
        super::vault_audit_events_api::audit_hash,
        super::vault_audit_events_api::init_apply,
        super::vault_audit_events_api::events,
        super::vault_audit_events_api::agent_events,
        super::vault_api::sys_status,
        super::vault_api::sys_action,
        super::vault_api::migrate_shared,
        super::vault_engines_api::transit_list,
        super::vault_engines_api::transit_create,
        super::vault_engines_api::transit_configure,
        super::vault_engines_api::transit_delete,
        super::vault_engines_api::transit_operation,
        super::vault_engines_api::pki_issuers,
        super::vault_engines_api::pki_create_issuer,
        super::vault_engines_api::pki_roles,
        super::vault_engines_api::pki_put_role,
        super::vault_engines_api::pki_delete_role,
        super::vault_engines_api::pki_operation,
        super::vault_engines_api::pki_revoke,
        super::vault_engines_api::pki_certs,
        super::vault_engines_api::pki_crl,
        super::vault_engines_api::ssh_cas,
        super::vault_engines_api::ssh_create_ca,
        super::vault_engines_api::ssh_roles,
        super::vault_engines_api::ssh_put_role,
        super::vault_engines_api::ssh_delete_role,
        super::vault_engines_api::ssh_sign,
        super::vault_engines_api::dynamic_roles,
        super::vault_engines_api::dynamic_put_role,
        super::vault_engines_api::dynamic_delete_role,
        super::vault_engines_api::dynamic_revoke_role,
        super::vault_engines_api::dynamic_issue,
        super::vault_engines_api::leases,
        super::vault_engines_api::lease_operation,
        super::vault_engines_api::machines,
        super::vault_engines_api::machine_create,
        super::vault_engines_api::machine_update,
        super::vault_engines_api::machine_delete,
        super::vault_engines_api::machine_issue_secret_id,
        super::vault_engines_api::machine_secret_ids,
        super::vault_engines_api::machine_revoke_secret_id,
        super::vault_engines_api::token_revoke,
        super::vault_engines_api::approle_login,
        super::vault_engines_api::jwt_login,
        super::vault_engines_api::agent_self,
        super::vault_engines_api::agent_revoke_self,
        super::vault_engines_api::agent_export,
        super::vault_engines_api::agent_secret,
        super::vault_engines_api::agent_dynamic_issue,
        super::vault_engines_api::agent_lease_operation,
        super::vault_engines_api::agent_transit,
        super::vault_engines_api::agent_pki,
        super::vault_engines_api::agent_ssh_sign,
        super::vault_totp_pwpolicy_api::totp_list,
        super::vault_totp_pwpolicy_api::totp_create,
        super::vault_totp_pwpolicy_api::totp_get,
        super::vault_totp_pwpolicy_api::totp_delete,
        super::vault_totp_pwpolicy_api::totp_code,
        super::vault_totp_pwpolicy_api::totp_validate,
        super::vault_totp_pwpolicy_api::agent_totp_code,
        super::vault_totp_pwpolicy_api::agent_totp_validate,
        super::vault_totp_pwpolicy_api::password_policy_list,
        super::vault_totp_pwpolicy_api::password_policy_get,
        super::vault_totp_pwpolicy_api::password_policy_put,
        super::vault_totp_pwpolicy_api::password_policy_delete,
        super::vault_totp_pwpolicy_api::password_policy_generate,
        super::vault_totp_pwpolicy_api::agent_password_policy_generate,
        super::vault_agent_accounts_api::account_list,
        super::vault_agent_accounts_api::account_create,
        super::agent_composio_api::agent_composio_connections,
        super::agent_composio_api::agent_composio_connection_initiate,
        super::agent_composio_api::agent_composio_connection_status,
        super::agent_composio_api::agent_composio_connection_disconnect,
        super::agent_launch_check_api::agent_launch_check,
        super::vault_items_api::item_list,
        super::vault_items_api::item_put,
        super::vault_items_api::item_get,
        super::vault_items_api::item_patch,
        super::vault_items_api::item_delete,
        super::vault_items_api::item_reveal,
        super::vault_items_api::item_events,
        super::vault_items_api::item_fill,
        super::vault_items_api::card_approval_list,
        super::vault_items_api::card_approval_get,
        super::vault_items_api::card_approval_approve,
        super::vault_items_api::card_approval_reject,
        super::vault_items_api::card_approval_revoke,
        super::vault_seal_dynamic_api::seal_provider_status,
        super::vault_seal_dynamic_api::seal_provider_configure,
        super::vault_seal_dynamic_api::seal_provider_remove,
        super::vault_seal_dynamic_api::seal_provider_unseal,
        super::vault_seal_dynamic_api::rekey_status,
        super::vault_seal_dynamic_api::rekey_operation,
        super::vault_seal_dynamic_api::static_list,
        super::vault_seal_dynamic_api::static_get,
        super::vault_seal_dynamic_api::static_put,
        super::vault_seal_dynamic_api::static_delete,
        super::vault_seal_dynamic_api::static_rotate,
        super::vault_seal_dynamic_api::static_creds,
        super::vault_seal_dynamic_api::cert_login,
        super::vault_seal_dynamic_api::aws_login,
        super::vault_seal_dynamic_api::kubernetes_login,
        super::vault_crypto_api::transit_wrapping_key,
        super::vault_crypto_api::transit_deleted,
        super::vault_crypto_api::transit_import,
        super::vault_crypto_api::transit_import_version,
        super::vault_crypto_api::transit_trim,
        super::vault_crypto_api::transit_recover,
        super::vault_crypto_api::transit_export_all,
        super::vault_crypto_api::transit_export_version,
        super::vault_crypto_api::transit_backup,
        super::vault_crypto_api::transit_restore,
        super::vault_crypto_api::pki_generate_intermediate,
        super::vault_crypto_api::pki_set_signed,
        super::vault_crypto_api::pki_import_issuer,
        super::vault_crypto_api::pki_sign_intermediate,
        super::vault_crypto_api::pki_tidy,
        super::vault_crypto_api::identity_config,
        super::vault_crypto_api::identity_set_config,
        super::vault_crypto_api::identity_rotate,
        super::vault_crypto_api::identity_roles,
        super::vault_crypto_api::identity_put_role,
        super::vault_crypto_api::identity_delete_role,
        super::vault_crypto_api::identity_token,
        super::vault_crypto_api::agent_identity_token,
        super::vault_crypto_api::identity_discovery,
        super::vault_crypto_api::identity_jwks,
        super::vault_tokens_api::token_list,
        super::vault_tokens_api::token_create,
        super::vault_tokens_api::token_lookup_accessor,
        super::vault_tokens_api::token_renew_accessor,
        super::vault_tokens_api::token_revoke_orphan,
        super::vault_tokens_api::machine_token_config,
        super::vault_tokens_api::token_roles,
        super::vault_tokens_api::token_role_get,
        super::vault_tokens_api::token_role_put,
        super::vault_tokens_api::token_role_delete,
        super::vault_tokens_api::sys_leases,
        super::vault_tokens_api::sys_lease_count,
        super::vault_tokens_api::sys_lease_lookup,
        super::vault_tokens_api::sys_lease_revoke_prefix,
        super::vault_tokens_api::sys_lease_tidy,
        super::vault_tokens_api::sys_quotas,
        super::vault_tokens_api::sys_quota_put,
        super::vault_tokens_api::sys_quota_delete,
        super::vault_tokens_api::sys_wrap,
        super::vault_tokens_api::agent_wrap,
        super::vault_tokens_api::sys_unwrap,
        super::vault_tokens_api::sys_wrap_lookup,
        super::vault_tokens_api::sys_rewrap,
        super::vault_tokens_api::agent_lookup_self,
        super::vault_tokens_api::agent_renew_self,
        super::vault_tokens_api::agent_create_child,
        super::vault_tokens_api::cubbyhole_list,
        super::vault_tokens_api::cubbyhole_get,
        super::vault_tokens_api::cubbyhole_put,
        super::vault_tokens_api::cubbyhole_delete,
        super::vault_broker_api::broker_status,
        super::vault_broker_api::broker_ca,
        super::vault_broker_api::broker_catalog,
        super::vault_broker_api::list_services,
        super::vault_broker_api::create_service,
        super::vault_broker_api::get_service,
        super::vault_broker_api::put_service,
        super::vault_broker_api::delete_service,
        super::vault_broker_api::service_usage,
        super::vault_broker_api::get_environment,
        super::vault_broker_api::put_environment,
        super::vault_broker_api::create_session,
        super::vault_broker_api::list_sessions,
        super::vault_broker_api::revoke_session,
        super::vault_broker_api::list_logs,
        super::vault_broker_api::discovered_hosts,
        super::vault_broker_api::list_proposals,
        super::vault_broker_api::approve_proposal,
        super::vault_broker_api::reject_proposal,
        super::vault_broker_api::agent_create_session,
        super::vault_broker_api::agent_discover,
        super::vault_broker_api::agent_create_proposal,
        super::vault_broker_api::agent_get_proposal,
        super::vault_broker_api::agent_get_card_approval,
        super::vault_external_api::store_list,
        super::vault_external_api::store_create,
        super::vault_external_api::store_delete,
        super::vault_external_api::store_test,
        super::vault_external_api::source_list,
        super::vault_external_api::source_create,
        super::vault_external_api::source_delete,
        super::vault_external_api::source_sync,
        super::vault_external_api::destination_list,
        super::vault_external_api::destination_create,
        super::vault_external_api::destination_delete,
        super::vault_external_api::destination_push,
        super::vault_pm_api::account_list,
        super::vault_pm_api::account_create,
        super::vault_pm_api::account_delete,
        super::vault_pm_api::account_test,
        super::vault_pm_api::account_token,
        super::vault_pm_api::read_reference,
        super::vault_pm_api::grant_list,
        super::vault_pm_api::grant_revoke,
        super::vault_pm_api::approval_list,
        super::vault_pm_api::approval_decide,
        super::mesh_status,
        super::mesh_peers,
        super::mesh_config,
        super::local_egress_api::desktop_status,
        super::local_egress_api::desktop_configure,
        super::local_egress_api::route_status,
        super::local_egress_api::route_detach,
        super::local_egress_api::route_ws,
        super::local_egress_api::provider_routes,
        super::local_egress_api::configure_provider_route,
        super::webhook_ingress_status,
        super::webhook_ingress_get_backend,
        super::webhook_ingress_set_backend,
        super::webhooks_list,
        super::webhook_secret_get,
        super::webhook_secret_set,
        super::mcp_catalog_list,
        super::mcp_catalog_detail,
        super::mcp_catalog_install,
        super::sandbox_enable,
        super::sandbox_disable,
        super::sandbox_status,
        super::chat_stream,
        super::chat_cancel,
        super::chat_control,
        super::channel_run,
        super::channel_commands,
        super::index_retrieval_chunk,
        super::search_retrieval,
        super::list_conversations,
        super::search_conversations_handler,
        super::get_conversation,
        super::chat_checkpoints::list_chat_checkpoints,
        super::chat_checkpoints::chat_checkpoint_changes,
        super::chat_checkpoints::restore_chat_checkpoint,
        super::conversation_history::preview,
        super::conversation_history::preview_custom,
        super::conversation_history::save,
        super::conversation_history::list,
        super::conversation_history::get,
        super::conversation_history::import,
        super::conversation_history::sync,
        super::delete_conversation,
        super::save_temporary_conversation_handler,
        super::fork_conversation,
        super::set_conversation_pinned_handler,
        super::set_conversation_archived_handler,
        super::set_conversation_folder_handler,
        super::set_conversation_pull_request_handler,
        super::set_conversation_title_handler,
        super::retitle_conversation_handler,
        super::get_conversation_title_history_handler,
        super::get_conversation_model_selection_handler,
        super::set_conversation_model_selection_handler,
        super::get_conversation_context_handler,
        super::continuity::export_conversation,
        super::continuity::resume_conversation,
        super::continuity::workspace::capabilities,
        super::continuity::workspace::inspect_workspace,
        super::continuity::workspace::export_workspace,
        super::continuity::workspace::get_blob,
        super::continuity::workspace::head_blob,
        super::continuity::workspace::put_blob,
        super::continuity::workspace::resume_workspace,
        super::continuity::workspace::mark_continued,
        super::continuity::workspace::clear_continued,
        super::get_participants_handler,
        super::add_participant_handler,
        super::remove_participant_handler,
        super::list_runs_handler,
        super::runs_stream,
        super::trace_api::get_run_trace_handler,
        super::trace_api::list_traces_handler,
        super::create_session_handler,
        super::get_session_handler,
        super::update_session_status_handler,
        super::list_sessions_for_conversation_handler,
        super::harness::create_harness_session_handler,
        super::harness::get_harness_session_handler,
        super::harness::list_child_harness_sessions_handler,
        super::harness::bind_native_session_handler,
        super::harness::list_harness_runs_handler,
        super::harness::start_harness_run_handler,
        super::harness::get_harness_run_handler,
        super::harness::harness_run_events_handler,
        super::harness::cancel_harness_run_handler,
        super::list_agent_threads_handler,
        super::import_agent_thread_handler,
        super::data_admin::data_counts,
        super::data_admin::data_clear,
        super::language_packs::installed,
        super::language_packs::import,
        super::onboarding_state::get_state,
        super::onboarding_state::put_state,
        super::onboarding_state::delete_state,
        super::onboarding_profile::access,
        super::onboarding_profile::profile_availability,
        super::onboarding_profile::start,
        super::onboarding_profile::status,
        super::onboarding_profile::cancel,
        super::onboarding_profile::background,
        super::list_spaces,
        super::search_space_documents,
        super::create_space,
        super::import_space_package,
        super::export_space_package,
        super::rename_space,
        super::delete_space,
        super::list_documents,
        super::ingest_document,
        super::get_document,
        super::update_document,
        super::delete_document,
        super::create_page,
        super::query_space_database,
        super::search_space,
        super::get_space_chunking,
        super::set_space_chunking,
        super::set_retrieval_mode,
        super::retrieval_mode_status,
        super::cancel_retrieval_mode,
        // The `document.parse` facade: capability read model, submit, and poll.
        crate::document_parse::parse_capability,
        crate::document_parse::parse_document,
        crate::document_parse::parse_job,
        super::embed_texts,
        super::get_embedding_model,
        super::set_embedding_model,
        super::trigger_reindex,
        super::reindex_status,
        super::oai_chat_completions,
        super::list_installed,
        super::get_install_status,
        super::get_install_status_by_name,
        super::install_sidecar,
        super::uninstall_sidecar,
        super::uninstall_sidecar_with_data,
        super::check_installed,
        super::list_downloads,
        super::downloads_stream,
        super::download_pause,
        super::download_resume,
        super::download_retry,
        super::download_cancel,
        super::download_clear,
        super::prepare_browser_model,
        super::check_dependencies,
        super::install_dependencies,
        super::sidecar_status,
        super::sidecar_start_all,
        super::sidecar_stop_all,
        super::sidecar_start,
        super::sidecar_stop,
        super::sidecar_restart,
        super::get_active_engine,
        super::set_active_engine,
        super::get_llamacpp_acceleration,
        super::set_llamacpp_acceleration,
        super::get_active_model,
        super::set_active_model,
        super::worktree_diff_handler,
        super::worktree_apply_handler,
        super::gateway_get_config,
        super::gateway_put_config,
        super::gateway_phone_calls::list,
        super::gateway_phone_calls::start,
        super::gateway_phone_calls::available_numbers,
        super::gateway_phone_calls::purchase_number,
        super::gateway_phone_calls::verify_caller_id,
        super::gateway_phone_calls::control,
        super::gateway_phone_calls::handoff,
        super::gateway_phone_calls::hangup,
        super::gateway_phone_calls::transcript,
        super::gateway_doctor,
        super::gateway_doctor_fix,
        super::plugin_doctor,
        super::plugin_evals,
        super::plugin_evals_run,
        super::gateway_get_evaluators,
        super::gateway_status,
        super::gateway_restart,
        super::gateway_set_provider,
        super::gateway_apply_providers,
        super::governance::get_gateway_governance,
        super::governance::put_gateway_governance,
        super::governance::get_org_features,
        super::gateway_speech_settings::gateway_speech_settings_get,
        super::gateway_speech_settings::gateway_speech_settings_put,
        super::gateway_run_evals,
        super::gateway_score_online,
        super::gateway_batch_create,
        super::gateway_batches_list,
        super::gateway_batch_get,
        super::gateway_batch_delete,
        super::gateway_redteam_run,
        super::gateway_audit,
        super::my_gateway_usage,
        super::gateway_audit_usage,
        super::gateway_audit_prune,
        super::list_workflow_templates,
        super::get_workflow_template,
        super::install_workflow_template,
        super::list_workflows,
        super::create_workflow,
        super::get_workflow,
        super::delete_workflow,
        super::run_workflow,
        super::get_workflow_run,
        super::resume_workflow_run,
        super::continue_workflow_run,
        super::workflow_run_history,
        super::fork_workflow_run,
        super::delegate_stream,
        super::preferences_stream,
        super::get_preference,
        super::set_preference,
        super::get_safe_mode,
        super::set_safe_mode,
        super::get_capability_bindings,
        super::set_capability_bindings,
// Activity
        super::activity_api::activity_stream,
        super::activity_api::create_activity,
        super::activity_api::list_activity,
        // Agents
        super::acp_config,
        super::get_acp_agent_settings,
        super::put_acp_agent_settings,
        super::acp_logout,
        super::agent_capabilities,
        super::usage_api::agent_usage,
        super::usage_api::provider_account_usage,
        super::oauth_pool_policy::get_policy,
        super::oauth_pool_policy::put_policy,
        super::usage_api::provider_credits,
        super::usage_api::subscription_cost_usage,
        super::usage_api::subscriptions,
        super::usage_api::subscription_reading,
        super::usage_api::conversation_provider_account,
        crate::usage_history::http::history,
        crate::usage_history::http::import,
        crate::usage_history::http::import_operation,
        crate::usage_history::http::account_sync,
        crate::usage_history::http::tracking,
        crate::usage_history::http::set_tracking,
        super::usage_api::set_subscription_cost_tracking,
        super::usage_review::get_review,
        super::usage_review::get_settings,
        super::usage_review::put_settings,
        // Presence, gaming, and streaming mode
        super::presence_api::get_presence,
        super::presence_api::put_presence,
        super::presence_api::get_gaming_settings,
        super::presence_api::put_gaming_settings,
        super::presence_api::get_streaming_settings,
        super::presence_api::put_streaming_settings,
        // Threshold-driven model fallback
        super::routing_api::advice,
        super::routing_api::get_policy,
        super::routing_api::put_policy,
        super::routing_api::get_retry_policy,
        super::routing_api::put_retry_policy,
        super::load_acp_session_handler,
        super::set_agent_capabilities,
        // Approvals
        super::approvals_api::approval_events,
        super::approvals_api::approve_approval,
        super::approvals_api::get_approval,
        super::approvals_api::get_mode,
        super::approvals_api::list_approvals,
        super::approvals_api::reject_approval,
        super::approvals_api::set_mode,
        // Chat
        super::btw_handler,
        super::delete_btw_handler,
        super::chat_permission,
        super::chat_question,
        super::mcp_forms::list,
        super::mcp_forms::answer,
        super::chat_retry,
        super::chat_stream_resume,
        super::chat_client_tool_result,
        super::chat_browser_session_link,
        super::chat_suggestions::chat_suggestions,
        super::composer_predictions::chat_prediction,
        // Clips → feature-gated sub-doc merged in `api_doc()` (see Research note).
        // Composio
        super::connect_events::consume,
        super::connect_events::bind_target,
        super::composio_actions,
        super::composio_connection_initiate,
        super::composio_connection_complete,
        super::composio_connection_status,
        super::composio_connections,
        super::composio_status,
        super::composio_toolkits,
        super::composio_trigger_delete,
        super::composio_trigger_list,
        super::composio_trigger_subscribe,
        super::composio_triggers,
        super::composio_webhook,
        // Conversations
        super::add_message_reaction_handler,
        super::edit_message_handler,
        super::get_agent_ui_state_handler,
        super::get_conversation_feedback_handler,
        super::get_conversation_reactions_handler,
        super::get_conversation_read_receipts_handler,
        super::mark_conversation_messages_read_handler,
        super::put_agent_ui_state_handler,
        super::regenerate_message_handler,
        super::remove_message_reaction_handler,
        super::select_version_handler,
        super::set_message_feedback_handler,
        // Core
        super::list_btw_handler,
        super::ws_ticket::issue,
        super::realtime_ws::realtime_ws,
        // Dashboards runs out-of-process (`ryu-dashboards` sidecar); its
        // `/api/dashboards/*` spec is owned by the sidecar, not merged here.
        // Data
        super::data_path_api::export_data_path,
        super::data_path_api::get_data_path,
        super::data_path_api::reset_data_path,
        super::data_path_api::switch_data_path,
        super::data_path_api::validate_data_path,
        // Downloads
        super::downloads_history,
        super::downloads_history_clear,
        super::downloads_settings,
        super::set_downloads_settings,
        // Events
        super::notifications_stream,
        super::navigation_stream,
        // Finetune `/api/finetune/*` is served out-of-process by the `ryu-finetune`
        // sidecar (manifest `public_mount`), so its paths are no longer in Core's spec.
        // Gateway
        super::engine_concurrency,
        // Git
        super::git::clone_project_folder,
        super::git::create_project_folder,
        super::git::git_branches,
        super::git::git_checkout,
        super::git::git_commit_push,
        super::git::git_create_branch,
        super::git::git_file_diff,
        super::git::git_init,
        super::git::git_pull,
        super::git::git_pull_request,
        super::git::git_reverse_edits,
        super::git::git_status,
        super::git::git_sync,
        super::git::list_directory,
        // Hardware — the device-registry CRUD + TRMNL display handlers moved to the
        // extracted `ryu_hardware::api` crate, merged as a sub-doc in `api_doc()`
        // (non-optional dep, so no cfg gate). The public WS link and the protected
        // pairing + identity-reset ingress keep their `#[utoipa::path]` annotations
        // Core-side.
        super::hardware_ws::hardware_ws,
        super::hardware_public::pair_device,
        // Pairing v2 (`/api/hardware/pair/begin`, `/reveal`, `/confirm`, `/cancel`) and
        // node identity recovery (`/api/hardware/identity/reset`), all protected.
        super::hardware_public::pair_begin,
        super::hardware_public::pair_reveal,
        super::hardware_public::pair_confirm,
        super::hardware_public::pair_cancel,
        super::hardware_public::hardware_identity_reset,
        // Healing → feature-gated sub-doc merged in `api_doc()` (see Research note).
        // Knowledge
        super::knowledge_catalog_detail,
        super::knowledge_catalog_install,
        super::knowledge_catalog_list,
        super::okf_export,
        // Learning
        super::learning::config,
        super::learning::cycle,
        super::learning::exclude,
        super::learning::list,
        super::learning::merge,
        super::learning::score,
        super::learning::sweep,
        super::learning::synthesize,
        // Recursive improvement
        super::improvement_api::list_improvements,
        super::improvement_api::create_improvement,
        super::improvement_api::get_improvement,
        super::improvement_api::transition_improvement,
        super::optimizer_api::get_optimizations,
        super::optimizer_api::analyze_optimizations,
        super::optimizer_api::apply_optimization,
        super::optimizer_api::dismiss_optimization,
        // Managed bots (Telegram pairing). Neither path exposes the claim_secret or
        // the bot token — see `server::managed_bot_api`.
        super::managed_bot_api::begin_pairing,
        super::managed_bot_api::poll_pairing,
        super::managed_bot_api::confirm_pairing,
        super::managed_bot_api::cancel_pairing,
        // MCP
        super::widgets::mcp_resources_read,
        super::mcp_updates,
        // Media
        super::media::generate_image,
        super::media::generate_video,
        super::media::poll_video_job,
        super::media::generate_audio,
        super::media::poll_audio_job,
        super::gifs::search,
        super::images::search,
        super::media::serve_media,
        super::media::upload_media,
        // Uploads (user files → Uploads system space)
        super::uploads::serve_upload,
        super::uploads::upload_file,
        super::uploads::upload_limits,
        // Annotated user-facing routes that were missing from the spec. Listing
        // them here is what makes them `ryu_api.*` tools for the assistant too.
        super::clear_goal_handler,
        super::pause_goal_handler,
        super::resume_goal_handler,
        super::set_conversation_icon_handler,
        super::set_conversation_visibility_handler,
        super::set_space_icon,
        super::set_space_visibility,
        super::set_document_icon,
        super::set_document_access,
        super::skills_packs_add,
        super::skills_packs_detail,
        super::skills_packs_install,
        super::skills_packs_remove,
        super::skills_system_status,
        super::skills_system_sync,
        super::cancel_update_schedule,
        super::plugins_isolation_handler,
        super::plugin_catalog_channels,
        super::plugin_catalog_version_detail,
        super::integrations_list,
        super::integrations_get,
        super::scan_import_handler,
        super::run_import_handler,
        super::list_capabilities,
        super::catalog_sources_reorder,
        super::gateway_traffic,
        super::gateway_budget_spend,
        super::notifications_api::mention_targets,
        super::marketplace_packages_installed,
        super::marketplace_package_install,
        super::marketplace_package_update,
        super::marketplace_package_enable,
        super::marketplace_package_disable,
        super::marketplace_package_uninstall,
        super::list_background_processes,
        super::stop_background_process,
        super::get_conversation_access_handler,
        super::set_conversation_access_handler,
        // At-rest encryption posture (key custody + per-store coverage).
        super::encryption::encryption_status,
        // Meetings runs out-of-process (`ryu-meetings` sidecar); its `/api/meetings/*`
        // spec is owned by the sidecar and served through the ext-proxy `public_mount`,
        // so it is NOT merged into Core's spec — same posture as monitors/quests.
        // Memory
        super::get_memory,
        super::get_memory_graph,
        super::get_memory_settings,
        super::list_memory,
        super::memory_git::trace,
        super::update_memory,
        super::update_memory_settings,
        super::memory_dream::accept_dream_proposal,
        super::memory_dream::get_dream_review,
        super::memory_dream::get_dream_settings,
        super::memory_dream::reject_dream_proposal,
        super::memory_dream::run_dream_review,
        super::memory_dream::update_dream_settings,
        super::memory_reflect::get_reflect_dashboard,
        super::memory_reflect::get_reflect_settings,
        super::memory_reflect::update_reflect_settings,
        super::memory_working::delete_working_memory,
        super::memory_working::get_working_memory,
        super::memory_working::put_working_memory,
        // Models
        super::create_inference_preset,
        super::delete_inference_preset,
        super::get_model_launch_config,
        super::get_model_sampling_config,
        super::inference_sampling_fields,
        super::list_inference_presets,
        super::models_installed,
        super::models_llmfit_estimate,
        super::models_updates,
        super::set_model_launch_config,
        super::set_model_sampling_config,
        super::update_inference_preset,
        // Monitors: OUT-OF-PROCESS (`ryu-monitors` sidecar) — its handler
        // `#[utoipa::path]` annotations live on the sidecar, not in Core's spec.
        // Nodes
        super::list_connections,
        // Notifications
        super::notifications_api::ack_notification,
        super::notifications_api::archive_notification,
        super::notifications_api::unarchive_notification,
        super::all_events_stream,
        super::get_alert_delivery,
        super::get_email_transport,
        super::notifications_api::list_notifications,
        super::notifications_api::notifications_stream,
        super::post_email_test,
        super::put_alert_delivery,
        super::put_email_transport,
        super::notifications_api::read_notification,
        super::notifications_api::register_push_token,
        super::notifications_api::remove_push_token,
        // Plugins
        super::fire_activation_event_handler,
        super::install_app_bundle,
        super::install_plugin_from_catalog,
        super::plugin_bridge_api::plugin_bridge_dispatch,
        super::plugin_bridge_api::plugin_bridge_stream,
        super::plugin_catalog_browse,
        super::plugin_catalog_detail,
        super::plugin_contributions,
        super::plugin_ui_bundle,
        super::set_app_grants_handler,
        super::list_plugin_secrets_handler,
        super::put_plugin_secret_handler,
        super::delete_plugin_secret_handler,
        // Predict → sub-doc from the extracted `ryu_predict` crate, merged in
        // `api_doc()` (the crate owns its own `#[utoipa::path]` annotations).
        // Quests → served OUT-OF-PROCESS by the `ryu-quests` sidecar (manifest
        // `public_mount`), so its OpenAPI sub-doc is no longer merged into Core's spec.
        // Recipes → feature-gated sub-doc merged in `api_doc()` (see Research note).
        // Research/Clips/Recipes live in feature-gated sub-docs merged at build time
        // (see `api_doc()`), because utoipa's `paths(...)` macro drops `#[cfg]` on
        // entries — so a per-entry gate can't compile out with the module.
        // Sandboxes
        super::destroy_sandbox,
        super::exec_sandbox,
        super::get_sandbox_backend,
        super::list_sandboxes,
        super::set_sandbox_backend,
        // Skills — only the Core-owned catalog leaf remains; the CRUD/version/source
        // handlers moved to `ryu_skills::api` (merged as a sub-doc below).
        super::skills_updates,
        // Spaces
        super::create_database,
        super::create_document_version,
        super::create_file,
        super::create_whiteboard,
        super::get_document_backlinks,
        super::get_document_index_status,
        super::get_document_links,
        super::get_document_version,
        super::get_file_blob,
        super::replace_file_blob,
        super::get_global_graph,
        super::get_space_graph,
        super::list_document_versions,
        super::restore_document_version,
        // Support
        super::support_access_audit,
        super::support_access_diagnostics,
        super::diagnostics_otlp_test_span,
        // Voice
        super::voice::speak,
        super::voice::transcribe,
        super::voice::speech_processing,
        super::voice::speech_processing_engines,
        super::voice::speech_processing_model_install,
        super::voice::tts_engines,
        super::voice::tts_engines_install,
        super::voice::tts_models,
        super::voice::tts_models_install,
        super::voice_ws::voice_ws,
        // Widgets
        super::widgets::widget_call_tool,
        super::mcp_app_extensions::open_app,
        super::widgets::widget_follow_up,
        super::widgets::widget_state,
        // Workflows
        super::create_job,
        super::delete_job,
        super::create_workflow_version,
        super::get_job,
        super::get_workflow_version,
        super::list_jobs,
        super::list_workflow_versions,
        super::restore_workflow_version,
        super::run_job_now,
        super::update_job,
        super::workflow_webhook,
        // Worktree
        super::worktree_status_handler,
    )
)]
pub struct ApiDoc;

// ── Feature-gated leaf sub-docs ───────────────────────────────────────────────
//
// `research`/`clips`/`recipes` are compile-out-able leaves. Their handler
// paths can't live in `ApiDoc`'s `paths(...)` because utoipa's macro drops `#[cfg]`
// on individual entries — so a per-entry gate would still emit `super::*` for an
// absent module (E0433). Each extracted crate instead owns its own `#[utoipa::path]`
// annotations and exposes an `api::openapi()` sub-doc, merged into the base spec at
// build time by [`api_doc()`]. When the feature is on (the default), the merged
// output is identical in content to the old inline listing (paths land at the end of
// the map, which is functional-identical, not literally byte-identical JSON).

/// The full Core spec: the base [`ApiDoc`] plus any compile-out-able leaf sub-docs
/// that are enabled in this build. The single source of truth for both
/// `--dump-openapi` and `GET /api/openapi.json`, so the served spec and the dumped
/// spec never diverge on which features are compiled in.
pub fn api_doc() -> utoipa::openapi::OpenApi {
    #[allow(unused_mut)]
    let mut doc = ApiDoc::openapi();
    super::qoder_api::register_security(&mut doc);
    doc.merge(super::cloud_environments::openapi());
    doc.merge(super::subscription_cloud::api::openapi());
    doc.merge(super::prompt_registry::openapi());
    // Dashboards runs out-of-process (`ryu-dashboards` sidecar); its `/api/dashboards/*`
    // spec is owned by the sidecar and served through the ext-proxy `public_mount`, so
    // Core no longer merges it into this doc.
    // Hardware: the extracted `ryu_hardware` crate owns the `/api/hardware/devices*`
    // + `/api/hardware/display*` handler `#[utoipa::path]` annotations and exposes
    // them as a merged sub-doc. Non-optional dep, so merged unconditionally.
    doc.merge(ryu_hardware::api::openapi());
    // Predict: the extracted `ryu_predict` crate owns its `/api/predict/*` handler
    // `#[utoipa::path]` annotations and exposes them as a merged sub-doc (non-optional
    // dep, so no cfg gate — the routes are always mounted).
    doc.merge(ryu_predict::api::openapi());
    // Research `/api/research/*` is served out-of-process by the `ryu-research`
    // sidecar (manifest `public_mount`), so its OpenAPI sub-doc is no longer merged
    // into Core's spec — the sidecar owns that surface.
    // Clips `/api/clips/*` is served out-of-process by the `ryu-clips` sidecar
    // (manifest `public_mount`), so its OpenAPI sub-doc is no longer merged into
    // Core's spec — the sidecar owns that surface.
    // Recipes `/api/recipes/*` is served out-of-process by the `ryu-recipes` sidecar
    // (manifest `public_mount`), so its OpenAPI sub-doc is no longer merged into
    // Core's spec — the sidecar owns that surface.
    // Healing `/api/healing/*` is served out-of-process by the `ryu-healing` sidecar
    // (manifest `public_mount`), so its OpenAPI sub-doc is no longer merged into
    // Core's spec — the sidecar owns that surface.
    // Quests `/api/quests/*` is served out-of-process by the `ryu-quests` sidecar
    // (manifest `public_mount`), so its OpenAPI sub-doc is no longer merged into
    // Core's spec — the sidecar owns that surface.
    // Teams `/api/teams/*` is served out-of-process by the `ryu-teams` sidecar
    // (manifest `public_mount`), so its OpenAPI sub-doc is no longer merged into
    // Core's spec — the sidecar owns that surface.
    // Meetings runs out-of-process (`ryu-meetings` sidecar); its `/api/meetings/*` spec
    // is owned by the sidecar and served through the ext-proxy `public_mount`, so Core
    // no longer merges it into this doc.
    // Monitors: OUT-OF-PROCESS (`ryu-monitors` sidecar) — the sidecar owns the
    // `/api/monitors/*` surface + its OpenAPI, so it is NOT merged into Core's spec.
    // Skills: the CRUD/version/source/activate handlers live in the extracted
    // `ryu-skills` crate (which owns their `#[utoipa::path]` annotations); the
    // Core-side `catalog`/`updates`/`install-from-source` handlers stay in the main
    // doc above. Non-optional dep (the registry is kernel-required), so no cfg gate.
    doc.merge(ryu_skills::api::openapi());
    // Output styles: the whole `/api/output-styles/*` surface lives in the extracted
    // `ryu-output-styles` crate, which owns every `#[utoipa::path]` on it — unlike
    // skills there is no Core-side leaf left in the main doc above, because Core
    // `nest`s the crate's router under the entire prefix. Non-optional dep (Core
    // resolves the style for every turn), so no cfg gate.
    doc.merge(ryu_output_styles::api::openapi());
    doc
}

/// `GET /api/openapi.json` — serve the generated spec from a running Core.
#[utoipa::path(
    get,
    path = "/api/openapi.json",
    tag = "Health",
    summary = "OpenAPI specification for this Core node",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn serve_openapi() -> axum::Json<utoipa::openapi::OpenApi> {
    axum::Json(api_doc())
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    /// Suffix `scripts/postprocess-core-openapi.py` puts on the `operationId` of
    /// every deprecated `/api/apps*` alias it derives from a `/api/plugins*` route.
    /// Those paths are post-processing output, not utoipa output, so this test
    /// drops them; `tools/core-openapi-sync.test.mjs` checks that each alias still
    /// matches its canonical route.
    const ALIAS_OPERATION_SUFFIX: &str = "_apps_alias";

    fn is_derived_alias(methods: &Value) -> bool {
        methods.as_object().is_some_and(|ops| {
            !ops.is_empty()
                && ops.values().all(|op| {
                    op.get("operationId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| id.ends_with(ALIAS_OPERATION_SUFFIX))
                })
        })
    }

    /// The committed spec (the copy fumadocs renders; the SDK and web copies are
    /// held byte-identical to it by `tools/core-openapi-sync.test.mjs`) must be
    /// exactly what `api_doc()` generates today. A hand edit to the JSON, or a
    /// `#[utoipa::path]` / doc-comment change without
    /// `python3 scripts/postprocess-core-openapi.py --generate`, fails here.
    #[test]
    fn committed_core_openapi_matches_generated_spec() {
        let committed_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fumadocs/specs/core-openapi.json");
        let committed_text = std::fs::read_to_string(&committed_path)
            .unwrap_or_else(|error| panic!("read {}: {error}", committed_path.display()));
        let mut committed: Value =
            serde_json::from_str(&committed_text).expect("committed Core OpenAPI is valid JSON");
        let generated =
            serde_json::to_value(super::api_doc()).expect("serialize generated Core OpenAPI");

        let committed_paths = committed
            .get_mut("paths")
            .and_then(Value::as_object_mut)
            .expect("committed spec has a paths object");
        committed_paths.retain(|_, methods| !is_derived_alias(methods));
        let generated_paths = generated
            .get("paths")
            .and_then(Value::as_object)
            .expect("generated spec has a paths object");
        assert!(
            !generated_paths.values().any(is_derived_alias),
            "utoipa output must not already carry `{ALIAS_OPERATION_SUFFIX}` operations"
        );

        let mut drift: Vec<String> = Vec::new();
        for (path, methods) in generated_paths {
            match committed_paths.get(path) {
                None => drift.push(format!("missing from committed spec: {path}")),
                Some(committed_methods) if committed_methods != methods => {
                    drift.push(format!("differs from generated spec: {path}"));
                }
                Some(_) => {}
            }
        }
        for path in committed_paths.keys() {
            if !generated_paths.contains_key(path) {
                drift.push(format!("not generated by api_doc(): {path}"));
            }
        }
        let committed_rest: Vec<(&String, &Value)> = committed
            .as_object()
            .expect("committed spec is an object")
            .iter()
            .filter(|(key, _)| key.as_str() != "paths")
            .collect();
        for (key, value) in committed_rest {
            if generated.get(key) != Some(value) {
                drift.push(format!("top-level `{key}` differs from generated spec"));
            }
        }
        for key in generated
            .as_object()
            .expect("generated spec is an object")
            .keys()
        {
            if committed.get(key).is_none() {
                drift.push(format!("top-level `{key}` missing from committed spec"));
            }
        }

        assert!(
            drift.is_empty(),
            "apps/fumadocs/specs/core-openapi.json is out of date with api_doc(); run \
             `python3 scripts/postprocess-core-openapi.py --generate` and \
             `(cd apps/fumadocs && bun run generate:docs --surface=core)`:\n  {}",
            drift.join("\n  ")
        );
    }
}

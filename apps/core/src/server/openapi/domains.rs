//! Core OpenAPI paths for the per-domain APIs (activity through worktree).
//!
//! Merged into the Core spec by [`super::api_doc`].

use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
    paths(
// Activity
        crate::server::activity_api::activity_stream,
        crate::server::activity_api::create_activity,
        crate::server::activity_api::list_activity,
        // Agents
        crate::server::acp_config,
        crate::server::get_acp_agent_settings,
        crate::server::put_acp_agent_settings,
        crate::server::acp_logout,
        crate::server::agent_capabilities,
        crate::server::usage_api::agent_usage,
        crate::server::usage_api::provider_account_usage,
        crate::server::oauth_pool_policy::get_policy,
        crate::server::oauth_pool_policy::put_policy,
        crate::server::usage_api::provider_credits,
        crate::server::usage_api::subscription_cost_usage,
        crate::server::usage_api::subscriptions,
        crate::server::usage_api::subscription_reading,
        crate::server::usage_api::conversation_provider_account,
        crate::usage_history::http::history,
        crate::usage_history::http::import,
        crate::usage_history::http::import_operation,
        crate::usage_history::http::account_sync,
        crate::usage_history::http::tracking,
        crate::usage_history::http::set_tracking,
        crate::server::usage_api::set_subscription_cost_tracking,
        crate::server::usage_review::get_review,
        crate::server::usage_review::get_settings,
        crate::server::usage_review::put_settings,
        // Presence, gaming, and streaming mode
        crate::server::presence_api::get_presence,
        crate::server::presence_api::put_presence,
        crate::server::presence_api::get_gaming_settings,
        crate::server::presence_api::put_gaming_settings,
        crate::server::presence_api::get_streaming_settings,
        crate::server::presence_api::put_streaming_settings,
        // Threshold-driven model fallback
        crate::server::routing_api::advice,
        crate::server::routing_api::get_policy,
        crate::server::routing_api::put_policy,
        crate::server::routing_api::get_retry_policy,
        crate::server::routing_api::put_retry_policy,
        crate::server::load_acp_session_handler,
        crate::server::set_agent_capabilities,
        // Approvals
        crate::server::approvals_api::approval_events,
        crate::server::approvals_api::approve_approval,
        crate::server::approvals_api::get_approval,
        crate::server::approvals_api::get_mode,
        crate::server::approvals_api::list_approvals,
        crate::server::approvals_api::reject_approval,
        crate::server::approvals_api::set_mode,
        // Chat
        crate::server::btw_handler,
        crate::server::delete_btw_handler,
        crate::server::chat_permission,
        crate::server::chat_question,
        crate::server::mcp_forms::list,
        crate::server::mcp_forms::answer,
        crate::server::chat_retry,
        crate::server::chat_stream_resume,
        crate::server::chat_client_tool_result,
        crate::server::chat_browser_session_link,
        crate::server::chat_suggestions::chat_suggestions,
        crate::server::composer_predictions::chat_prediction,
        // Clips → feature-gated sub-doc merged in `api_doc()` (see Research note).
        // Composio
        crate::server::connect_events::consume,
        crate::server::connect_events::bind_target,
        crate::server::composio_actions,
        crate::server::composio_connection_initiate,
        crate::server::composio_connection_complete,
        crate::server::composio_connection_status,
        crate::server::composio_connections,
        crate::server::composio_status,
        crate::server::composio_toolkits,
        crate::server::composio_trigger_delete,
        crate::server::composio_trigger_list,
        crate::server::composio_trigger_subscribe,
        crate::server::composio_triggers,
        crate::server::composio_webhook,
        // Conversations
        crate::server::add_message_reaction_handler,
        crate::server::edit_message_handler,
        crate::server::get_agent_ui_state_handler,
        crate::server::get_conversation_feedback_handler,
        crate::server::get_conversation_reactions_handler,
        crate::server::get_conversation_read_receipts_handler,
        crate::server::mark_conversation_messages_read_handler,
        crate::server::put_agent_ui_state_handler,
        crate::server::regenerate_message_handler,
        crate::server::remove_message_reaction_handler,
        crate::server::select_version_handler,
        crate::server::set_message_feedback_handler,
        // Core
        crate::server::list_btw_handler,
        crate::server::ws_ticket::issue,
        crate::server::realtime_ws::realtime_ws,
        // Dashboards runs out-of-process (`ryu-dashboards` sidecar); its
        // `/api/dashboards/*` spec is owned by the sidecar, not merged here.
        // Data
        crate::server::data_path_api::export_data_path,
        crate::server::data_path_api::get_data_path,
        crate::server::data_path_api::reset_data_path,
        crate::server::data_path_api::switch_data_path,
        crate::server::data_path_api::validate_data_path,
        // Downloads
        crate::server::downloads_history,
        crate::server::downloads_history_clear,
        crate::server::downloads_settings,
        crate::server::set_downloads_settings,
        // Events
        crate::server::notifications_stream,
        crate::server::navigation_stream,
        // Finetune `/api/finetune/*` is served out-of-process by the `ryu-finetune`
        // sidecar (manifest `public_mount`), so its paths are no longer in Core's spec.
        // Gateway
        crate::server::engine_concurrency,
        // Git
        crate::server::git::clone_project_folder,
        crate::server::git::create_project_folder,
        crate::server::git::git_branches,
        crate::server::git::git_checkout,
        crate::server::git::git_commit_push,
        crate::server::git::git_create_branch,
        crate::server::git::git_file_diff,
        crate::server::git::git_init,
        crate::server::git::git_pull,
        crate::server::git::git_pull_request,
        crate::server::git::git_reverse_edits,
        crate::server::git::git_status,
        crate::server::git::git_sync,
        crate::server::git::list_directory,
        // Hardware — the device-registry CRUD + TRMNL display handlers moved to the
        // extracted `ryu_hardware::api` crate, merged as a sub-doc in `api_doc()`
        // (non-optional dep, so no cfg gate). The public WS link and the protected
        // pairing + identity-reset ingress keep their `#[utoipa::path]` annotations
        // Core-side.
        crate::server::hardware_ws::hardware_ws,
        crate::server::hardware_public::pair_device,
        // Pairing v2 (`/api/hardware/pair/begin`, `/reveal`, `/confirm`, `/cancel`) and
        // node identity recovery (`/api/hardware/identity/reset`), all protected.
        crate::server::hardware_public::pair_begin,
        crate::server::hardware_public::pair_reveal,
        crate::server::hardware_public::pair_confirm,
        crate::server::hardware_public::pair_cancel,
        crate::server::hardware_public::hardware_identity_reset,
        // Healing → feature-gated sub-doc merged in `api_doc()` (see Research note).
        // Knowledge
        crate::server::knowledge_catalog_detail,
        crate::server::knowledge_catalog_install,
        crate::server::knowledge_catalog_list,
        crate::server::okf_export,
        // Learning
        crate::server::learning::config,
        crate::server::learning::cycle,
        crate::server::learning::exclude,
        crate::server::learning::list,
        crate::server::learning::merge,
        crate::server::learning::score,
        crate::server::learning::sweep,
        crate::server::learning::synthesize,
        // Recursive improvement
        crate::server::improvement_api::list_improvements,
        crate::server::improvement_api::create_improvement,
        crate::server::improvement_api::get_improvement,
        crate::server::improvement_api::transition_improvement,
        crate::server::optimizer_api::get_optimizations,
        crate::server::optimizer_api::analyze_optimizations,
        crate::server::optimizer_api::apply_optimization,
        crate::server::optimizer_api::dismiss_optimization,
        // Managed bots (Telegram pairing). Neither path exposes the claim_secret or
        // the bot token — see `server::managed_bot_api`.
        crate::server::managed_bot_api::begin_pairing,
        crate::server::managed_bot_api::poll_pairing,
        crate::server::managed_bot_api::confirm_pairing,
        crate::server::managed_bot_api::cancel_pairing,
        // MCP
        crate::server::widgets::mcp_resources_read,
        crate::server::mcp_updates,
        // Media
        crate::server::media::generate_image,
        crate::server::media::generate_video,
        crate::server::media::poll_video_job,
        crate::server::media::generate_audio,
        crate::server::media::poll_audio_job,
        crate::server::gifs::search,
        crate::server::images::search,
        crate::server::media::serve_media,
        crate::server::media::upload_media,
        // Uploads (user files → Uploads system space)
        crate::server::uploads::serve_upload,
        crate::server::uploads::upload_file,
        crate::server::uploads::upload_limits,
        // Annotated user-facing routes that were missing from the spec. Listing
        // them here is what makes them `ryu_api.*` tools for the assistant too.
        crate::server::clear_goal_handler,
        crate::server::pause_goal_handler,
        crate::server::resume_goal_handler,
        crate::server::set_conversation_icon_handler,
        crate::server::set_conversation_visibility_handler,
        crate::server::set_space_icon,
        crate::server::set_space_visibility,
        crate::server::set_document_icon,
        crate::server::set_document_access,
        crate::server::skills_packs_add,
        crate::server::skills_packs_detail,
        crate::server::skills_packs_install,
        crate::server::skills_packs_remove,
        crate::server::skills_system_status,
        crate::server::skills_system_sync,
        crate::server::cancel_update_schedule,
        crate::server::plugins_isolation_handler,
        crate::server::plugin_catalog_channels,
        crate::server::plugin_catalog_version_detail,
        crate::server::integrations_list,
        crate::server::integrations_get,
        crate::server::scan_import_handler,
        crate::server::run_import_handler,
        crate::server::list_capabilities,
        crate::server::catalog_sources_reorder,
        crate::server::gateway_traffic,
        crate::server::gateway_budget_spend,
        crate::server::notifications_api::mention_targets,
        crate::server::marketplace_packages_installed,
        crate::server::marketplace_package_install,
        crate::server::marketplace_package_update,
        crate::server::marketplace_package_enable,
        crate::server::marketplace_package_disable,
        crate::server::marketplace_package_uninstall,
        crate::server::list_background_processes,
        crate::server::stop_background_process,
        crate::server::get_conversation_access_handler,
        crate::server::set_conversation_access_handler,
        // At-rest encryption posture (key custody + per-store coverage).
        crate::server::encryption::encryption_status,
        // Meetings runs out-of-process (`ryu-meetings` sidecar); its `/api/meetings/*`
        // spec is owned by the sidecar and served through the ext-proxy `public_mount`,
        // so it is NOT merged into Core's spec — same posture as monitors/quests.
        // Memory
        crate::server::get_memory,
        crate::server::get_memory_graph,
        crate::server::get_memory_settings,
        crate::server::list_memory,
        crate::server::memory_git::trace,
        crate::server::update_memory,
        crate::server::update_memory_settings,
        crate::server::memory_dream::accept_dream_proposal,
        crate::server::memory_dream::get_dream_review,
        crate::server::memory_dream::get_dream_settings,
        crate::server::memory_dream::reject_dream_proposal,
        crate::server::memory_dream::run_dream_review,
        crate::server::memory_dream::update_dream_settings,
        crate::server::memory_reflect::get_reflect_dashboard,
        crate::server::memory_reflect::get_reflect_settings,
        crate::server::memory_reflect::update_reflect_settings,
        crate::server::memory_working::delete_working_memory,
        crate::server::memory_working::get_working_memory,
        crate::server::memory_working::put_working_memory,
        // Models
        crate::server::create_inference_preset,
        crate::server::delete_inference_preset,
        crate::server::get_model_launch_config,
        crate::server::get_model_sampling_config,
        crate::server::inference_sampling_fields,
        crate::server::list_inference_presets,
        crate::server::models_installed,
        crate::server::models_llmfit_estimate,
        crate::server::models_updates,
        crate::server::set_model_launch_config,
        crate::server::set_model_sampling_config,
        crate::server::update_inference_preset,
        // Monitors: OUT-OF-PROCESS (`ryu-monitors` sidecar) — its handler
        // `#[utoipa::path]` annotations live on the sidecar, not in Core's spec.
        // Nodes
        crate::server::list_connections,
        // Notifications
        crate::server::notifications_api::ack_notification,
        crate::server::notifications_api::archive_notification,
        crate::server::notifications_api::unarchive_notification,
        crate::server::all_events_stream,
        crate::server::get_alert_delivery,
        crate::server::get_email_transport,
        crate::server::notifications_api::list_notifications,
        crate::server::notifications_api::notifications_stream,
        crate::server::post_email_test,
        crate::server::put_alert_delivery,
        crate::server::put_email_transport,
        crate::server::notifications_api::read_notification,
        crate::server::notifications_api::register_push_token,
        crate::server::notifications_api::remove_push_token,
        // Plugins
        crate::server::fire_activation_event_handler,
        crate::server::install_app_bundle,
        crate::server::install_plugin_from_catalog,
        crate::server::plugin_bridge_api::plugin_bridge_dispatch,
        crate::server::plugin_bridge_api::plugin_bridge_stream,
        crate::server::plugin_catalog_browse,
        crate::server::plugin_catalog_detail,
        crate::server::plugin_contributions,
        crate::server::plugin_ui_bundle,
        crate::server::set_app_grants_handler,
        crate::server::list_plugin_secrets_handler,
        crate::server::put_plugin_secret_handler,
        crate::server::delete_plugin_secret_handler,
        // Predict → sub-doc from the extracted `ryu_predict` crate, merged in
        // `api_doc()` (the crate owns its own `#[utoipa::path]` annotations).
        // Quests → served OUT-OF-PROCESS by the `ryu-quests` sidecar (manifest
        // `public_mount`), so its OpenAPI sub-doc is no longer merged into Core's spec.
        // Recipes → feature-gated sub-doc merged in `api_doc()` (see Research note).
        // Research/Clips/Recipes live in feature-gated sub-docs merged at build time
        // (see `api_doc()`), because utoipa's `paths(...)` macro drops `#[cfg]` on
        // entries — so a per-entry gate can't compile out with the module.
        // Sandboxes
        crate::server::destroy_sandbox,
        crate::server::exec_sandbox,
        crate::server::get_sandbox_backend,
        crate::server::list_sandboxes,
        crate::server::set_sandbox_backend,
        // Skills — only the Core-owned catalog leaf remains; the CRUD/version/source
        // handlers moved to `ryu_skills::api` (merged as a sub-doc below).
        crate::server::skills_updates,
        // Spaces
        crate::server::create_database,
        crate::server::create_document_version,
        crate::server::create_file,
        crate::server::create_whiteboard,
        crate::server::get_document_backlinks,
        crate::server::get_document_index_status,
        crate::server::get_document_links,
        crate::server::get_document_version,
        crate::server::get_file_blob,
        crate::server::replace_file_blob,
        crate::server::get_global_graph,
        crate::server::get_space_graph,
        crate::server::list_document_versions,
        crate::server::restore_document_version,
        // Support
        crate::server::support_access_audit,
        crate::server::support_access_diagnostics,
        crate::server::diagnostics_otlp_test_span,
        // Voice
        crate::server::voice::speak,
        crate::server::voice::transcribe,
        crate::server::voice::speech_processing,
        crate::server::voice::speech_processing_engines,
        crate::server::voice::speech_processing_model_install,
        crate::server::voice::tts_engines,
        crate::server::voice::tts_engines_install,
        crate::server::voice::tts_models,
        crate::server::voice::tts_models_install,
        crate::server::voice_ws::voice_ws,
        // Widgets
        crate::server::widgets::widget_call_tool,
        crate::server::mcp_app_extensions::open_app,
        crate::server::widgets::widget_follow_up,
        crate::server::widgets::widget_state,
        // Workflows
        crate::server::create_job,
        crate::server::delete_job,
        crate::server::create_workflow_version,
        crate::server::get_job,
        crate::server::get_workflow_version,
        crate::server::list_jobs,
        crate::server::list_workflow_versions,
        crate::server::restore_workflow_version,
        crate::server::run_job_now,
        crate::server::update_job,
        crate::server::workflow_webhook,
        // Worktree
        crate::server::worktree_status_handler,
    )
)]
pub(super) struct DomainPaths;

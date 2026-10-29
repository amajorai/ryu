//! Guard: Core must not grow NEW app-specific coupling.
//!
//! Per `AGENTS.md` ("Apps-store satellites") Core reaches apps only through the
//! generic seams (manifest sidecars, the ext-proxy, the capability broker, kernel
//! events, and plugin contributions). The residue that predates that rule —
//! per-app plugin-id constants — is frozen here and tracked for retirement in
//! `docs/app-boundary-extraction-plan.md`.
//!
//! The allowlist can only SHRINK: a new entry fails the test, and so does a stale
//! entry (a deleted constant must also be removed from the list, so the list stays
//! an honest inventory). Do not add rows to make a new coupling pass; use the
//! generic seam instead.
//!
//! The per-app loopback-client shim guard (`src/<app>_client.rs`) was retired with
//! the last shim, `healing_client.rs` (plan step 8).
//!
//! The kernel-handler pin guard ([`no_new_kernel_handler_app_pins`]) inventories
//! every kernel-capability handler that still refuses callers other than one app.
//! Each pin stays because no reviewed Gateway grant covers its handler exactly; the
//! reason for each is recorded in `docs/app-boundary-extraction-plan.md` (1a
//! "Kernel handlers" and step 6). It is a tripwire, not a proof: a pin written in an
//! unusual form (a `matches!` on the id, or a variable whose name does not end in
//! `id`) slips past the pattern, so review still has to look.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// `<path relative to src>::<CONST>` for every `const X: &str = "@ryu/…"` /
/// `"com.ryu.…"` app-id constant still declared in Core.
const ALLOWED_APP_ID_CONSTANTS: &[&str] = &[
    "memory_policy.rs::TEMPORARY_CONTEXT_FLAG",
    "memory_provider.rs::BUILTIN_MEMORY_PROVIDER",
    "notify/mod.rs::ISLAND_CONNECT_SUGGESTION_SOURCE",
    "plugin_host/agent_comms_delivery_runtime_test.rs::PLUGIN",
    "plugin_manifest/mod.rs::CANVAS_PLUGIN_ID",
    "plugin_manifest/mod.rs::CONVERT_PLUGIN_ID",
    "plugin_manifest/mod.rs::DRAWSOME_PLUGIN_ID",
    "plugin_manifest/mod.rs::FINETUNE_PLUGIN_ID",
    "plugin_manifest/mod.rs::REASONING_PLUGIN_ID",
    "plugin_manifest/mod.rs::SLIDES_PLUGIN_ID",
    "plugin_manifest/mod.rs::WHITEBOARD_PLUGIN_ID",
    "plugins/builtins.rs::ACTIVITY_PLUGIN_ID",
    "plugins/builtins.rs::AGENTS_PLUGIN_ID",
    "plugins/builtins.rs::ANYDOC_PLUGIN_ID",
    "plugins/builtins.rs::APPROVALS_PLUGIN_ID",
    "plugins/builtins.rs::AUTOPILOT_PLUGIN_ID",
    "plugins/builtins.rs::BACKSTAGE_PLUGIN_ID",
    "plugins/builtins.rs::BLUEPRINT_PLUGIN_ID",
    "plugins/builtins.rs::BROWSER_PLUGIN_ID",
    "plugins/builtins.rs::CALENDAR_PLUGIN_ID",
    "plugins/builtins.rs::CHAT_BROADCAST_PLUGIN_ID",
    "plugins/builtins.rs::CLIPS_PLUGIN_ID",
    "plugins/builtins.rs::COMPOSIO_CONNECT_PLUGIN_ID",
    "plugins/builtins.rs::CRM_PLUGIN_ID",
    "plugins/builtins.rs::DASHBOARDS_PLUGIN_ID",
    "plugins/builtins.rs::DOCLING_PLUGIN_ID",
    "plugins/builtins.rs::DRAFTS_PLUGIN_ID",
    "plugins/builtins.rs::ENGINES_PLUGIN_ID",
    "plugins/builtins.rs::EXPANDED_COMPOSER_PLUGIN_ID",
    "plugins/builtins.rs::EXPENSES_PLUGIN_ID",
    "plugins/builtins.rs::FEEDBACK_BOARD_PLUGIN_ID",
    "plugins/builtins.rs::FORMS_PLUGIN_ID",
    "plugins/builtins.rs::GHOST_CHATS_PLUGIN_ID",
    "plugins/builtins.rs::HARDWARE_PLUGIN_ID",
    "plugins/builtins.rs::HEALING_PLUGIN_ID",
    "plugins/builtins.rs::HELP_CENTER_PLUGIN_ID",
    "plugins/builtins.rs::INVOICES_PLUGIN_ID",
    "plugins/builtins.rs::LAYERS_PLUGIN_ID",
    "plugins/builtins.rs::LEARNING_PLUGIN_ID",
    "plugins/builtins.rs::MAIL_PLUGIN_ID",
    "plugins/builtins.rs::MARKITDOWN_PLUGIN_ID",
    "plugins/builtins.rs::MEDIA_PLUGIN_ID",
    "plugins/builtins.rs::MEETINGS_PLUGIN_ID",
    "plugins/builtins.rs::MEMORY_PLUGIN_ID",
    "plugins/builtins.rs::MINERU_PLUGIN_ID",
    "plugins/builtins.rs::MISSION_CONTROL_PLUGIN_ID",
    "plugins/builtins.rs::MONITORS_PLUGIN_ID",
    "plugins/builtins.rs::NEWS_PLUGIN_ID",
    "plugins/builtins.rs::OUTPUT_STYLES_PLUGIN_ID",
    "plugins/builtins.rs::OUTREACH_PLUGIN_ID",
    "plugins/builtins.rs::PEOPLE_PLUGIN_ID",
    "plugins/builtins.rs::PROJECTS_PLUGIN_ID",
    "plugins/builtins.rs::QUESTS_PLUGIN_ID",
    "plugins/builtins.rs::RAG_PLUGIN_ID",
    "plugins/builtins.rs::REACTIONS_PLUGIN_ID",
    "plugins/builtins.rs::RECIPES_PLUGIN_ID",
    "plugins/builtins.rs::RESEARCH_PLUGIN_ID",
    "plugins/builtins.rs::RLM_PLUGIN_ID",
    "plugins/builtins.rs::SIDE_CHATS_PLUGIN_ID",
    "plugins/builtins.rs::SIMULATOR_PLUGIN_ID",
    "plugins/builtins.rs::SITES_PLUGIN_ID",
    "plugins/builtins.rs::SKILLS_PLUGIN_ID",
    "plugins/builtins.rs::SKILL_EDITOR_PLUGIN_ID",
    "plugins/builtins.rs::SOCIAL_PLUGIN_ID",
    "plugins/builtins.rs::SPACES_PLUGIN_ID",
    "plugins/builtins.rs::STATS_PLUGIN_ID",
    "plugins/builtins.rs::SUBTITLES_PLUGIN_ID",
    "plugins/builtins.rs::TEAMS_PLUGIN_ID",
    "plugins/builtins.rs::TIMELINE_PLUGIN_ID",
    "plugins/builtins.rs::TOKEN_TABLE_PLUGIN_ID",
    "plugins/builtins.rs::TUITION_PLUGIN_ID",
    "plugins/builtins.rs::UGC_PLUGIN_ID",
    "plugins/builtins.rs::UNSTRUCTURED_PLUGIN_ID",
    "plugins/builtins.rs::VOICE_PLUGIN_ID",
    "plugins/builtins.rs::WARMUP_PLUGIN_ID",
    "plugins/builtins.rs::WEBHOOKS_PLUGIN_ID",
    "plugins/builtins.rs::WHATSAPP_PLUGIN_ID",
    "plugins/builtins.rs::WORKFLOWS_PLUGIN_ID",
    "server/chat_suggestions.rs::PROMPT_SUGGESTIONS_PLUGIN_ID",
    "server/mod.rs::GOAL_PLUGIN_ID",
    "sidecar/mcp/honcho_registry_runtime_test.rs::HONCHO_PLUGIN_ID",
    "sidecar/mcp/tests/cloudflare_oauth_capabilities_runtime_test.rs::PLUGIN",
    "tool_exec/tests/mod.rs::SECRET_HEADER_TEST_PLUGIN",
];

/// `<path relative to src>::<target>#<n>` for every app pin in a kernel-capability
/// handler file: an `…id != / ==` comparison against an app-id constant
/// (`*_PLUGIN_ID`, bare or path-qualified) or an `"@ryu/…"` / `"com.ryu.…"`
/// literal. `n` is the 1-based occurrence of that target in that file, so a second
/// pin in an already-listed file also fails.
const ALLOWED_KERNEL_HANDLER_PINS: &[&str] = &[
    // ghost.replay / recordStart / recordStatus / recordStop (one shared check).
    "recipes_host.rs::RECIPES_PLUGIN_ID#1",
    // email.send, email.status.
    "server/app_email.rs::\"@ryu/mail\"#1",
    "server/app_email.rs::\"@ryu/mail\"#2",
    // spaces.fileNotes: `spaces:docs` does not cover a system-Space write.
    "server/app_file_notes.rs::MEETINGS_PLUGIN_ID#1",
    // mcp.callTool: `tools.invoke` does not cover a user-less registry call.
    "server/app_mcp_call.rs::MONITORS_PLUGIN_ID#1",
    // notify.fanout: no notification grant covers caller-chosen external channels.
    "server/app_notify.rs::MONITORS_PLUGIN_ID#1",
];

fn src_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

fn relative(path: &Path) -> String {
    path.strip_prefix(src_root())
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn assert_exact(kind: &str, found: &BTreeSet<String>, allowed: &[&str]) {
    let allowed: BTreeSet<String> = allowed.iter().map(|s| (*s).to_owned()).collect();
    let added: Vec<_> = found.difference(&allowed).collect();
    let removed: Vec<_> = allowed.difference(found).collect();
    assert!(
        added.is_empty(),
        "new app-specific {kind} in Core: {added:?}. Use the generic seam (ext-proxy, \
         capability broker, plugin contributions) instead; see AGENTS.md."
    );
    assert!(
        removed.is_empty(),
        "{kind} no longer present: {removed:?}. Remove them from the allowlist in \
         app_boundary_guard.rs (it may only shrink)."
    );
}

#[test]
fn no_new_app_id_constants_in_core() {
    let pattern = regex::Regex::new(
        r#"const\s+([A-Z0-9_]+)\s*:\s*&(?:'static\s+)?str\s*=\s*"(?:@ryu/|com\.ryu\.)"#,
    )
    .expect("valid regex");
    let mut files = Vec::new();
    rust_files(&src_root(), &mut files);
    let mut found = BTreeSet::new();
    for path in files {
        let rel = relative(&path);
        if rel == "app_boundary_guard.rs" {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for capture in pattern.captures_iter(&text) {
            found.insert(format!("{rel}::{}", &capture[1]));
        }
    }
    assert_exact("app-id constants", &found, ALLOWED_APP_ID_CONSTANTS);
}

/// The dedicated kernel-capability handler files: every `server/app_*.rs` and
/// `server/host_*.rs` (derived from the directory, so a new handler file is scanned
/// without editing this list), plus the two handler files outside that naming.
///
/// Not every handler lives in one of these files. `tools.call` and
/// `plugins.installBundle` are implemented in `server/mod.rs`, and `events.emit`
/// and `realtime.publish` in `sidecar/ext_proxy.rs`. Those two files are too large
/// and hold too many unrelated app-id comparisons (for example ext-proxy routing)
/// to scan whole, so those four handlers are not covered here. As of 2026-10-11
/// none of them pins an app; a new kernel handler belongs in its own
/// `server/app_*.rs` file so this guard sees it.
fn kernel_handler_files() -> Vec<PathBuf> {
    let server = src_root().join("server");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&server)
        .expect("src/server is readable")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "rs")
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("app_") || name.starts_with("host_"))
        })
        .collect();
    files.push(server.join("provider_router.rs"));
    files.push(src_root().join("recipes_host.rs"));
    files.sort();
    files
}

#[test]
fn no_new_kernel_handler_app_pins() {
    let pattern = regex::Regex::new(
        r#"\b[a-z_]*id\s*(?:!=|==)\s*(?:[A-Za-z_]\w*::)*([A-Z0-9_]+_PLUGIN_ID|"(?:@ryu/|com\.ryu\.)[^"]+")"#,
    )
    .expect("valid regex");
    let mut found = BTreeSet::new();
    for path in kernel_handler_files() {
        let rel = relative(&path);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("kernel handler file {rel} is unreadable: {e}"));
        let mut occurrences: BTreeMap<String, usize> = BTreeMap::new();
        for capture in pattern.captures_iter(&text) {
            let target = capture[1].to_owned();
            let n = occurrences.entry(target.clone()).or_default();
            *n += 1;
            found.insert(format!("{rel}::{target}#{n}"));
        }
    }
    assert_exact(
        "kernel-handler app pins",
        &found,
        ALLOWED_KERNEL_HANDLER_PINS,
    );
}

/// The scheduler names no app outside its legacy-target shim: app jobs are reached
/// only through the generic `jobs.*` contract (`scheduler/app_jobs.rs`), and the
/// shim (`scheduler/legacy_targets.rs`) is shrink-only residue that maps persisted
/// monitor jobs onto it. Quest residue (`legacy_quest_jobs.rs`) names capabilities,
/// not an app id.
#[test]
fn scheduler_names_no_app_outside_the_legacy_shim() {
    let mut files = Vec::new();
    rust_files(&src_root().join("scheduler"), &mut files);
    assert!(!files.is_empty(), "src/scheduler is readable");
    let mut offenders = BTreeSet::new();
    for path in files {
        let rel = relative(&path);
        if rel == "scheduler/legacy_targets.rs" {
            continue;
        }
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("scheduler file {rel} is unreadable: {e}"));
        for needle in ["@ryu/monitors", "MONITORS_PLUGIN_ID", "monitors."] {
            if text.contains(needle) {
                offenders.insert(format!("{rel}: {needle}"));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "the scheduler names an app outside scheduler/legacy_targets.rs: {offenders:?}"
    );
}

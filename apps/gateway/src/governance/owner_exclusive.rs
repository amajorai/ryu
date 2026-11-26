//! The reviewed owner-exclusive grant table.
//!
//! Moved as is out of `mod.rs`, which went over the file size limits. `mod.rs`
//! adds a caller's rows to the allowlist in `validate_general_grants_for`.

use super::{crossapp_grants, loopback_egress, mounted_app_grants};

/// One reviewed owner-exclusive grant row: the exact first-party owner ids
/// (current scoped id plus its legacy flat alias) and the sensitive grants only
/// that owner may request.
pub(super) struct OwnerExclusiveGrant {
    pub(super) owner_ids: &'static [&'static str],
    pub(super) grants: &'static [&'static str],
}

/// Reviewed grants that are deliberately kept OFF the global allowlist (so no
/// marketplace app can self-request them) but are approved for one exact
/// first-party owner. This is data, not per-app code: adding a row is a security
/// review decision, and the policy itself stays app-agnostic. It cannot be driven
/// by the requesting manifest, because the manifest is the untrusted party here.
///
/// - `execution:control` — the kill switch's stop-all-executions primitive.
/// - `hook:run-self` — `host.runHook`, restricted to the seeded chat-title plugin.
/// - `timeline:speech` — Shadow speech history, only Life Recorder requests it.
/// - `media:record` — host-owned microphone windows, requested by Life Recorder,
///   Teleprompter, Voice, and Video Studio (short windows only; no Shadow speech
///   history).
/// - `hook:run-agent:write` — mutating sub-agent presets (autopilot, sites).
/// - `vault:fill` — an agent's own website login or TOTP code, released in
///   plaintext to the Browser sidecar that types it into the page.
/// - `security-key:relay` — a WebAuthn ceremony relayed from the Browser
///   sidecar to the user's own hardware security key.
/// - `chat:project-guidance` — a project's standing goal and instructions, which
///   Core puts in the system prompt of every turn in that project.
/// - `runs:rerun-agent` — an unattended agent turn on an app-supplied prompt.
/// - `runs:failures` — every member's failed-run instruction and output.
/// - `warmup:crud` — scheduled unattended agent turns on an app-supplied prompt.
/// - `workflows:crud` / `workflows:runstate` — saved workflows whose nodes call
///   any MCP tool or agent as the owner without approval.
/// - `tool:command:<bin>` — a manifest-chosen argv for a trusted binary, i.e.
///   unsandboxed process execution; only the plugin that ships that command.
/// - `tool:http-egress:127.0.0.1` — reach to every loopback port on the node.
/// - `mail:crud` / `social:crud` — owner-token Agent Mail / Outpost bridges,
///   for the cross-app holders in `crossapp_grants`.
/// - `rlm:query` / `blueprint:review` / `app:http:@ryu/recipes` (every route of
///   another app's sidecar mount as the owner), for the holders in
///   `mounted_app_grants`.
pub(super) const OWNER_EXCLUSIVE_GRANTS: &[OwnerExclusiveGrant] = &[
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/spider", "com.ryu.spider"],
        grants: &["tool:command:spider"],
    },
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/rtk", "com.ryu.rtk"],
        grants: &["tool:command:rtk"],
    },
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/ripgrep", "com.ryu.ripgrep"],
        grants: &["tool:command:rg"],
    },
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/just-bash", "com.ryu.just-bash"],
        grants: &["tool:command:just-bash"],
    },
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/bitwarden", "com.ryu.bitwarden"],
        grants: &["tool:command:bws"],
    },
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/kill-switch", "com.ryu.kill-switch"],
        grants: &["execution:control"],
    },
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/chat-title", "com.ryu.chat-title"],
        grants: &["hook:run-self"],
    },
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/life-recorder", "com.ryu.life-recorder"],
        grants: &["timeline:speech", "media:record"],
    },
    // Short host-owned microphone windows only; no Shadow speech history.
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/teleprompter", "com.ryu.teleprompter"],
        grants: &["media:record"],
    },
    // Voice Studio records consented voice samples through the same short
    // host-owned microphone window; no Shadow speech history.
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/voice", "com.ryu.voice"],
        grants: &["media:record"],
    },
    // Video Studio's voiceover and screen/camera recorder (an optional grant the
    // viewer still approves); no Shadow speech history.
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/video-studio", "com.ryu.video-studio"],
        grants: &["media:record"],
    },
    // Write-capable sub-agents stay off the global allowlist so an app holding
    // plain `hook:run-agent` cannot escalate to `preset: "code_write"`; only the
    // reviewed first-party owners whose shipped flows launch a write delegate.
    OwnerExclusiveGrant {
        owner_ids: RUN_AGENT_WRITE_OWNERS,
        grants: &[RUN_AGENT_WRITE_GRANT],
    },
    // Agent accounts: `vault.credentialFill` returns the stored password or the
    // current TOTP code to the calling sidecar, and Core cannot see the page it
    // claims to fill. Only the reviewed Browser app may hold it; on the global
    // allowlist any installed app's sidecar could read every agent's logins.
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/browser", "com.ryu.browser"],
        grants: &["vault:fill"],
    },
    // Security-key relay: `securityKey.request` asks the user's desktop key to
    // sign a WebAuthn challenge for the page origin the sidecar reports. Only
    // the reviewed Browser app, which builds that origin itself, may hold it.
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/browser", "com.ryu.browser"],
        grants: &["security-key:relay"],
    },
    // Project guidance: `scopeGuidance.set` writes text that every turn in the
    // project carries in its system prompt, user-started turns included. Only
    // the reviewed Projects app, which owns project settings, may hold it;
    // `chat.sendFollowUp` alone would hand it to every app that posts turns.
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/projects", "com.ryu.projects"],
        grants: &["chat:project-guidance"],
    },
    // `runs.rerunAgent` starts an unattended turn of the named agent on the
    // caller's prompt, with no approval; `core#run.failed` (`runs:failures`)
    // carries every member's failed-run text, private runs included. Only the
    // reviewed Healing app may hold either.
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/healing", "com.ryu.healing"],
        grants: &["runs:rerun-agent", "runs:failures"],
    },
    // `warmup.apply` / `warmup.runNow` schedule and run unattended agent turns
    // with no approval. Only the reviewed Warmup app may (Core also bounds the
    // prompt to a short single-line ping).
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/warmup", "com.ryu.warmup"],
        grants: &["warmup:crud"],
    },
    // Saved workflows run Tool / Mcp / GhostAction / Script / Agent nodes as the
    // owner with no per-call approval, so authoring and running them is
    // `tool:call`-equivalent. Only the reviewed Workflows editor and Feedback
    // Board may; Healing only re-runs failed runs (`workflows.rerun`).
    OwnerExclusiveGrant {
        owner_ids: &[
            "@ryu/workflows",
            "com.ryu.workflows",
            "@ryu/feedback-board",
            "com.ryu.feedback-board",
        ],
        grants: &["workflows:crud", "workflows:runstate"],
    },
    OwnerExclusiveGrant {
        owner_ids: &["@ryu/healing", "com.ryu.healing"],
        grants: &["workflows:runstate"],
    },
    // Owner-token Agent Mail / Outpost bridges for reviewed cross-app holders.
    OwnerExclusiveGrant {
        owner_ids: crossapp_grants::MAIL_CRUD_CROSSAPP_OWNERS,
        grants: &[crossapp_grants::MAIL_CRUD_GRANT],
    },
    OwnerExclusiveGrant {
        owner_ids: crossapp_grants::SOCIAL_CRUD_CROSSAPP_OWNERS,
        grants: &[crossapp_grants::SOCIAL_CRUD_GRANT],
    },
    OwnerExclusiveGrant {
        owner_ids: crossapp_grants::SKILLS_CRUD_CROSSAPP_OWNERS,
        grants: &[crossapp_grants::SKILLS_CRUD_GRANT],
    },
    // Whole sidecar mounts of Deep Read, Blueprint and Recipes, forwarded with
    // the owner's node token, for the reviewed holders only.
    OwnerExclusiveGrant {
        owner_ids: mounted_app_grants::RLM_QUERY_HOLDERS,
        grants: &[mounted_app_grants::RLM_QUERY_GRANT],
    },
    OwnerExclusiveGrant {
        owner_ids: mounted_app_grants::BLUEPRINT_REVIEW_HOLDERS,
        grants: &[mounted_app_grants::BLUEPRINT_REVIEW_GRANT],
    },
    OwnerExclusiveGrant {
        owner_ids: mounted_app_grants::RECIPES_REQUEST_HOLDERS,
        grants: &[mounted_app_grants::RECIPES_REQUEST_GRANT],
    },
    // Wholesale loopback egress (any 127.0.0.1 port) for the reviewed in-repo
    // declarers only; a marketplace manifest cannot self-request it.
    OwnerExclusiveGrant {
        owner_ids: loopback_egress::LOOPBACK_EGRESS_OWNERS,
        grants: &[loopback_egress::LOOPBACK_EGRESS_GRANT],
    },
];

/// The owner-exclusive grants reviewed for `app_id` (exact, case-insensitive id
/// match after trimming; empty for every other caller). Rows are unioned, so one
/// grant shared by several owners can be its own row and an owner may appear in
/// more than one row.
pub(super) fn owner_exclusive_grants(app_id: &str) -> Vec<&'static str> {
    let app_id = app_id.trim();
    OWNER_EXCLUSIVE_GRANTS
        .iter()
        .filter(|row| {
            row.owner_ids
                .iter()
                .any(|id| id.eq_ignore_ascii_case(app_id))
        })
        .flat_map(|row| row.grants.iter().copied())
        .collect()
}

/// The explicit grant that lets `host.runAgent` / `host.runFanout` launch a
/// mutating (`code_write`) preset. Not on [`default_grant_allowlist`].
pub(super) const RUN_AGENT_WRITE_GRANT: &str = "hook:run-agent:write";

/// Reviewed first-party apps whose shipped flows run a write-capable sub-agent
/// (Autopilot's strategy cycle and Sites' provider reset action).
pub(super) const RUN_AGENT_WRITE_OWNERS: &[&str] = &[
    "@ryu/autopilot",
    "com.ryu.autopilot",
    "@ryu/sites",
    "com.ryu.sites",
];

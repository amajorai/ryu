//! Host API method rows, part 2 of 5: `crypto.status` through `finetune.list`.
//!
//! [`super::ALL`] joins the parts in order, and that order is the order of
//! `schemas/host-api.json`, so a new row goes where it belongs in the
//! sequence, not at the end of whichever part has room.

use super::super::{m, HostApiMethod};

pub(in crate::host_api) const ROWS: &[HostApiMethod] = &[
    // Non-secret custody description (`ryu_crypto::key_custody`) so an app can
    // tell the user WHICH guarantee is live before it stores anything — a file
    // fallback key sits next to the data it protects and is materially weaker
    // than the keychain. Carries no key material, so it rides the same grant
    // rather than minting a second one.
    m(
        "crypto.status",
        "crypto.seal",
        Some("crypto:seal"),
        false,
        true,
    ),
    // Conversation title write for turn-hook plugins (chat-title auto-rename).
    // `mode: "auto"` respects `title_custom`; `mode: "custom"` locks the title.
    // Rust-bridge-only (`ts_host = false`): sandboxed turn hooks reach it via
    // `PluginHookBridge`; it is not a TS app-host RPC.
    m(
        "conversation.setTitle",
        "conversation.title",
        Some("conversation:set-title"),
        false,
        false,
    ),
    // Agent-only reaction write. The current conversation and reacting agent are
    // bound by Core's tool dispatch; the sandbox supplies only the exact message
    // id and emoji. Rust-bridge-only so a Companion cannot use this as a generic
    // cross-chat mutation.
    m(
        "conversation.addReaction",
        "conversation.reactions",
        Some("conversation:reactions"),
        false,
        false,
    ),
    // Read a node preference by key (plugin settings fields → `/api/preferences/:key`).
    // Rust-bridge-only — same rationale as `conversation.setTitle`.
    m(
        "preferences.get",
        "preferences.read",
        Some("preferences:read"),
        false,
        false,
    ),
    // Read a normalized, credential-free subscription usage snapshot for an
    // agent. Rust-bridge-only: it is consumed by turn-policy plugins before a
    // model session is opened, not by sandboxed companion UIs.
    m(
        "usage.snapshot",
        "usage.read",
        Some("usage:read"),
        false,
        false,
    ),
    // Owner-tier subscription inventory: every subscription provider with its
    // saved accounts (labels may be email addresses) and cache-first per-account
    // usage readings. Core additionally requires a verified node owner/admin
    // caller; credentials, tokens and credential revisions never cross. Exposed
    // to Companion frames and sidecars, so `ts_host = true`.
    // `subscriptions:pin` is a RESERVED grant name for future turn-level account
    // pinning; it deliberately has no row here and no Gateway allowlist entry.
    m(
        "subscriptions.list",
        "subscriptions.read",
        Some("subscriptions:read"),
        false,
        true,
    ),
    m(
        "subscriptions.usage",
        "subscriptions.read",
        Some("subscriptions:read"),
        false,
        true,
    ),
    // Read the Gateway-owned live charged-spend counters and configured caps.
    // Rust-bridge-only: Core keeps the Gateway admin credential out of app and
    // Companion processes and returns only the redacted budget snapshot.
    m(
        "gateway.budgetSpend",
        "gateway.budgetSpend",
        Some("usage:read"),
        false,
        false,
    ),
    // Administrative audit records span callers and may include commands/errors.
    // Separate grant approval and verified node administrator authority are required.
    m(
        "gateway.audit",
        "gateway.audit",
        Some("usage:audit"),
        false,
        false,
    ),
    // Record a thumbs vote on an assistant turn — the `message_actions` seam's
    // dispatch verb for the Learning app's rating toggle. Wraps Core's
    // `apply_message_feedback` (learning reward + RAG-memory sinks). Rust-bridge-only.
    m(
        "learning.recordFeedback",
        "learning.recordFeedback",
        Some("learning:crud"),
        false,
        false,
    ),
    // Distill a skill from a conversation (the "make a skill from this chat"
    // context-menu row). Wraps `synthesize_skill`. Rust-bridge-only.
    m(
        "learning.synthesizeSkill",
        "learning.synthesizeSkill",
        Some("learning:crud"),
        false,
        false,
    ),
    // Run one of the CALLING plugin's own declared turn hooks on demand, outside
    // the turn loop — the seam behind a "do it now" menu row (e.g. chat-title's
    // "Rename chat"). A plugin's menu row can only dispatch a HOST capability, so
    // without this an app whose whole behaviour lives in a hook had no way to be
    // triggered by the user at all. Scoped to the caller's own hooks by the bridge,
    // which takes the plugin id from the path, never the body. Rust-bridge-only.
    m(
        "hooks.run",
        "hooks.run",
        Some("hook:run-self"),
        false,
        false,
    ),
    m(
        "agent.run.stream",
        "agent.run",
        Some("hook:run-agent"),
        true,
        true,
    ),
    m(
        "agent.cancel",
        "agent.run",
        Some("hook:run-agent"),
        false,
        true,
    ),
    m(
        "execution.pause",
        "execution.control",
        Some("execution:control"),
        false,
        false,
    ),
    m(
        "execution.resume",
        "execution.control",
        Some("execution:control"),
        false,
        false,
    ),
    m(
        "execution.status",
        "execution.control",
        Some("execution:control"),
        false,
        false,
    ),
    // Get-or-create a user-owned Space by NAME. Companion hosts implement this
    // host-directly with the authenticated Spaces API; headless hooks still use the
    // Rust bridge path. Keeping one method name lets both surfaces share the contract.
    m(
        "spaces.ensureSpace",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    m(
        "spaces.createDoc",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    m(
        "spaces.getDoc",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    m(
        "spaces.updateDoc",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    m(
        "spaces.listDocs",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    m(
        "spaces.deleteDoc",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    // Native Space databases are a distinct grant from app-owned documents:
    // callers can create and update database documents, and run bounded read-only SQL.
    m(
        "spaces.createDatabase",
        "spaces.database",
        Some("spaces:database"),
        false,
        true,
    ),
    m(
        "spaces.listDatabases",
        "spaces.database",
        Some("spaces:database"),
        false,
        true,
    ),
    m(
        "spaces.getDatabase",
        "spaces.database",
        Some("spaces:database"),
        false,
        true,
    ),
    m(
        "spaces.updateDatabase",
        "spaces.database",
        Some("spaces:database"),
        false,
        true,
    ),
    m(
        "spaces.queryDatabase",
        "spaces.database",
        Some("spaces:database"),
        false,
        true,
    ),
    m(
        "spaces.deleteDatabase",
        "spaces.database",
        Some("spaces:database"),
        false,
        true,
    ),
    // Direct semantic retrieval through the authenticated Spaces/RAG endpoint. The
    // companion host owns the token and forwards only the bounded query; Core still
    // enforces Space visibility and tenancy on the underlying route.
    m(
        "spaces.search",
        "spaces.docs",
        Some("spaces:docs"),
        false,
        true,
    ),
    m(
        "media.image",
        "media.generate",
        Some("media:generate"),
        false,
        true,
    ),
    m(
        "media.video",
        "media.generate",
        Some("media:generate"),
        false,
        true,
    ),
    m(
        "media.audio",
        "media.generate",
        Some("media:generate"),
        false,
        true,
    ),
    m(
        "media.tts",
        "media.generate",
        Some("media:generate"),
        false,
        true,
    ),
    m(
        "media.ttsEngines",
        "media.generate",
        Some("media:generate"),
        false,
        true,
    ),
    m(
        "media.ttsEngineInstall",
        "voice.models.manage",
        Some("voice:models:manage"),
        false,
        true,
    ),
    m(
        "media.transcribe",
        "media.transcribe",
        Some("media:transcribe"),
        false,
        true,
    ),
    m(
        "media.recording",
        "media.recording",
        Some("media:record"),
        false,
        true,
    ),
    m(
        "registry.engineModels",
        "core.listAgents",
        Some("core:list_agents"),
        false,
        true,
    ),
    m(
        "registry.ttsEngines",
        "core.listAgents",
        Some("core:list_agents"),
        false,
        true,
    ),
    m(
        "registry.agents",
        "core.listAgents",
        Some("core:list_agents"),
        false,
        true,
    ),
    m(
        "assets.searchGifs",
        "core.listAgents",
        Some("core:list_agents"),
        false,
        true,
    ),
    m(
        "assets.searchImages",
        "core.listAgents",
        Some("core:list_agents"),
        false,
        true,
    ),
    m(
        "finetune.capability",
        "finetune.runs",
        Some("finetune:runs"),
        false,
        true,
    ),
    m(
        "finetune.start",
        "finetune.runs",
        Some("finetune:runs"),
        false,
        true,
    ),
    m(
        "finetune.list",
        "finetune.runs",
        Some("finetune:runs"),
        false,
        true,
    ),
];

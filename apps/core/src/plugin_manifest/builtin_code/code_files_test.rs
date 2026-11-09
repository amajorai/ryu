//! The test-build `code_file` table: every hook and adapter body any package manifest names.
//!
//! Split out of `builtin_code.rs` to keep each file within the repository size
//! limits; the module docs there explain the tables and their bijection tests.

/// `(plugin id, package-root-relative path, file contents)` for every `code_file` a
/// package manifest references — from EITHER store root, since an apps-store app can
/// contribute a turn hook exactly like a plugin can (`packaged_code_file_refs` walks
/// both, and `tools/mirror-public.sh` step 1c vendors `apps-store/*/hooks/*.js`
/// alongside the plugins-store ones). Sorted by root, then package dir, then path.
#[cfg(test)]
pub(crate) const BUILTIN_CODE_FILES: &[(&str, &str, &str)] = &[
    // ── apps-store ───────────────────────────────────────────────────────────
    // reasoning
    (
        "@ryu/reasoning",
        "adapters/verify.claim.js",
        include_str!("../../../../../generated/ryu-runtime/apps-store/reasoning/adapters/verify.claim.js"),
    ),
    (
        "@ryu/reasoning",
        "adapters/verify.scopes.js",
        include_str!("../../../../../generated/ryu-runtime/apps-store/reasoning/adapters/verify.scopes.js"),
    ),
    (
        "@ryu/reasoning",
        "hooks/check.js",
        include_str!("../../../../../generated/ryu-runtime/apps-store/reasoning/hooks/check.js"),
    ),
    // tuition
    (
        "@ryu/tuition",
        "hooks/study.js",
        include_str!("../../../../../generated/ryu-runtime/apps-store/tuition/hooks/study.js"),
    ),
    // news
    (
        "@ryu/news",
        "hooks/ground.js",
        include_str!("../../../../../generated/ryu-runtime/apps-store/news/hooks/ground.js"),
    ),
    // rlm
    (
        "@ryu/rlm",
        "hooks/deep-read.js",
        include_str!("../../../../../generated/ryu-runtime/apps-store/rlm/hooks/deep-read.js"),
    ),
    // ── plugins-store ────────────────────────────────────────────────────────
    // effort-escalator
    (
        "@ryu/effort-escalator",
        "hooks/judge.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/effort-escalator/hooks/judge.js"),
    ),
    (
        "@ryu/effort-escalator",
        "hooks/select-model.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/effort-escalator/hooks/select-model.js"),
    ),
    // usage-pacer
    (
        "@ryu/usage-pacer",
        "hooks/select-model.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/usage-pacer/hooks/select-model.js"),
    ),
    // advisor
    (
        "@ryu/advisor",
        "hooks/review.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/advisor/hooks/review.js"),
    ),
    // agent-comms
    (
        "@ryu/agent-comms",
        "hooks/deliver.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/agent-comms/hooks/deliver.js"),
    ),
    (
        "@ryu/agent-comms",
        "hooks/directory.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/agent-comms/hooks/directory.js"),
    ),
    // agents-md-tail
    (
        "@ryu/agents-md-tail",
        "hooks/inject.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/agents-md-tail/hooks/inject.js"),
    ),
    // rules
    (
        "@ryu/rules",
        "hooks/inject.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/rules/hooks/inject.js"),
    ),
    // agentbrowser
    (
        "@ryu/agentbrowser",
        "adapters/browser.click.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/adapters/browser.click.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.screenshot.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/adapters/browser.screenshot.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.scroll.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/adapters/browser.scroll.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.snapshot.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/adapters/browser.snapshot.js"),
    ),
    (
        "@ryu/agentbrowser",
        "adapters/browser.type.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/adapters/browser.type.js"),
    ),
    // codex-computer-use
    (
        "@ryu/codex-computer-use",
        "adapters/computer.capture.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/codex-computer-use/adapters/computer.capture.js"),
    ),
    (
        "@ryu/codex-computer-use",
        "adapters/computer.click.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/codex-computer-use/adapters/computer.click.js"),
    ),
    (
        "@ryu/codex-computer-use",
        "adapters/computer.key.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/codex-computer-use/adapters/computer.key.js"),
    ),
    (
        "@ryu/codex-computer-use",
        "adapters/computer.type.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/codex-computer-use/adapters/computer.type.js"),
    ),
    // ego-browser
    (
        "@ryu/ego-browser",
        "adapters/browser.click.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/ego-browser/adapters/browser.click.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.navigate.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/ego-browser/adapters/browser.navigate.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.screenshot.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/ego-browser/adapters/browser.screenshot.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.scroll.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/ego-browser/adapters/browser.scroll.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.snapshot.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/ego-browser/adapters/browser.snapshot.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.tabs.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/ego-browser/adapters/browser.tabs.js"),
    ),
    (
        "@ryu/ego-browser",
        "adapters/browser.type.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/ego-browser/adapters/browser.type.js"),
    ),
    // bytebot
    (
        "@ryu/bytebot",
        "adapters/computer.scroll.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/bytebot/adapters/computer.scroll.js"),
    ),
    // cloudflare-browser-run (external provider)
    (
        "@ryu/cloudflare-browser-run",
        "adapters/browser.navigate.js",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/external_plugins/cloudflare-browser-run/adapters/browser.navigate.js"
        ),
    ),
    (
        "@ryu/cloudflare-browser-run",
        "adapters/browser.screenshot.js",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/external_plugins/cloudflare-browser-run/adapters/browser.screenshot.js"
        ),
    ),
    (
        "@ryu/cloudflare-browser-run",
        "adapters/browser.snapshot.js",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/external_plugins/cloudflare-browser-run/adapters/browser.snapshot.js"
        ),
    ),
    // steel (external provider)
    (
        "@ryu/steel",
        "adapters/browser.click.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/external_plugins/steel/adapters/browser.click.js"),
    ),
    (
        "@ryu/steel",
        "adapters/browser.hover.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/external_plugins/steel/adapters/browser.hover.js"),
    ),
    (
        "@ryu/steel",
        "adapters/browser.navigate.js",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/external_plugins/steel/adapters/browser.navigate.js"
        ),
    ),
    (
        "@ryu/steel",
        "adapters/browser.screenshot.js",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/external_plugins/steel/adapters/browser.screenshot.js"
        ),
    ),
    (
        "@ryu/steel",
        "adapters/browser.scroll.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/external_plugins/steel/adapters/browser.scroll.js"),
    ),
    (
        "@ryu/steel",
        "adapters/browser.snapshot.js",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/external_plugins/steel/adapters/browser.snapshot.js"
        ),
    ),
    (
        "@ryu/steel",
        "adapters/browser.type.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/external_plugins/steel/adapters/browser.type.js"),
    ),
    // kernel (external provider)
    (
        "@ryu/kernel",
        "adapters/browser.click_at.js",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/external_plugins/kernel/adapters/browser.click_at.js"
        ),
    ),
    (
        "@ryu/kernel",
        "adapters/browser.drag.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/external_plugins/kernel/adapters/browser.drag.js"),
    ),
    (
        "@ryu/kernel",
        "adapters/browser.key.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/external_plugins/kernel/adapters/browser.key.js"),
    ),
    (
        "@ryu/kernel",
        "adapters/browser.navigate.js",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/external_plugins/kernel/adapters/browser.navigate.js"
        ),
    ),
    (
        "@ryu/kernel",
        "adapters/browser.screenshot.js",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/external_plugins/kernel/adapters/browser.screenshot.js"
        ),
    ),
    (
        "@ryu/kernel",
        "adapters/browser.scroll.js",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/external_plugins/kernel/adapters/browser.scroll.js"
        ),
    ),
    (
        "@ryu/kernel",
        "adapters/browser.tabs.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/external_plugins/kernel/adapters/browser.tabs.js"),
    ),
    // browser-use
    (
        "@ryu/browser-use",
        "adapters/browser.click.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/browser-use/adapters/browser.click.js"),
    ),
    (
        "@ryu/browser-use",
        "adapters/browser.navigate.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/browser-use/adapters/browser.navigate.js"),
    ),
    (
        "@ryu/browser-use",
        "adapters/browser.screenshot.js",
        include_str!(
            "../../../../../generated/ryu-runtime/plugins-store/plugins/browser-use/adapters/browser.screenshot.js"
        ),
    ),
    (
        "@ryu/browser-use",
        "adapters/browser.scroll.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/browser-use/adapters/browser.scroll.js"),
    ),
    (
        "@ryu/browser-use",
        "adapters/browser.snapshot.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/browser-use/adapters/browser.snapshot.js"),
    ),
    (
        "@ryu/browser-use",
        "adapters/browser.tabs.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/browser-use/adapters/browser.tabs.js"),
    ),
    (
        "@ryu/browser-use",
        "adapters/browser.type.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/browser-use/adapters/browser.type.js"),
    ),
    // chat-title
    (
        "@ryu/chat-title",
        "hooks/rename.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/chat-title/hooks/rename.js"),
    ),
    // double-check
    (
        "@ryu/double-check",
        "hooks/review.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/double-check/hooks/review.js"),
    ),
    // exa
    (
        "@ryu/exa",
        "adapters/web.search.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/exa/adapters/web.search.js"),
    ),
    // firecrawl
    (
        "@ryu/firecrawl",
        "adapters/web.crawl.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/firecrawl/adapters/web.crawl.js"),
    ),
    (
        "@ryu/firecrawl",
        "adapters/web.extract.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/firecrawl/adapters/web.extract.js"),
    ),
    // jina-reader
    (
        "@ryu/jina-reader",
        "adapters/web.extract.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/jina-reader/adapters/web.extract.js"),
    ),
    // goal
    (
        "@ryu/goal",
        "hooks/loop.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/goal/hooks/loop.js"),
    ),
    // honcho
    (
        "@ryu/honcho",
        "adapters/memory.store.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/honcho/adapters/memory.store.js"),
    ),
    (
        "@ryu/honcho",
        "adapters/memory.sync.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/honcho/adapters/memory.sync.js"),
    ),
    // hook-observers
    (
        "@ryu/hook-observers",
        "hooks/notification.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/hook-observers/hooks/notification.js"),
    ),
    (
        "@ryu/hook-observers",
        "hooks/session-end.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/hook-observers/hooks/session-end.js"),
    ),
    (
        "@ryu/hook-observers",
        "hooks/subagent-stop.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/hook-observers/hooks/subagent-stop.js"),
    ),
    (
        "@ryu/hook-observers",
        "hooks/workflow-run-failed.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/hook-observers/hooks/workflow-run-failed.js"),
    ),
    (
        "@ryu/hook-observers",
        "hooks/app-event-meeting-ended.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/hook-observers/hooks/app-event-meeting-ended.js"),
    ),
    // hook-session-context
    (
        "@ryu/session-context",
        "hooks/start.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/hook-session-context/hooks/start.js"),
    ),
    // no-ai-slop
    (
        "@ryu/no-ai-slop",
        "hooks/review.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/no-ai-slop/hooks/review.js"),
    ),
    // no-more-mistakes
    (
        "@ryu/no-more-mistakes",
        "hooks/capture.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/no-more-mistakes/hooks/capture.js"),
    ),
    (
        "@ryu/no-more-mistakes",
        "hooks/brief.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/no-more-mistakes/hooks/brief.js"),
    ),
    (
        "@ryu/no-more-mistakes",
        "hooks/command.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/no-more-mistakes/hooks/command.js"),
    ),
    // polite-prompts
    (
        "@ryu/polite-prompts",
        "hooks/rewrite.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/polite-prompts/hooks/rewrite.js"),
    ),
    // parallel
    (
        "@ryu/parallel",
        "adapters/web.search.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/parallel/adapters/web.search.js"),
    ),
    // plan-continue
    (
        "@ryu/plan-continue",
        "hooks/loop.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/plan-continue/hooks/loop.js"),
    ),
    // auto-continue
    (
        "@ryu/auto-continue",
        "hooks/loop.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/auto-continue/hooks/loop.js"),
    ),
    // proof
    (
        "@ryu/proof",
        "hooks/loop.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/proof/hooks/loop.js"),
    ),
    // recap
    (
        "@ryu/recap",
        "hooks/command.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/recap/hooks/command.js"),
    ),
    (
        "@ryu/recap",
        "hooks/turn.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/recap/hooks/turn.js"),
    ),
    // receipts
    (
        "@ryu/receipts",
        "hooks/loop.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/receipts/hooks/loop.js"),
    ),
    // scrapling
    (
        "@ryu/scrapling",
        "adapters/web.extract.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/scrapling/adapters/web.extract.js"),
    ),
    // security-guidance
    (
        "@ryu/security-guidance",
        "hooks/review.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/security-guidance/hooks/review.js"),
    ),
    // security-scanner
    (
        "@ryu/security-scanner",
        "hooks/auto-review.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/security-scanner/hooks/auto-review.js"),
    ),
    (
        "@ryu/security-scanner",
        "hooks/command.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/security-scanner/hooks/command.js"),
    ),
    // tavily
    (
        "@ryu/tavily",
        "adapters/web.extract.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/tavily/adapters/web.extract.js"),
    ),
    // tool-firewall
    (
        "@ryu/tool-firewall",
        "hooks/post.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/tool-firewall/hooks/post.js"),
    ),
    (
        "@ryu/tool-firewall",
        "hooks/pre.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/tool-firewall/hooks/pre.js"),
    ),
    // action-summary
    (
        "@ryu/action-summary",
        "hooks/action.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/action-summary/hooks/action.js"),
    ),
    // observer-agents
    (
        "@ryu/observer-agents",
        "hooks/review.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/observer-agents/hooks/review.js"),
    ),
    // tokenmaxxing
    (
        "@ryu/tokenmaxxing",
        "hooks/delegation-complete.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/tokenmaxxing/hooks/delegation-complete.js"),
    ),
    // auto-translate
    (
        "@ryu/auto-translate",
        "hooks/reply.js",
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/auto-translate/hooks/reply.js"),
    ),
];

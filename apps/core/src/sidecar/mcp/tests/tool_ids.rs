//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use crate::sidecar::mcp::tests::{register_as_enabled, sample_tool, GhostBinPresent};

#[test]
fn allowlist_none_allows_all() {
    let t = sample_tool();
    assert!(McpRegistry::tools_for_agent_matches(&t, None));
}

#[test]
fn allowlist_matches_fully_qualified_id() {
    let t = sample_tool();
    assert!(tool_allowed(&t, &["fs.read_file".to_owned()]));
}

#[test]
fn allowlist_matches_bare_name() {
    let t = sample_tool();
    assert!(tool_allowed(&t, &["read_file".to_owned()]));
}

#[test]
fn allowlist_matches_server_name() {
    let t = sample_tool();
    assert!(tool_allowed(&t, &["fs".to_owned()]));
}

#[test]
fn allowlist_all_marker_allows_everything() {
    let t = sample_tool();
    assert!(tool_allowed(&t, &[crate::agents::ALL_MCP_TOOLS.to_owned()]));
}

#[test]
fn allowlist_rejects_unlisted() {
    let t = sample_tool();
    assert!(!tool_allowed(&t, &["other.tool".to_owned()]));
    assert!(!tool_allowed(&t, &[]));
}

#[test]
fn tool_id_round_trips() {
    let id = McpRegistry::tool_id("git", "commit");
    assert_eq!(id, "git.commit");
    assert_eq!(McpRegistry::split_tool_id(&id), Some(("git", "commit")));
    assert_eq!(canonical_tool_id("git__commit"), "git.commit");
    assert_eq!(canonical_tool_id("skills__a__b"), "skills.a__b");
    assert_eq!(
        canonical_tool_id("io.github.acme/files__read"),
        "io.github.acme/files.read"
    );
    assert_eq!(
        canonical_tool_id("io.github.acme/files.foo__bar"),
        "io.github.acme/files.foo__bar"
    );
    assert_eq!(
        canonical_tool_id("ryu_ext__ryu_crm__post_records"),
        "ryu_ext.ryu_crm.post_records"
    );
    assert_eq!(
        canonical_tool_id("web.search__preview"),
        "web.search__preview"
    );
    assert_eq!(canonical_tool_id("app__foo.bar"), "app.foo.bar");
    assert_eq!(
        McpRegistry::split_tool_id("git__commit"),
        Some(("git", "commit"))
    );

    let registry = McpRegistry::from_servers(BTreeMap::from([
        ("io".to_owned(), McpServerConfig::default()),
        (
            "io.github.acme/files".to_owned(),
            McpServerConfig::default(),
        ),
    ]));
    let legacy_dotted = registry.canonical_tool_id_for_registry("io.github.acme/files__read");
    assert_eq!(legacy_dotted, "io.github.acme/files.read");
    assert_eq!(
        registry.split_registered_tool_id(&legacy_dotted),
        Some(("io.github.acme/files", "read"))
    );
    assert_eq!(
        registry.split_registered_tool_id("io.github.acme/files.read"),
        Some(("io.github.acme/files", "read"))
    );
}

#[test]
fn duplicate_server_name_detected() {
    let reg = McpRegistry::empty();
    // Ghost is registered via its manifest (no longer a hardcoded built-in); the
    // guard makes its declared command resolvable so registration is not skipped.
    let _ghost = GhostBinPresent::new();
    register_as_enabled(&reg, &GhostBinPresent::manifest(), &[]);
    assert!(reg.contains_server(GHOST_SERVER));
    // web_fetch is always reserved.
    assert!(reg.contains_server(web_fetch::SERVER_NAME));
}

/// The defect, stated in the terms the gate itself uses.
///
/// `gate_tool_call` consults `policy::should_require_approval_local`, so that is
/// what this asserts on — not `classify_risk`, which is only one of its inputs.
/// Ordinary skill names, not adversarial ones: `deploy-to-staging` matches the
/// `deploy` pattern, `send-weekly-digest` matches `send`, and under `manual` any
/// slug at all queues. Each is now classified as a catalog id, so the gate the
/// second half of each assertion describes is never reached.
#[test]
fn a_skill_catalog_id_would_have_queued_an_approval_and_now_skips_the_gate() {
    use crate::approvals::policy::{should_require_approval_local, ApprovalMode};

    for slug_id in [
        "skills.deploy-to-staging",
        "skills.send-weekly-digest",
        "skills.delete-stale-branches",
    ] {
        assert!(
            should_require_approval_local(&[], slug_id, ApprovalMode::Smart, Some("smart"))
                .is_some(),
            "{slug_id} classifies risky under the default smart mode — this is \
             the dead approval the guard exists to prevent"
        );
        assert!(
            !approval_gate_applies(slug_id),
            "{slug_id} is a catalog id: the gate must be skipped ahead of it"
        );
    }

    // Manual mode gates every tool id, risky pattern or not, so an innocuous
    // slug queued too. Same guard covers it.
    let innocuous = "skills.summarize-arxiv";
    assert!(
        should_require_approval_local(&[], innocuous, ApprovalMode::Manual, Some("manual"))
            .is_some(),
        "manual mode gates every id, which is why the fix cannot be a pattern tweak"
    );
    assert!(!approval_gate_applies(innocuous));
}

/// The three real tools stay gated exactly as before, and the classification
/// follows the canonical namespace split rather than a prefix guess.
#[test]
fn the_real_skills_tools_stay_gateable_and_slug_shapes_do_not() {
    for callable in SKILLS_CALLABLE_TOOL_IDS {
        assert!(
            approval_gate_applies(callable),
            "{callable} is a callable tool and must keep whatever gate policy says"
        );
    }
    // A slug that itself contains the separator: `split_tool_id` yields
    // ("skills", "a__b"), which is a slug, not `skills.search`.
    assert!(!approval_gate_applies("skills.a__b"));
    assert!(!approval_gate_applies("skills.search__extra"));
    assert!(!approval_gate_applies("skills."));
    // Everything outside the `skills` server is untouched. `app.skills.load`
    // is asserted in its RAW form here; in production the call site classifies
    // the resolved `gate_id`, so an alias is judged by whatever it resolves to —
    // a real skills tool stays gated, a catalog-id target is skipped for the
    // same reason a direct call to it is.
    assert!(approval_gate_applies("gmail.send_email"));
    assert!(approval_gate_applies("app.skills.load"));
    assert!(approval_gate_applies("other.load"));
    // Unroutable (no separator) ids keep the gate rather than losing it.
    assert!(approval_gate_applies("skills"));
}

/// Drift guard, in the direction that can open a hole.
///
/// If a new genuinely-callable `skills.*` tool is added to
/// [`skills_tool::tools`] without an entry in [`SKILLS_CALLABLE_TOOL_IDS`],
/// [`approval_gate_applies`] would call it a catalog id and drop its approval
/// gate — and `skills.author` already writes into the shared skills directory,
/// so an un-gated sibling of it would be a real privilege loss, not a cosmetic
/// one. `tools()` omits `author` unless `RYU_SKILLS_AUTHOR` is set, so this is a
/// subset assertion (not equality) and needs no env manipulation.
#[test]
fn every_advertised_skills_tool_is_in_the_callable_list() {
    for tool in skills_tool::tools() {
        assert!(
            SKILLS_CALLABLE_TOOL_IDS.contains(&tool.id.as_str()),
            "'{}' is advertised as a callable skills tool but is missing from \
             SKILLS_CALLABLE_TOOL_IDS, so the approval gate would be skipped for it",
            tool.id
        );
    }
}

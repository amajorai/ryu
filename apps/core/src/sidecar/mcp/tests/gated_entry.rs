//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;

/// The call path is unchanged apart from the gate: a catalog id still reaches
/// the `skills` provider and comes back with the fallthrough refusal naming
/// `skills.load`.
///
/// Note this process has no global approval engine (`set_global_engine` is a
/// `OnceLock`, and installing one here would gate every other test in this
/// binary), so `gate_tool_call` is a no-op regardless — what this pins is that
/// wrapping the gate did not reorder or short-circuit the dispatch that follows
/// it. The "would have gated" half is covered by the policy assertions above.
#[tokio::test]
async fn a_catalog_id_still_gets_the_unchanged_refusal_through_the_gated_entry() {
    let reg = McpRegistry::default().with_skills(ryu_skills::SkillRegistry::empty());
    let err = reg
        .call_tool_with_identity(
            None,
            "skills.deploy-to-staging",
            serde_json::json!({}),
            None,
            None,
            &[],
            None,
            None,
        )
        .await
        .expect_err("a skill catalog id is never callable");
    let msg = err.to_string();
    assert!(
        msg.contains("is not a callable tool") && msg.contains(skills_tool::LOAD_TOOL_ID),
        "the refusal must be the dispatch fallthrough's, unchanged: {msg}"
    );
    assert!(
        !msg.contains("Approvals inbox"),
        "no approval may be raised for an id that can never execute: {msg}"
    );
    // The wording is built from the requested slug alone, so it is identical for
    // a slug that names a real skill and one that does not — no enumeration
    // oracle. (Structural, hence asserted on an empty registry: the registry
    // holds no skill named here and the message still quotes it back verbatim.)
    assert!(msg.contains("deploy-to-staging"));
}

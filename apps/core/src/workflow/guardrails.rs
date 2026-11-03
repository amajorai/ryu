//! Authoring-time validation of a `Guardrails` node's `checks`.
//!
//! The Gateway firewall owns what each check means and refuses a name it does
//! not know (`unknown_guardrail_check`) rather than allowing the text through. A
//! workflow saved with such a name (`nsfw`, a typo) would still look protected on
//! the canvas until it first ran and failed, so [`WorkflowGraph::build`] rejects
//! it up front. The accepted names mirror `map_checks` in
//! `apps/gateway/src/api/firewall.rs`; a test reads that source so the two lists
//! cannot drift.

use super::*;

/// Every check name the Gateway firewall maps to a detector, after it trims and
/// lowercases the name.
pub const GUARDRAIL_CHECKS: [&str; 11] = [
    "pii",
    "secret",
    "secrets",
    "jailbreak",
    "injection",
    "prompt_injection",
    "moderation",
    "toxicity",
    "bias",
    "bias_fairness",
    "code_injection",
];

/// Whether the Gateway firewall knows `check` (compared trimmed and lowercased).
pub fn is_known_guardrail_check(check: &str) -> bool {
    let normalized = check.trim().to_ascii_lowercase();
    GUARDRAIL_CHECKS.contains(&normalized.as_str())
}

/// Reject a `Guardrails` node that names a check the Gateway would refuse. An
/// empty `checks` list is a pass-through by design and stays valid.
pub(super) fn validate_guardrail_checks(node: &WorkflowNode) -> Result<(), GraphError> {
    let NodeKind::Guardrails { checks } = &node.kind else {
        return Ok(());
    };
    let unknown: Vec<&str> = checks
        .iter()
        .map(|check| check.trim())
        .filter(|check| !is_known_guardrail_check(check))
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    Err(GraphError::InvalidNode(
        node.id.clone(),
        format!(
            "unknown guardrail check(s) {}; expected one of {}",
            unknown
                .iter()
                .map(|check| format!("'{check}'"))
                .collect::<Vec<_>>()
                .join(", "),
            GUARDRAIL_CHECKS.join(", ")
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::test_support::{edge, node, workflow};

    fn guarded(checks: &[&str]) -> Workflow {
        workflow(
            "wf_guard",
            "guard",
            vec![
                node("in", NodeKind::Input { key: None }),
                node(
                    "guard",
                    NodeKind::Guardrails {
                        checks: checks.iter().map(|check| (*check).to_owned()).collect(),
                    },
                ),
                node("out", NodeKind::Output { key: None }),
            ],
            vec![edge("in", "guard"), edge("guard", "out")],
        )
    }

    #[test]
    fn an_unknown_check_fails_the_graph_instead_of_reading_as_protected() {
        for checks in [&["nsfw"][..], &["pii", "nsfw"], &["pii\u{200B}"], &[""]] {
            let error = WorkflowGraph::build(&guarded(checks)).expect_err("unknown check refused");
            assert!(
                matches!(&error, GraphError::InvalidNode(id, reason)
                    if id == "guard" && reason.contains("unknown guardrail check")),
                "{checks:?}: {error}"
            );
        }
    }

    #[test]
    fn known_checks_are_accepted_trimmed_and_in_any_case() {
        for checks in [
            &["  PII "][..],
            &["Jailbreak", "secrets", "moderation"],
            &[
                "prompt_injection",
                "toxicity",
                "bias_fairness",
                "code_injection",
            ],
            &[],
        ] {
            assert!(WorkflowGraph::build(&guarded(checks)).is_ok(), "{checks:?}");
        }
    }

    #[tokio::test]
    async fn persisting_a_workflow_with_an_unknown_check_is_refused() {
        // Validation runs before any id is minted or anything is written.
        let error = persist_workflow(guarded(&["nsfw"]))
            .await
            .expect_err("save refused");
        assert!(
            error.contains("unknown guardrail check(s) 'nsfw'"),
            "{error}"
        );
    }

    #[test]
    fn the_accepted_names_match_the_gateway_firewall_map() {
        let source = include_str!("../../../gateway/src/api/firewall.rs");
        let start = source.find("fn map_checks").expect("map_checks exists");
        let end = start
            + source[start..]
                .find("_ =>")
                .expect("map_checks fallback arm");
        let mut gateway: Vec<&str> = source[start..end]
            .lines()
            .filter(|line| line.contains("=>"))
            .flat_map(|line| line.split("=>").next().unwrap_or("").split('|'))
            .filter_map(|name| name.trim().strip_prefix('"')?.strip_suffix('"'))
            .collect();
        gateway.sort_unstable();
        let mut core = GUARDRAIL_CHECKS.to_vec();
        core.sort_unstable();
        assert_eq!(core, gateway);
    }
}

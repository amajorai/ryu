//! The Connect checkpoint's workflow digest.
//!
//! A redelivered Connect event resumes its checkpoint only while the target
//! workflow is still the one the checkpoint recorded. The digest is an HMAC over
//! canonical JSON (object keys sorted recursively): `serde_json/preserve_order`
//! is on for the whole build, so the plain bytes follow the order the workflow's
//! free-form JSON (tool `args`, `params`) was saved in, and a rewrite that only
//! reorders keys would otherwise look like a different workflow. Checkpoints
//! written before hold the HMAC of those insertion-order bytes; they still match
//! the same workflow.

use anyhow::Result;

use crate::workflow::Workflow;

const WORKFLOW_HASH_KEY: &[u8] = b"ryu-connect-workflow-v1";

/// The digest a new checkpoint records for `workflow`.
pub(super) fn workflow_hash(workflow: &Workflow) -> Result<String> {
    let canonical = ryu_safe_actions::canonical_json(workflow)?;
    Ok(ryu_crypto::hmac_sha256_hex(WORKFLOW_HASH_KEY, &canonical))
}

/// The digest checkpoints recorded before the canonical form.
fn legacy_workflow_hash(workflow: &Workflow) -> Result<String> {
    let bytes = serde_json::to_vec(workflow)?;
    Ok(ryu_crypto::hmac_sha256_hex(WORKFLOW_HASH_KEY, &bytes))
}

/// Whether a checkpoint's recorded digest names `workflow`, in either form.
pub(super) fn checkpoint_matches(recorded: Option<&String>, workflow: &Workflow) -> Result<bool> {
    let Some(recorded) = recorded else {
        return Ok(false);
    };
    Ok(*recorded == workflow_hash(workflow)? || *recorded == legacy_workflow_hash(workflow)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workflow(args: &str) -> Workflow {
        serde_json::from_str(&format!(
            r#"{{"id":"wf","name":"Connect","nodes":[{{"id":"search","type":"tool","name":"spider.crawl","args":{args}}}]}}"#
        ))
        .expect("fixture workflow parses")
    }

    #[test]
    fn a_reordered_rewrite_resumes_and_a_real_change_does_not() {
        let original = workflow(r#"{"url":"https://example.com","limit":5}"#);
        let rewritten = workflow(r#"{"limit":5,"url":"https://example.com"}"#);
        let changed = workflow(r#"{"url":"https://example.com","limit":6}"#);
        // The fixture really is reordered: the insertion-order bytes differ.
        assert_ne!(
            legacy_workflow_hash(&original).unwrap(),
            legacy_workflow_hash(&rewritten).unwrap()
        );
        let recorded = workflow_hash(&original).unwrap();
        assert_eq!(workflow_hash(&rewritten).unwrap(), recorded);
        assert!(checkpoint_matches(Some(&recorded), &rewritten).unwrap());
        assert!(!checkpoint_matches(Some(&recorded), &changed).unwrap());
        assert!(!checkpoint_matches(None, &original).unwrap());
    }

    #[test]
    fn a_checkpoint_recorded_before_the_canonical_digest_still_resumes() {
        let original = workflow(r#"{"url":"https://example.com","limit":5}"#);
        let changed = workflow(r#"{"url":"https://example.com","limit":6}"#);
        let recorded = legacy_workflow_hash(&original).unwrap();
        assert_ne!(recorded, workflow_hash(&original).unwrap());
        assert!(checkpoint_matches(Some(&recorded), &original).unwrap());
        assert!(!checkpoint_matches(Some(&recorded), &changed).unwrap());
    }
}

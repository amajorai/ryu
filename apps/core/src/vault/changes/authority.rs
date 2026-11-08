//! Re-checking a change requester's recorded authority at approval.
//! test-exempt: moved out of changes.rs; changes/tests.rs drives the requester re-check through approval.

use super::*;

/// Whether the requester still holds the capability `request` needs, under
/// the policy bindings in force now. Fails closed: a request without a
/// recorded authority (made by an earlier release) is not authorized.
pub(super) fn requester_still_authorized(
    conn: &Connection,
    request: &ChangeRequest,
) -> Result<bool> {
    let recorded: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT requester_subjects, requester_baseline FROM vault_change_requests
             WHERE id = ?1",
            params![request.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((Some(subjects), Some(baseline))) = recorded else {
        return Ok(false);
    };
    let (Ok(subjects), Ok(baseline)) = (
        serde_json::from_str::<Vec<String>>(&subjects),
        serde_json::from_str::<CapabilitySet>(&baseline),
    ) else {
        return Ok(false);
    };
    let policies = crate::vault::policy::policies_for(conn, &subjects)?;
    // The open wrapping scope is the approver's request, not the requester's:
    // the approver's wrap TTL must not decide the requester's authority.
    let capabilities = crate::vault::policy::wrap_requirement::suspended(|| {
        crate::vault::policy::evaluate_with(
            &baseline,
            &policies,
            &request.coords.policy_key(),
            &TemplateContext::from_subjects(&subjects),
        )
    });
    let needed = match request.operation {
        ChangeOperation::Write => Capability::Write,
        ChangeOperation::Delete => Capability::Delete,
    };
    Ok(capabilities.contains(&needed))
}

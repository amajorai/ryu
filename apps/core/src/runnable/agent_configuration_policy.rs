//! Shared authorization rules for agent configuration across tool transports.

pub(crate) const TOOL_ID: &str = "agent_builder.configure_agent";

pub(crate) fn requires_operator_approval(canonical_tool_id: &str) -> bool {
    canonical_tool_id == TOOL_ID
}

pub(crate) fn require_personal_node(managed: bool, shared: bool) -> Result<(), &'static str> {
    if managed || shared {
        return Err("agent-builder configuration is disabled on managed or shared nodes until agent ownership is bound to the verified caller");
    }
    Ok(())
}

pub(crate) fn edit_target<'a>(
    canonical_tool_id: &str,
    target_agent_id: Option<&'a str>,
) -> Result<Option<&'a str>, &'static str> {
    if !requires_operator_approval(canonical_tool_id) {
        return Ok(None);
    }
    target_agent_id
        .filter(|id| !id.trim().is_empty())
        .map(Some)
        .ok_or("agent_id is required to configure an agent")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_authorizes_the_edit_target_not_the_calling_agent() {
        assert_eq!(
            edit_target(TOOL_ID, Some("peer-agent")),
            Ok(Some("peer-agent"))
        );
        assert!(edit_target(TOOL_ID, None).is_err());
        assert!(edit_target(TOOL_ID, Some(" ")).is_err());
        assert_eq!(edit_target("agent_builder.get_agent", None), Ok(None));
    }

    #[test]
    fn managed_and_shared_configuration_remain_denied_on_approval_replay() {
        assert!(require_personal_node(true, false).is_err());
        assert!(require_personal_node(false, true).is_err());
        assert!(require_personal_node(true, true).is_err());
        assert!(require_personal_node(false, false).is_ok());
    }

    #[test]
    fn only_configuration_requires_mandatory_operator_review() {
        assert!(requires_operator_approval(TOOL_ID));
        assert!(!requires_operator_approval("agent_builder.get_agent"));
        assert!(!requires_operator_approval("agent_builder.create_agent"));
    }
}

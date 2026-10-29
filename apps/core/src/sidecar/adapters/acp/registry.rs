use super::*;

pub struct AcpAgentRegistry {
    pub entries: Vec<AcpAgentEntry>,
}

impl AcpAgentRegistry {
    pub fn new() -> Self {
        Self::new_with_registry_entries(None)
    }

    pub(super) fn new_with_registry_entries(registry_entries: Option<Vec<AcpAgentEntry>>) -> Self {
        {
            let mut entries = super::registry_builtin::seeded_engine_entries();
            entries.extend(super::registry_builtin::cdn_registry_entries());
            entries.extend(super::registry_builtin::native_bridge_entries());
            entries.extend(super::registry_curated::curated_acp_entries());
            entries.extend(super::registry_curated::curated_acp_entries_tail());
            entries.extend(registry_entries.unwrap_or_else(registry_driven_entries));
            Self { entries }
        }
    }
}

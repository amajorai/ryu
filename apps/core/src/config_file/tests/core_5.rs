//! The CONFIG and FLAG rows of `docs/env-audit/core-5.md`: each documented
//! grouped path must flatten to the exact name its reader uses, or the file
//! setting would silently do nothing.

use serde_json::json;

use crate::config_file::{friendly_path_to_env_name, is_reserved_or_secret, value_to_env};

const CASES: &[(&str, &str)] = &[
    ("features.acpDirectSpawn", "RYU_ACP_DIRECT_SPAWN"),
    ("features.tregAgentTools", "RYU_TREG_AGENT_TOOLS"),
    ("media.dir", "RYU_MEDIA_DIR"),
];

#[test]
fn core_5_node_config_paths_reach_their_readers() {
    for (path, expected) in CASES {
        let path: Vec<String> = path.split('.').map(str::to_owned).collect();
        assert_eq!(&friendly_path_to_env_name(&path), expected, "path {path:?}");
        assert!(!is_reserved_or_secret(expected), "{expected} is reserved");
    }
}

/// `acp_direct_spawn::resolve_direct_stdio` turns direct spawning off only for
/// the exact value `0`, so the documented `features.acpDirectSpawn: 0` must
/// reach it unchanged, and `tregAgentTools: true` must be a value its reader
/// accepts.
#[test]
fn core_5_flag_values_match_their_readers() {
    assert_eq!(value_to_env(&json!(0)).unwrap().as_deref(), Some("0"));
    assert_eq!(value_to_env(&json!("0")).unwrap().as_deref(), Some("0"));
    assert_eq!(value_to_env(&json!(true)).unwrap().as_deref(), Some("true"));
    // The documented limitation: `false` stays `"false"`, which the ACP reader
    // does not treat as off.
    assert_eq!(
        value_to_env(&json!(false)).unwrap().as_deref(),
        Some("false")
    );
}

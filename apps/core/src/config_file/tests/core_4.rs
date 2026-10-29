//! The CONFIG rows of `docs/env-audit/core-4.md`: each documented grouped path
//! must flatten to the exact name its reader uses, or the file setting would
//! silently do nothing.

use crate::config_file::{friendly_path_to_env_name, is_reserved_or_secret};

const CASES: &[(&str, &str)] = &[
    ("audiocpp.modelDir", "RYU_AUDIOCPP_MODEL_DIR"),
    ("catalog.sourcesFile", "RYU_CATALOG_SOURCES_FILE"),
    ("downloads.file", "RYU_DOWNLOADS_FILE"),
    ("downloads.historyFile", "RYU_DOWNLOADS_HISTORY_FILE"),
    ("shadow.llmBaseUrl", "RYU_SHADOW_LLM_BASE_URL"),
    ("shadow.llmModel", "RYU_SHADOW_LLM_MODEL"),
    ("whisper.model", "RYU_WHISPER_MODEL"),
    ("ytdlp.url", "RYU_YTDLP_URL"),
    ("ytdlp.version", "RYU_YTDLP_VERSION"),
];

#[test]
fn core_4_node_config_paths_reach_their_readers() {
    for (path, expected) in CASES {
        let path: Vec<String> = path.split('.').map(str::to_owned).collect();
        assert_eq!(&friendly_path_to_env_name(&path), expected, "path {path:?}");
        assert!(!is_reserved_or_secret(expected), "{expected} is reserved");
    }
}

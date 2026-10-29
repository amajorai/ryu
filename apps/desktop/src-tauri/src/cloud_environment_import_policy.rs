//! Platform-reserved process variables cannot be copied into task environments.
pub fn allowed_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        && !["RYU_", "CODEX_", "LD_", "DYLD_"]
            .iter()
            .any(|prefix| upper.starts_with(prefix))
        && !matches!(
            upper.as_str(),
            "PATH"
                | "HOME"
                | "USERPROFILE"
                | "SHELL"
                | "COMSPEC"
                | "NODE_OPTIONS"
                | "BUN_OPTIONS"
                | "HTTP_PROXY"
                | "HTTPS_PROXY"
                | "ALL_PROXY"
                | "NO_PROXY"
        )
}

#[cfg(test)]
mod tests {
    use super::allowed_key;

    #[test]
    fn reserved_process_wiring_cannot_be_imported() {
        for key in [
            "PATH",
            "home",
            "RYU_MASTER_KEY",
            "CODEX_HOME",
            "LD_PRELOAD",
            "HTTPS_PROXY",
            "NODE_OPTIONS",
            "x=y",
            "1KEY",
        ] {
            assert!(!allowed_key(key), "{key}");
        }
        assert!(allowed_key("MY_SERVICE_TOKEN"));
        assert!(allowed_key("_PROJECT_REGION"));
        assert!(!allowed_key(&"A".repeat(129)));
    }
}

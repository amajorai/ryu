//! The coded failures `ensure_core_installed` and `start_ryu_core` hand to the
//! webview.
//!
//! Same rule as `file_resource_error.rs`, `shell_exec_error.rs` and
//! `update_schedule_error.rs`: the native layer never words a user-facing
//! sentence. The commands reject with a plain `code[:detail]` string and the
//! webview maps the code to one whole translated sentence
//! (`apps/desktop/src/lib/desktop-command-error-messages.ts`). The detail is
//! the raw technical cause (installer, stack or release-digest text, OS text),
//! shown only as a left-to-right diagnostic line under that sentence. Codes are
//! wire names, so renaming one is a breaking change there.

/// An app update is being installed; the runtime waits for the restart.
pub const UPDATE_IN_PROGRESS: &str = "update_in_progress";
/// No `ryu-core` binary resolved (env override, managed dir, PATH, dev tree).
pub const CORE_BINARY_MISSING: &str = "core_binary_missing";
/// The binary resolved but the process could not be started.
pub const CORE_SPAWN_FAILED: &str = "core_spawn_failed";
/// The one-line installer failed for a reason other than release checks.
pub const INSTALLER_FAILED: &str = "installer_failed";
/// The downloaded runtime did not match what its release published.
pub const RELEASE_VALIDATION_FAILED: &str = "release_validation_failed";
/// The release metadata the installer verifies against could not be read.
pub const RELEASE_METADATA_UNAVAILABLE: &str = "release_metadata_unavailable";

/// `update_in_progress`.
pub fn update_in_progress() -> String {
    UPDATE_IN_PROGRESS.to_owned()
}

/// `core_binary_missing`.
pub fn core_binary_missing() -> String {
    CORE_BINARY_MISSING.to_owned()
}

/// `core_spawn_failed:<raw cause>`.
pub fn core_spawn_failed(detail: &impl std::fmt::Display) -> String {
    coded(CORE_SPAWN_FAILED, &detail.to_string())
}

/// Wrap a raw installer failure at the command boundary. The installer, stack
/// and release-digest internals keep their plain technical text; only the code
/// in front of it is chosen here, from the release-digest wording it carries.
/// Dev builds never run the installer (turbo owns the binary).
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn installer_failure(detail: &str) -> String {
    coded(installer_code(detail), detail)
}

/// Text the release-digest checks (`core/install/release_digests.rs`) use when
/// they refuse a runtime that does not match its release.
const VALIDATION_MARKERS: [&str; 5] = [
    "does not match the SHA-256 digest",
    "publishes no",
    "does not describe",
    "does not vouch",
    "SHA256SUMS",
];

/// Text those checks use when the release metadata itself could not be read.
const METADATA_MARKER: &str = "release metadata";

/// Fetch failures for the signed `SHA256SUMS` / `.sig` files. They mention
/// `SHA256SUMS` but say nothing about a mismatch, so they are checked first.
const MANIFEST_FETCH_MARKERS: [&str; 2] = ["download SHA256SUMS", "release manifest client"];

fn installer_code(detail: &str) -> &'static str {
    let has = |marker: &&str| detail.contains(*marker);
    if MANIFEST_FETCH_MARKERS.iter().any(has) {
        RELEASE_METADATA_UNAVAILABLE
    } else if VALIDATION_MARKERS.iter().any(has) {
        RELEASE_VALIDATION_FAILED
    } else if detail.contains(METADATA_MARKER) {
        RELEASE_METADATA_UNAVAILABLE
    } else {
        INSTALLER_FAILED
    }
}

fn coded(code: &str, detail: &str) -> String {
    let detail = detail.trim();
    if detail.is_empty() {
        code.to_owned()
    } else {
        format!("{code}:{detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_update_in_progress_path_is_coded_without_english() {
        assert_eq!(update_in_progress(), "update_in_progress");
        assert!(!update_in_progress().contains(' '));
    }

    #[test]
    fn codes_are_stable_wire_names() {
        assert_eq!(core_binary_missing(), "core_binary_missing");
        assert_eq!(
            core_spawn_failed(&"port 8980 in use"),
            "core_spawn_failed:port 8980 in use"
        );
        assert_eq!(core_spawn_failed(&""), "core_spawn_failed");
    }

    #[test]
    fn installer_failures_keep_the_raw_detail() {
        assert_eq!(
            installer_failure("No space left on device (os error 28)"),
            "installer_failed:No space left on device (os error 28)"
        );
        assert_eq!(installer_failure("  "), "installer_failed");
    }

    #[test]
    fn release_digest_refusals_are_validation_failures() {
        for detail in [
            "ryu-core-x86_64 does not match the SHA-256 digest published for v1.2.3; refusing to run it",
            "the release publishes no SHA-256 digest for ryu-core",
            "release metadata does not describe v1.2.3",
            "GitHub does not vouch for v1.2.3 (HTTP 404); refusing the runtime despite its signed SHA256SUMS",
            "SHA256SUMS is not signed by the release signing key",
            "ryu-core does not match the signed SHA256SUMS for v1.2.3; refusing to run it",
        ] {
            let error = installer_failure(detail);
            let (code, rest) = error.split_once(':').expect("coded with a detail");
            assert_eq!(code, "release_validation_failed", "{detail}");
            assert_eq!(rest, detail);
        }
    }

    #[test]
    fn unreadable_release_metadata_is_its_own_code() {
        for detail in [
            "release metadata request returned HTTP 503 Service Unavailable",
            "read release metadata for v1.2.3: connection reset",
            "create release metadata client: builder error",
            "create release manifest client: builder error",
            "download SHA256SUMS for v1.2.3: error sending request",
            "download SHA256SUMS.sig for v1.2.3: HTTP 404 Not Found",
        ] {
            assert!(
                installer_failure(detail).starts_with("release_metadata_unavailable:"),
                "{detail}"
            );
        }
    }
}

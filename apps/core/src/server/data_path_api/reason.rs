//! Stable codes for the data-folder refusals the Storage settings show.
//!
//! `crate::data_path` words its refusals in English (`ValidateResult.error`,
//! the `InvalidInput` errors of `export_zip`). Those strings stay on the wire
//! for older clients, and next to them this module sends a stable code plus the
//! raw values the sentence needs (`need_bytes`, `free_bytes`, `min_chars`), so
//! the desktop words each refusal as one whole sentence in the reader's
//! language and formats sizes in their locale. The OS error text of
//! `not_writable` is never sent as a value: it is technical detail.
//!
//! The classification reads the fixed English texts of `crate::data_path`; the
//! tests below drive the real functions, so a reworded refusal fails here
//! instead of silently losing its code.

use serde_json::{json, Map, Value};

use crate::data_path::ValidateResult;

/// The code and values for a failed validation, or `None` for an unknown text.
fn validate_reason(result: &ValidateResult) -> Option<(&'static str, Value)> {
    let error = result.error.as_deref()?;
    let none = || Value::Object(Map::new());
    let reason = match error {
        "Target path is empty." | "Target path must be absolute." => ("invalid_path", none()),
        "Target cannot be inside the current data folder (or vice versa)." => ("nested", none()),
        "Target folder is not empty." => ("not_empty", none()),
        _ if error.starts_with("Target is not writable") => ("not_writable", none()),
        _ if error.starts_with("Not enough free space") => (
            "insufficient_space",
            json!({
                "need_bytes": result.source_size_bytes,
                "free_bytes": result.target_free_bytes,
            }),
        ),
        _ => return None,
    };
    Some(reason)
}

/// `ValidateResult` as JSON plus `reason_code` / `reason_values` when it failed
/// for a known reason.
pub(super) fn validate_body(result: &ValidateResult) -> Value {
    let mut body = serde_json::to_value(result).unwrap_or_else(|_| json!({ "ok": result.ok }));
    if let (Some((code, values)), Value::Object(map)) = (validate_reason(result), &mut body) {
        map.insert("reason_code".into(), Value::from(code));
        map.insert("reason_values".into(), values);
    }
    body
}

/// The `{ ok:false, error, code?, values? }` body of a refused switch.
pub(super) fn switch_refusal_body(result: &ValidateResult) -> Value {
    let mut body = json!({ "ok": false, "error": result.error });
    if let (Some((code, values)), Value::Object(map)) = (validate_reason(result), &mut body) {
        map.insert("code".into(), Value::from(code));
        map.insert("values".into(), values);
    }
    body
}

/// Code for a failed export: a known `InvalidInput` refusal, else the generic
/// `export_refused` / `export_failed`.
fn export_error_code(error: &std::io::Error) -> &'static str {
    let text = error.to_string();
    if error.kind() != std::io::ErrorKind::InvalidInput {
        return "export_failed";
    }
    match text.as_str() {
        "export destination cannot be inside the data folder" => "export_inside_data_folder",
        "export destination has no parent folder" => "export_no_parent",
        "export destination cannot be a symbolic link" => "export_symlink",
        _ if text.starts_with("the backup passphrase must be at least") => "passphrase_too_short",
        _ if text.starts_with("export the active data folder") => "export_not_active_folder",
        _ => "export_refused",
    }
}

/// The `{ ok:false, error, code, values }` body of a failed export.
pub(super) fn export_error_body(error: &std::io::Error) -> Value {
    let code = export_error_code(error);
    let values = if code == "passphrase_too_short" {
        json!({ "min_chars": crate::data_path::EXPORT_MIN_PASSPHRASE_CHARS })
    } else {
        json!({})
    };
    json!({ "ok": false, "error": error.to_string(), "code": code, "values": values })
}

/// Code of the export refusal on an org-bound (shared) node.
pub(super) const EXPORT_SHARED_NODE_CODE: &str = "export_shared_node";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_path::{export_zip, validate_target};

    #[test]
    fn a_non_empty_target_is_coded_not_empty() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        std::fs::write(target.path().join("keep.txt"), b"x").unwrap();
        let result = validate_target(source.path(), target.path(), false);
        let body = validate_body(&result);
        assert_eq!(body["ok"], false);
        assert_eq!(body["reason_code"], "not_empty");
        assert_eq!(body["error"], "Target folder is not empty.");
        assert_eq!(switch_refusal_body(&result)["code"], "not_empty");
    }

    #[test]
    fn a_nested_or_relative_target_is_coded() {
        let source = tempfile::tempdir().unwrap();
        let nested = source.path().join("inner");
        let result = validate_target(source.path(), &nested, false);
        assert_eq!(validate_body(&result)["reason_code"], "nested");
        let relative = validate_target(source.path(), std::path::Path::new("rel"), false);
        assert_eq!(validate_body(&relative)["reason_code"], "invalid_path");
    }

    #[test]
    fn a_valid_target_carries_no_reason() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let body = validate_body(&validate_target(source.path(), target.path(), false));
        assert_eq!(body["ok"], true);
        assert!(body.get("reason_code").is_none());
    }

    #[test]
    fn the_free_space_refusal_carries_both_byte_counts() {
        let result = ValidateResult {
            ok: false,
            error: Some("Not enough free space: need 3.0 GB, have 1.0 GB.".into()),
            source_size_bytes: 3_221_225_472,
            target_free_bytes: 1_073_741_824,
        };
        let body = validate_body(&result);
        assert_eq!(body["reason_code"], "insufficient_space");
        assert_eq!(body["reason_values"]["need_bytes"], 3_221_225_472u64);
        assert_eq!(body["reason_values"]["free_bytes"], 1_073_741_824u64);
        let switch = switch_refusal_body(&result);
        assert_eq!(switch["values"]["need_bytes"], 3_221_225_472u64);
    }

    #[test]
    fn an_unknown_refusal_keeps_only_the_english_text() {
        let result = ValidateResult {
            ok: false,
            error: Some("something new".into()),
            source_size_bytes: 0,
            target_free_bytes: 0,
        };
        assert!(validate_body(&result).get("reason_code").is_none());
        assert!(switch_refusal_body(&result).get("code").is_none());
    }

    #[test]
    fn export_refusals_from_the_real_exporter_are_coded() {
        let from = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let short = export_zip(from.path(), &out.path().join("b.zip"), "short").unwrap_err();
        let body = export_error_body(&short);
        assert_eq!(body["code"], "passphrase_too_short");
        assert_eq!(body["values"]["min_chars"], 12);

        let inside = export_zip(
            from.path(),
            &from.path().join("b.zip"),
            "a long enough passphrase",
        )
        .unwrap_err();
        assert_eq!(
            export_error_body(&inside)["code"],
            "export_inside_data_folder"
        );
    }

    #[test]
    fn an_uncoded_export_failure_is_generic() {
        let other = std::io::Error::other("disk full");
        assert_eq!(export_error_body(&other)["code"], "export_failed");
        let refused = std::io::Error::new(std::io::ErrorKind::InvalidInput, "new rule");
        assert_eq!(export_error_body(&refused)["code"], "export_refused");
        assert_eq!(export_error_body(&refused)["error"], "new rule");
    }
}

//! Upload-slot validation: malformed caller input is refused before any
//! provider call, and only HTTPS presigned targets are handed back.

use serde_json::json;

use super::{file_upload_slot, FileUploadRequest, FILE_UPLOAD_MAX_BYTES};
use crate::error::GatewayError;

fn valid_file() -> serde_json::Value {
    json!({
        "toolkitSlug": "GoogleDrive",
        "filename": "report.pdf",
        "mimetype": "Application/PDF",
        "md5": "0123456789ABCDEF0123456789abcdef",
        "size": 1024,
    })
}

#[test]
fn a_valid_request_is_normalised() {
    let request = FileUploadRequest::parse(" GOOGLEDRIVE_UPLOAD_FILE ", &valid_file())
        .expect("valid upload request");
    assert_eq!(request.toolkit_slug, "googledrive");
    assert_eq!(request.tool_slug, "GOOGLEDRIVE_UPLOAD_FILE");
    assert_eq!(request.filename, "report.pdf");
    assert_eq!(request.mimetype, "application/pdf");
    assert_eq!(request.md5, "0123456789abcdef0123456789abcdef");
    assert_eq!(request.size, 1024);
}

#[test]
fn malformed_fields_are_refused() {
    let cases = [
        ("filename", json!("../etc/passwd")),
        ("mimetype", json!("pdf")),
        ("md5", json!("abc")),
        ("size", json!(0)),
        ("size", json!(FILE_UPLOAD_MAX_BYTES + 1)),
        ("toolkitSlug", json!("drive/../x")),
    ];
    for (field, value) in cases {
        let mut file = valid_file();
        file[field] = value;
        let result = FileUploadRequest::parse("GOOGLEDRIVE_UPLOAD_FILE", &file);
        assert!(
            matches!(result, Err(GatewayError::BadRequest(_))),
            "{field} must be refused"
        );
    }
    assert!(matches!(
        FileUploadRequest::parse("bad/slug", &valid_file()),
        Err(GatewayError::BadRequest(_))
    ));
}

#[test]
fn only_https_upload_slots_are_returned() {
    let slot = file_upload_slot(&json!({
        "key": "uploads/abc",
        "newPresignedUrl": "https://bucket.example/abc?sig=1",
    }))
    .expect("https slot");
    assert_eq!(
        slot,
        json!({
            "key": "uploads/abc",
            "uploadUrl": "https://bucket.example/abc?sig=1",
            "storageBackend": "s3",
        })
    );
    for response in [
        json!({ "key": "k", "new_presigned_url": "http://bucket.example/abc" }),
        json!({ "key": " ", "new_presigned_url": "https://bucket.example/abc" }),
        json!({ "key": "k" }),
    ] {
        assert!(matches!(
            file_upload_slot(&response),
            Err(GatewayError::ProviderError(_))
        ));
    }
}

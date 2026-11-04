use crate::server::normalize_blob_mime;

#[test]
fn risky_types_are_neutralized() {
    for m in [
        "text/html",
        "text/html; charset=utf-8",
        "image/svg+xml",
        "application/xhtml+xml",
        "application/atom+xml",
        "application/xml",
        "TEXT/HTML",
        "",
        "   ",
    ] {
        assert_eq!(
            normalize_blob_mime(m),
            "application/octet-stream",
            "'{m}' should be neutralized"
        );
    }
}

#[test]
fn safe_types_pass_through() {
    for m in ["image/png", "application/pdf", "audio/mpeg", "text/plain"] {
        assert_eq!(normalize_blob_mime(m), m, "'{m}' should pass through");
    }
}

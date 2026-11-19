//! PKI OCSP responder routes (RFC 6960 Appendix A): unauthenticated, like
//! any OCSP responder, because relying parties check certificates without
//! credentials. `POST` takes a DER `OCSPRequest` body; `GET` takes it
//! base64-encoded (and URL-encoded) as the last path segment. Both answer
//! `application/ocsp-response`; refusals are OCSP statuses, never JSON. The
//! responder only reads the issuer's certificate records.

use base64::Engine as _;

use super::*;
use crate::vault::pki::{MAX_OCSP_REQUEST_BYTES, OCSP_RESPONSE_CONTENT_TYPE};

/// The base64 forms clients send in the GET path.
fn decode_get_request(encoded: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
    let encoded = encoded.trim_start_matches('/');
    if encoded.len() > MAX_OCSP_REQUEST_BYTES * 2 {
        return None;
    }
    [&STANDARD, &URL_SAFE, &URL_SAFE_NO_PAD]
        .into_iter()
        .find_map(|engine| engine.decode(encoded).ok())
}

fn ocsp_reply(der: Vec<u8>) -> Response {
    (
        [
            ("content-type", OCSP_RESPONSE_CONTENT_TYPE),
            ("cache-control", "no-store"),
        ],
        der,
    )
        .into_response()
}

async fn answer(name: &str, request: &[u8]) -> Response {
    match store() {
        Ok(store) => ocsp_reply(store.pki_ocsp(name, request).await),
        // No store: answer `internalError` in OCSP form.
        Err(_) => ocsp_reply(vec![0x30, 0x03, 0x0a, 0x01, 0x02]),
    }
}

/// POST /api/vault/pki/issuers/{name}/ocsp (public).
#[utoipa::path(post, path = "/api/vault/pki/issuers/{name}/ocsp", tag = "Vault",
    summary = "OCSP responder for an issuer (public; DER OCSPRequest body)",
    params(("name" = String, Path, description = "Issuer name")),
    request_body(content = Vec<u8>, content_type = "application/ocsp-request"),
    responses((status = 200, description = "DER OCSPResponse, signed by the issuer", body = Vec<u8>, content_type = "application/ocsp-response")))]
pub async fn pki_ocsp_post(Path(name): Path<String>, body: axum::body::Bytes) -> Response {
    answer(&name, &body).await
}

/// GET /api/vault/pki/issuers/{name}/ocsp/{request} (public).
#[utoipa::path(get, path = "/api/vault/pki/issuers/{name}/ocsp/{request}", tag = "Vault",
    summary = "OCSP responder for an issuer (public; base64 OCSPRequest in the path)",
    params(
        ("name" = String, Path, description = "Issuer name"),
        ("request" = String, Path, description = "URL-encoded base64 of the DER OCSPRequest"),
    ),
    responses((status = 200, description = "DER OCSPResponse, signed by the issuer", body = Vec<u8>, content_type = "application/ocsp-response")))]
pub async fn pki_ocsp_get(Path((name, request)): Path<(String, String)>) -> Response {
    match decode_get_request(&request) {
        Some(der) => answer(&name, &der).await,
        // malformedRequest
        None => ocsp_reply(vec![0x30, 0x03, 0x0a, 0x01, 0x01]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_requests_decode_from_standard_and_url_safe_base64() {
        let der = vec![0x30, 0x03, 0xfb, 0xff, 0x3e];
        for engine in [
            &base64::engine::general_purpose::STANDARD,
            &base64::engine::general_purpose::URL_SAFE,
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        ] {
            assert_eq!(decode_get_request(&engine.encode(&der)), Some(der.clone()));
        }
        assert_eq!(decode_get_request("!!!"), None);
        assert_eq!(
            decode_get_request(&"A".repeat(MAX_OCSP_REQUEST_BYTES * 3)),
            None
        );
    }

    #[tokio::test]
    async fn replies_are_ocsp_responses_not_json() {
        let response = pki_ocsp_get(Path(("x".into(), "!!!".into()))).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-type"],
            OCSP_RESPONSE_CONTENT_TYPE
        );
        let body = axum::body::to_bytes(response.into_body(), 64)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), [0x30, 0x03, 0x0a, 0x01, 0x01]);
    }
}

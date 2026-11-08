//! A local fake of the GitHub, Vercel, AWS Secrets Manager and Google Cloud
//! Secret Manager endpoints the secret-sync targets call (tests only).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use serde_json::{json, Value};

pub(super) struct FakeInner {
    pub(super) github_key: crypto_box::SecretKey,
    /// GitHub secret path → decrypted value.
    pub(super) github: BTreeMap<String, String>,
    pub(super) vercel: Vec<(String, Value)>,
    /// Keys the fake Vercel reports under `failed` (with a 201 status).
    pub(super) vercel_reject: Vec<String>,
    pub(super) aws: BTreeMap<String, String>,
    pub(super) aws_calls: Vec<String>,
    pub(super) aws_bad_signatures: usize,
    pub(super) gcp: BTreeMap<String, Vec<String>>,
    pub(super) gcp_assertions: Vec<Value>,
}

#[derive(Clone)]
pub(super) struct Fake(Arc<Mutex<FakeInner>>);

impl Fake {
    pub(super) fn new() -> Self {
        Self(Arc::new(Mutex::new(FakeInner {
            github_key: crypto_box::SecretKey::generate(&mut crypto_box::aead::OsRng),
            github: BTreeMap::new(),
            vercel: Vec::new(),
            vercel_reject: Vec::new(),
            aws: BTreeMap::new(),
            aws_calls: Vec::new(),
            aws_bad_signatures: 0,
            gcp: BTreeMap::new(),
            gcp_assertions: Vec::new(),
        })))
    }

    pub(super) fn with<T>(&self, f: impl FnOnce(&mut FakeInner) -> T) -> T {
        f(&mut self.0.lock().unwrap())
    }
}

fn reply(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn header(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned()
}

fn github(
    inner: &mut FakeInner,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    body: &Value,
) -> Response {
    if header(headers, "authorization") != "Bearer gh-1" || header(headers, "user-agent").is_empty()
    {
        return reply(StatusCode::UNAUTHORIZED, json!({}));
    }
    if path.ends_with("/secrets/public-key") {
        let key = b64().encode(inner.github_key.public_key().as_bytes());
        return reply(StatusCode::OK, json!({ "key_id": "kid-1", "key": key }));
    }
    if method == Method::PUT && body["key_id"] == "kid-1" {
        let sealed = b64()
            .decode(body["encrypted_value"].as_str().unwrap())
            .unwrap();
        let plain = inner
            .github_key
            .unseal(&sealed)
            .expect("sealed to the repository key");
        inner
            .github
            .insert(path.to_owned(), String::from_utf8(plain).unwrap());
        return reply(StatusCode::CREATED, Value::Null);
    }
    reply(StatusCode::NOT_FOUND, json!({}))
}

fn aws(inner: &mut FakeInner, headers: &HeaderMap, raw: &[u8], body: &Value) -> Response {
    let target = header(headers, "x-amz-target");
    let amz_date = header(headers, "x-amz-date");
    let now = chrono::NaiveDateTime::parse_from_str(&amz_date, "%Y%m%dT%H%M%SZ")
        .unwrap()
        .and_utc();
    let credentials = crate::vault::external::StoreCredentials {
        access_key_id: Some("AKIDTEST".into()),
        secret_access_key: Some("aws-secret".into()),
        ..Default::default()
    };
    let expected = super::aws::sign(
        &credentials,
        "us-east-1",
        &header(headers, "host"),
        &[
            ("content-type", &header(headers, "content-type")),
            ("x-amz-target", &target),
        ],
        raw,
        now,
    )
    .unwrap();
    if expected.authorization != header(headers, "authorization") {
        inner.aws_bad_signatures += 1;
        return reply(
            StatusCode::FORBIDDEN,
            json!({ "__type": "InvalidSignatureException" }),
        );
    }
    let action = target.trim_start_matches("secretsmanager.").to_owned();
    inner.aws_calls.push(action.clone());
    let not_found = || {
        reply(
            StatusCode::BAD_REQUEST,
            json!({ "__type": "com.amazonaws#ResourceNotFoundException" }),
        )
    };
    match action.as_str() {
        "ListSecrets" => reply(StatusCode::OK, json!({ "SecretList": [] })),
        "GetSecretValue" => match inner.aws.get(body["SecretId"].as_str().unwrap()) {
            Some(text) => reply(StatusCode::OK, json!({ "SecretString": text })),
            None => not_found(),
        },
        "PutSecretValue" | "CreateSecret" => {
            let name = body["SecretId"]
                .as_str()
                .or(body["Name"].as_str())
                .unwrap()
                .to_owned();
            inner
                .aws
                .insert(name, body["SecretString"].as_str().unwrap().to_owned());
            reply(StatusCode::OK, json!({}))
        }
        _ => not_found(),
    }
}

fn gcp(
    inner: &mut FakeInner,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    raw: &[u8],
    body: &Value,
) -> Response {
    let path = uri.path();
    if path == "/token" {
        let form: BTreeMap<String, String> =
            url::form_urlencoded::parse(raw).into_owned().collect();
        let claims = form["assertion"].split('.').nth(1).unwrap().to_owned();
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(claims)
            .unwrap();
        inner
            .gcp_assertions
            .push(serde_json::from_slice(&claims).unwrap());
        return reply(
            StatusCode::OK,
            json!({ "access_token": "ya29-test", "expires_in": 3600 }),
        );
    }
    if header(headers, "authorization") != "Bearer ya29-test" {
        return reply(StatusCode::UNAUTHORIZED, json!({}));
    }
    let Some(rest) = path.strip_prefix("/v1/projects/proj-1/secrets") else {
        return reply(StatusCode::NOT_FOUND, json!({}));
    };
    match (method.as_str(), rest) {
        ("GET", "") => reply(StatusCode::OK, json!({ "secrets": [] })),
        ("POST", "") => {
            let id = uri
                .query()
                .unwrap()
                .trim_start_matches("secretId=")
                .to_owned();
            inner.gcp.entry(id).or_default();
            reply(StatusCode::OK, json!({}))
        }
        ("GET", r) if r.ends_with("/versions/latest:access") => {
            let id = r.trim_start_matches('/').split('/').next().unwrap();
            match inner.gcp.get(id).and_then(|versions| versions.last()) {
                Some(value) => reply(
                    StatusCode::OK,
                    json!({ "payload": { "data": b64().encode(value) } }),
                ),
                None => reply(StatusCode::NOT_FOUND, json!({})),
            }
        }
        ("POST", r) if r.ends_with(":addVersion") => {
            let id = r.trim_start_matches('/').trim_end_matches(":addVersion");
            let data = b64()
                .decode(body["payload"]["data"].as_str().unwrap())
                .unwrap();
            match inner.gcp.get_mut(id) {
                Some(versions) => {
                    versions.push(String::from_utf8(data).unwrap());
                    reply(StatusCode::OK, json!({}))
                }
                None => reply(StatusCode::NOT_FOUND, json!({})),
            }
        }
        _ => reply(StatusCode::NOT_FOUND, json!({})),
    }
}

async fn handle(
    State(fake): State<Fake>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let body: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    let mut inner = fake.0.lock().unwrap();
    let path = uri.path().to_owned();
    if path.starts_with("/repos/") {
        return github(&mut inner, &method, &path, &headers, &body);
    }
    if path.starts_with("/v9/projects/") || path.starts_with("/v10/projects/") {
        if header(&headers, "authorization") != "Bearer vc-1" {
            return reply(StatusCode::FORBIDDEN, json!({}));
        }
        if method == Method::POST {
            let (failed, created): (Vec<Value>, Vec<Value>) = body
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .partition(|entry| {
                    inner
                        .vercel_reject
                        .iter()
                        .any(|key| entry["key"] == key.as_str())
                });
            inner
                .vercel
                .push((uri.query().unwrap_or_default().to_owned(), body));
            if !failed.is_empty() {
                let failed: Vec<Value> = failed
                    .iter()
                    .map(|entry| {
                        json!({ "error": {
                        "code": "ENV_CONFLICT",
                        "message": format!("conflict for {}", entry["value"]),
                        "key": entry["key"],
                    } })
                    })
                    .collect();
                return reply(
                    StatusCode::CREATED,
                    json!({ "created": created, "failed": failed }),
                );
            }
        }
        return reply(StatusCode::OK, json!({}));
    }
    if path == "/" && method == Method::POST {
        return aws(&mut inner, &headers, &raw, &body);
    }
    gcp(&mut inner, &method, &uri, &headers, &raw, &body)
}

pub(super) async fn serve(fake: Fake) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new().fallback(handle).with_state(fake);
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    format!("http://{addr}")
}

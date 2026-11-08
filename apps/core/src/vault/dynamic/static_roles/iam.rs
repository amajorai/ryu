//! AWS IAM calls for the `aws-iam` provider (SigV4-signed query API).

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

const IAM_HOST: &str = "iam.amazonaws.com";
const IAM_REGION: &str = "us-east-1";

pub(super) fn iam_sign(
    access_key_id: &str,
    secret: &str,
    body: &str,
    amz_date: &str,
) -> Vec<(String, String)> {
    use hmac::{Hmac, Mac};
    let date = &amz_date[..8];
    let body_hash = hex::encode(Sha256::digest(body.as_bytes()));
    let content_type = "application/x-www-form-urlencoded; charset=utf-8";
    let canonical_headers =
        format!("content-type:{content_type}\nhost:{IAM_HOST}\nx-amz-date:{amz_date}\n");
    let signed_headers = "content-type;host;x-amz-date";
    let canonical_request =
        format!("POST\n/\n\n{canonical_headers}\n{signed_headers}\n{body_hash}");
    let scope = format!("{date}/{IAM_REGION}/iam/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let key = super::super::aws::signing_key(secret, date, IAM_REGION, "iam");
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).expect("hmac accepts any key length");
    mac.update(string_to_sign.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());
    vec![
        ("content-type".into(), content_type.into()),
        ("x-amz-date".into(), amz_date.into()),
        (
            "authorization".into(),
            format!(
                "AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
            ),
        ),
    ]
}

pub(super) async fn iam_call(
    access_key_id: &str,
    secret: &str,
    params: &[(&str, &str)],
) -> Result<String> {
    let body = {
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        for (key, value) in params {
            form.append_pair(key, value);
        }
        form.append_pair("Version", "2010-05-08");
        form.finish()
    };
    let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let mut request = reqwest::Client::new()
        .post(iam_endpoint())
        .timeout(std::time::Duration::from_secs(15))
        .body(body.clone());
    for (name, value) in iam_sign(access_key_id, secret, &body, &amz_date) {
        request = request.header(name, value);
    }
    let response = request.send().await.context("calling AWS IAM")?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let code = xml_text(&text, "Code").unwrap_or("unknown");
        bail!("AWS IAM returned {status} ({code})");
    }
    Ok(text)
}

#[cfg(test)]
thread_local! {
    /// Test-only IAM endpoint (a local fake). Tokio tests run on one thread.
    pub(super) static IAM_ENDPOINT: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

fn iam_endpoint() -> String {
    #[cfg(test)]
    if let Some(endpoint) = IAM_ENDPOINT.with(|cell| cell.borrow().clone()) {
        return endpoint;
    }
    format!("https://{IAM_HOST}/")
}

/// Delete `ids` from the IAM user. Returns the ids still live (deletion
/// failed) and a warning describing the failures. A key AWS no longer knows
/// (`NoSuchEntity`) counts as deleted.
pub(super) async fn iam_delete_access_keys(
    access_key_id: &str,
    secret: &str,
    user_name: &str,
    ids: Vec<String>,
) -> (Vec<String>, Option<String>) {
    let mut kept = Vec::new();
    let mut errors = Vec::new();
    for id in ids {
        if kept.contains(&id) {
            continue;
        }
        let result = iam_call(
            access_key_id,
            secret,
            &[
                ("Action", "DeleteAccessKey"),
                ("UserName", user_name),
                ("AccessKeyId", &id),
            ],
        )
        .await;
        match result {
            Ok(_) => {}
            Err(error) if error.to_string().contains("(NoSuchEntity)") => {}
            Err(error) => {
                errors.push(format!("{id}: {error}"));
                kept.push(id);
            }
        }
    }
    let warning = (!errors.is_empty()).then(|| {
        format!(
            "previous access key(s) not deleted yet; retried on the next rotation: {}",
            errors.join("; ")
        )
    });
    (kept, warning)
}

pub(super) fn xml_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim())
}

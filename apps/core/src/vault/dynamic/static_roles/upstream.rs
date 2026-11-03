//! Upstream calls for static roles: AWS IAM (SigV4-signed) key rotation and
//! applying a new password at Postgres, Redis or a webhook, reached through
//! the role's [`TargetEgress`](crate::vault::dynamic::target_guard::TargetEgress).
//!
//! test-exempt: moved out of `static_roles.rs` to keep it within the size limits; covered by
//! `static_roles/tests.rs` (including SigV4 signing and the fake IAM endpoint).

use super::*;

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
    let key = crate::vault::dynamic::aws::signing_key(secret, date, IAM_REGION, "iam");
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

pub(super) fn iam_endpoint() -> String {
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

/// Apply a password upstream. Returns the value to store (the webhook may
/// supply its own).
pub(super) async fn apply_password(
    provider: &StaticProvider,
    role: &str,
    password: &str,
    egress: TargetEgress,
) -> Result<String> {
    match provider {
        StaticProvider::Postgres {
            connection_url,
            username,
            rotation_statements,
        } => {
            let config = PostgresConfig {
                connection_url: connection_url.clone(),
                creation_statements: Vec::new(),
                revocation_statements: Vec::new(),
                username_prefix: None,
                egress,
            };
            let statements: Vec<String> = if rotation_statements.is_empty() {
                vec![DEFAULT_PG_ROTATION.to_owned()]
            } else {
                rotation_statements.clone()
            }
            .iter()
            .map(|statement| postgres::render(statement, username, password, ""))
            .collect();
            let client = postgres::connect(&config).await?;
            postgres::run(&client, &statements).await?;
            Ok(password.to_owned())
        }
        StaticProvider::Redis {
            connection_url,
            username,
        } => {
            redis::rotate_password(connection_url, username, password, egress).await?;
            Ok(password.to_owned())
        }
        StaticProvider::Webhook {
            url,
            signing_secret,
            username,
        } => {
            let config = WebhookConfig {
                url: url.clone(),
                signing_secret: signing_secret.clone(),
                egress,
            };
            let answer = webhook::call(
                &config,
                json!({ "action": "rotate", "role": role, "username": username, "password": password }),
            )
            .await?;
            Ok(answer
                .get("value")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(password)
                .to_owned())
        }
        StaticProvider::AwsIam { .. } => bail!("aws-iam roles rotate access keys, not passwords"),
    }
}

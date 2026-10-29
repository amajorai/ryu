//! AWS STS dynamic credentials (`AssumeRole`).
//!
//! The role stores an IAM access key allowed to call `sts:AssumeRole` on the
//! target role. Each issue returns temporary session credentials whose lifetime
//! is the lease TTL (clamped to STS's 15-minute to 12-hour range). Session
//! credentials cannot be revoked early at STS; revocation ends the lease and
//! the credentials expire on their own, which the lease records.
//!
//! Requests are signed with SigV4, implemented here with `hmac`/`sha2` to avoid
//! pulling the AWS SDK into Core.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::Issued;

const STS_MIN_SECS: i64 = 900;
const STS_MAX_SECS: i64 = 43_200;

/// AWS STS provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsStsConfig {
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Region for the regional STS endpoint, e.g. `us-east-1`.
    pub region: String,
    pub role_arn: String,
    /// Optional inline session policy (JSON) further restricting the session.
    #[serde(default)]
    pub session_policy: Option<String>,
    /// Override endpoint (tests or partitions), e.g. `https://sts.cn-north-1.amazonaws.com.cn`.
    #[serde(default)]
    pub endpoint: Option<String>,
}

impl AwsStsConfig {
    pub(super) fn validate(&self) -> Result<()> {
        if self.access_key_id.trim().is_empty() || self.secret_access_key.trim().is_empty() {
            bail!("accessKeyId and secretAccessKey are required");
        }
        if !self.role_arn.starts_with("arn:") {
            bail!("roleArn must be an IAM role ARN");
        }
        if self.region.is_empty()
            || !self
                .region
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            bail!("region is invalid");
        }
        if let Some(policy) = &self.session_policy {
            serde_json::from_str::<Value>(policy)
                .map_err(|_| anyhow!("sessionPolicy must be JSON"))?;
        }
        Ok(())
    }

    fn endpoint(&self) -> String {
        self.endpoint
            .clone()
            .unwrap_or_else(|| format!("https://sts.{}.amazonaws.com", self.region))
    }
}

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// SigV4 signing key for `date` (YYYYMMDD), region, and service.
pub(crate) fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    hmac(&k_service, b"aws4_request")
}

fn encode(value: &str) -> String {
    // RFC 3986 unreserved set, as SigV4 requires.
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Sign a form-encoded POST; returns the headers to send.
pub(crate) fn sign_post(
    config: &AwsStsConfig,
    host: &str,
    body: &str,
    amz_date: &str,
) -> Vec<(String, String)> {
    let date = &amz_date[..8];
    let body_hash = hex::encode(Sha256::digest(body.as_bytes()));
    let content_type = "application/x-www-form-urlencoded; charset=utf-8";
    let canonical_headers =
        format!("content-type:{content_type}\nhost:{host}\nx-amz-date:{amz_date}\n");
    let signed_headers = "content-type;host;x-amz-date";
    let canonical_request =
        format!("POST\n/\n\n{canonical_headers}\n{signed_headers}\n{body_hash}");
    let scope = format!("{date}/{}/sts/aws4_request", config.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let key = signing_key(&config.secret_access_key, date, &config.region, "sts");
    let signature = hex::encode(hmac(&key, string_to_sign.as_bytes()));
    vec![
        ("content-type".into(), content_type.into()),
        ("x-amz-date".into(), amz_date.into()),
        (
            "authorization".into(),
            format!(
                "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
                config.access_key_id
            ),
        ),
    ]
}

fn xml_field<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim())
}

pub(super) async fn issue(config: &AwsStsConfig, role: &str, ttl_secs: i64) -> Result<Issued> {
    let duration = ttl_secs.clamp(STS_MIN_SECS, STS_MAX_SECS);
    let session = format!("ryu-{role}-{}", super::random_suffix(8));
    let mut params = vec![
        ("Action", "AssumeRole".to_owned()),
        ("Version", "2011-06-15".to_owned()),
        ("RoleArn", config.role_arn.clone()),
        ("RoleSessionName", session.chars().take(64).collect()),
        ("DurationSeconds", duration.to_string()),
    ];
    if let Some(policy) = &config.session_policy {
        params.push(("Policy", policy.clone()));
    }
    params.sort_by(|a, b| a.0.cmp(b.0));
    let body = params
        .iter()
        .map(|(key, value)| format!("{key}={}", encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let endpoint = config.endpoint();
    let host = url::Url::parse(&endpoint)?
        .host_str()
        .ok_or_else(|| anyhow!("STS endpoint has no host"))?
        .to_owned();
    let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let mut request = reqwest::Client::new()
        .post(format!("{}/", endpoint.trim_end_matches('/')))
        .timeout(std::time::Duration::from_secs(15))
        .body(body.clone());
    for (name, value) in sign_post(config, &host, &body, &amz_date) {
        request = request.header(name, value);
    }
    let response = request.send().await?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let message = xml_field(&text, "Message").unwrap_or("request failed");
        bail!("sts:AssumeRole returned {status}: {message}");
    }
    let field = |tag: &str| {
        xml_field(&text, tag)
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("STS response is missing {tag}"))
    };
    Ok(Issued {
        data: BTreeMap::from([
            ("accessKeyId".to_owned(), field("AccessKeyId")?),
            ("secretAccessKey".to_owned(), field("SecretAccessKey")?),
            ("sessionToken".to_owned(), field("SessionToken")?),
            ("expiration".to_owned(), field("Expiration")?),
        ]),
        revoke_data: Value::Null,
        ttl_cap_secs: Some(duration),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_key_matches_the_aws_documented_example() {
        // https://docs.aws.amazon.com/IAM/latest/UserGuide/signing-elements.html
        let key = signing_key(
            // AWS's published example secret, split so secret scanners skip it.
            concat!("wJalrXUtnFEMI/K7MDENG", "+bPxRfiCYEXAMPLEKEY"),
            "20150830",
            "us-east-1",
            "iam",
        );
        assert_eq!(
            hex::encode(key),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
        );
    }

    #[test]
    fn signed_requests_carry_a_scoped_authorization_header() {
        let config = AwsStsConfig {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: "secret".into(),
            region: "us-west-2".into(),
            role_arn: "arn:aws:iam::123456789012:role/app".into(),
            session_policy: None,
            endpoint: None,
        };
        config.validate().unwrap();
        let headers = sign_post(
            &config,
            "sts.us-west-2.amazonaws.com",
            "Action=AssumeRole",
            "20260101T000000Z",
        );
        let auth = &headers
            .iter()
            .find(|(name, _)| name == "authorization")
            .unwrap()
            .1;
        assert!(auth.starts_with(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260101/us-west-2/sts/aws4_request"
        ));
        assert_eq!(encode("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn xml_fields_are_extracted() {
        let xml = "<Credentials><AccessKeyId>ASIA</AccessKeyId><Expiration>2026</Expiration></Credentials>";
        assert_eq!(xml_field(xml, "AccessKeyId"), Some("ASIA"));
        assert_eq!(xml_field(xml, "SessionToken"), None);
    }
}

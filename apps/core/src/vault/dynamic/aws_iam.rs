//! AWS IAM user dynamic credentials.
//!
//! Each lease is a fresh IAM user with an access key. The user gets the
//! role's managed policies (`policyArns`), an optional inline policy
//! (`policyDocument`), and group memberships (`iamGroups`), plus an optional
//! permissions boundary. Revocation deletes the access key, detaches and
//! deletes the policies, leaves the groups, and deletes the user, so the key
//! stops working at once. IAM users have no expiry of their own, so leases
//! renew as bookkeeping.
//!
//! The admin key needs `iam:CreateUser`, `iam:DeleteUser`,
//! `iam:CreateAccessKey`, `iam:DeleteAccessKey`, the attach/detach and
//! put/delete user-policy actions it uses, and group membership changes.
//! Requests are SigV4-signed with [`super::aws::SigV4`].

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::aws::{xml_field, SigV4};
use super::http;
use super::naming;
use super::target_guard::{self, TargetEgress};
use super::Issued;

const IAM_ENDPOINT: &str = "https://iam.amazonaws.com";
const IAM_REGION: &str = "us-east-1";
const IAM_VERSION: &str = "2010-05-08";
const INLINE_POLICY_NAME: &str = "ryu-inline";
const DEFAULT_PATH: &str = "/ryu/";
const MAX_POLICIES: usize = 20;

/// AWS IAM user provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsIamUserConfig {
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Managed policies attached to each user.
    #[serde(default)]
    pub policy_arns: Vec<String>,
    /// Inline policy (JSON) put on each user.
    #[serde(default)]
    pub policy_document: Option<String>,
    /// Groups each user joins.
    #[serde(default)]
    pub iam_groups: Vec<String>,
    #[serde(default)]
    pub permissions_boundary_arn: Option<String>,
    /// IAM path for generated users (default `/ryu/`).
    #[serde(default)]
    pub user_path: Option<String>,
    /// Generated user prefix (default `ryu`; `_` becomes `-`).
    #[serde(default)]
    pub username_prefix: Option<String>,
    /// Override endpoint (tests or partitions), e.g. `https://iam.amazonaws.com.cn`.
    #[serde(default)]
    pub endpoint: Option<String>,
    /// Signing region (default `us-east-1`; `cn-north-1` for the China partition).
    #[serde(default)]
    pub region: Option<String>,
    /// How connections are made (set from the role's writer; never stored).
    #[serde(skip)]
    pub(crate) egress: TargetEgress,
}

fn is_iam_name(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'+' | b'=' | b',' | b'.' | b'@' | b'_' | b'-')
        })
}

fn is_arn(value: &str) -> bool {
    value.starts_with("arn:") && value.len() <= 2048 && value.bytes().all(|b| b.is_ascii_graphic())
}

impl AwsIamUserConfig {
    pub(super) fn validate(&self) -> Result<()> {
        if self.access_key_id.trim().is_empty() || self.secret_access_key.trim().is_empty() {
            bail!("accessKeyId and secretAccessKey are required");
        }
        if self.policy_arns.is_empty()
            && self.policy_document.is_none()
            && self.iam_groups.is_empty()
        {
            bail!("set at least one of policyArns, policyDocument, and iamGroups");
        }
        if self.policy_arns.len() > MAX_POLICIES || self.iam_groups.len() > MAX_POLICIES {
            bail!("at most {MAX_POLICIES} policyArns and {MAX_POLICIES} iamGroups");
        }
        if let Some(bad) = self.policy_arns.iter().find(|arn| !is_arn(arn)) {
            bail!("policyArns entry `{bad}` is not an ARN");
        }
        if let Some(bad) = self.iam_groups.iter().find(|name| !is_iam_name(name, 128)) {
            bail!("iamGroups entry `{bad}` is not an IAM group name");
        }
        if let Some(policy) = &self.policy_document {
            serde_json::from_str::<Value>(policy)
                .map_err(|_| anyhow!("policyDocument must be JSON"))?;
        }
        if self
            .permissions_boundary_arn
            .as_deref()
            .is_some_and(|arn| !is_arn(arn))
        {
            bail!("permissionsBoundaryArn is not an ARN");
        }
        let path = self.path();
        if !path.starts_with('/')
            || !path.ends_with('/')
            || path.len() > 512
            || !path.bytes().all(|b| b.is_ascii_graphic())
        {
            bail!("userPath must start and end with `/`");
        }
        if let Some(region) = &self.region {
            if region.is_empty()
                || !region
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            {
                bail!("region is invalid");
            }
        }
        if let Some(endpoint) = &self.endpoint {
            http::check_https(endpoint, "endpoint")?;
        }
        naming::validate_prefix(self.username_prefix.as_deref())
    }

    /// Non-secret summary for listings.
    pub(super) fn summary(&self) -> Value {
        json!({
            "policyArns": self.policy_arns,
            "inlinePolicy": self.policy_document.is_some(),
            "iamGroups": self.iam_groups,
            "userPath": self.path(),
        })
    }

    fn path(&self) -> &str {
        self.user_path.as_deref().unwrap_or(DEFAULT_PATH)
    }

    fn endpoint(&self) -> String {
        self.endpoint
            .as_deref()
            .unwrap_or(IAM_ENDPOINT)
            .trim()
            .trim_end_matches('/')
            .to_owned()
    }

    /// One IAM query-API call. `NoSuchEntity` is success when `missing_ok`.
    async fn call(&self, params: &[(&str, &str)], missing_ok: bool) -> Result<String> {
        let action = params
            .iter()
            .find(|(key, _)| *key == "Action")
            .map_or("call", |(_, value)| *value);
        let body = {
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            for (key, value) in params {
                form.append_pair(key, value);
            }
            form.append_pair("Version", IAM_VERSION);
            form.finish()
        };
        let endpoint = self.endpoint();
        let parsed = url::Url::parse(&endpoint)?;
        let host = parsed
            .host_str()
            .ok_or_else(|| anyhow!("IAM endpoint has no host"))?;
        // The signed host header carries a non-default port, as sent.
        let host = match parsed.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        };
        let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let signer = SigV4 {
            access_key_id: &self.access_key_id,
            secret_access_key: &self.secret_access_key,
            region: self.region.as_deref().unwrap_or(IAM_REGION),
            service: "iam",
        };
        let headers = signer.sign_form_post(&host, &body, &amz_date);
        let (status, text) = target_guard::post(
            &format!("{endpoint}/"),
            headers,
            body.into_bytes(),
            self.egress,
        )
        .await?;
        let text = String::from_utf8_lossy(&text).into_owned();
        if (200..300).contains(&status) {
            return Ok(text);
        }
        let code = xml_field(&text, "Code").unwrap_or("unknown");
        if missing_ok && code == "NoSuchEntity" {
            return Ok(String::new());
        }
        let message: String = xml_field(&text, "Message")
            .unwrap_or("request failed")
            .chars()
            .take(300)
            .collect();
        bail!("iam:{action} returned {status} ({code}): {message}")
    }
}

/// What revocation removes, recorded at issue so later role edits cannot
/// leave a user behind.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    user_name: String,
    #[serde(default)]
    access_key_id: Option<String>,
    #[serde(default)]
    policy_arns: Vec<String>,
    #[serde(default)]
    inline_policy: bool,
    #[serde(default)]
    iam_groups: Vec<String>,
}

async fn create(config: &AwsIamUserConfig, created: &mut Created) -> Result<(String, String)> {
    let user = created.user_name.clone();
    let mut params = vec![
        ("Action", "CreateUser"),
        ("UserName", user.as_str()),
        ("Path", config.path()),
        ("Tags.member.1.Key", "managed-by"),
        ("Tags.member.1.Value", "ryu"),
    ];
    if let Some(boundary) = &config.permissions_boundary_arn {
        params.push(("PermissionsBoundary", boundary));
    }
    config.call(&params, false).await?;
    for arn in &config.policy_arns {
        config
            .call(
                &[
                    ("Action", "AttachUserPolicy"),
                    ("UserName", &user),
                    ("PolicyArn", arn),
                ],
                false,
            )
            .await?;
        created.policy_arns.push(arn.clone());
    }
    if let Some(document) = &config.policy_document {
        created.inline_policy = true;
        config
            .call(
                &[
                    ("Action", "PutUserPolicy"),
                    ("UserName", &user),
                    ("PolicyName", INLINE_POLICY_NAME),
                    ("PolicyDocument", document),
                ],
                false,
            )
            .await?;
    }
    for group in &config.iam_groups {
        config
            .call(
                &[
                    ("Action", "AddUserToGroup"),
                    ("UserName", &user),
                    ("GroupName", group),
                ],
                false,
            )
            .await?;
        created.iam_groups.push(group.clone());
    }
    let answer = config
        .call(&[("Action", "CreateAccessKey"), ("UserName", &user)], false)
        .await?;
    let field = |tag: &str| {
        xml_field(&answer, tag)
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("CreateAccessKey response is missing {tag}"))
    };
    let id = field("AccessKeyId")?;
    created.access_key_id = Some(id.clone());
    Ok((id, field("SecretAccessKey")?))
}

/// Remove everything [`create`] made, in reverse. Missing pieces count as
/// removed, so a retried revocation finishes the job.
async fn remove(config: &AwsIamUserConfig, created: &Created) -> Result<()> {
    let user = created.user_name.as_str();
    if let Some(id) = &created.access_key_id {
        config
            .call(
                &[
                    ("Action", "DeleteAccessKey"),
                    ("UserName", user),
                    ("AccessKeyId", id),
                ],
                true,
            )
            .await?;
    }
    for group in &created.iam_groups {
        config
            .call(
                &[
                    ("Action", "RemoveUserFromGroup"),
                    ("UserName", user),
                    ("GroupName", group),
                ],
                true,
            )
            .await?;
    }
    if created.inline_policy {
        config
            .call(
                &[
                    ("Action", "DeleteUserPolicy"),
                    ("UserName", user),
                    ("PolicyName", INLINE_POLICY_NAME),
                ],
                true,
            )
            .await?;
    }
    for arn in &created.policy_arns {
        config
            .call(
                &[
                    ("Action", "DetachUserPolicy"),
                    ("UserName", user),
                    ("PolicyArn", arn),
                ],
                true,
            )
            .await?;
    }
    config
        .call(&[("Action", "DeleteUser"), ("UserName", user)], true)
        .await?;
    Ok(())
}

pub(super) async fn issue(config: &AwsIamUserConfig, role: &str) -> Result<Issued> {
    let prefix = config
        .username_prefix
        .as_deref()
        .unwrap_or("ryu")
        .replace('_', "-");
    let mut created = Created {
        user_name: naming::generated_name(&prefix, role, '-', 64),
        ..Created::default()
    };
    let (access_key_id, secret_access_key) = match create(config, &mut created).await {
        Ok(key) => key,
        Err(error) => {
            // Without a lease nothing would ever delete a half-made user.
            let user = created.user_name.clone();
            return Err(match remove(config, &created).await {
                Ok(()) => anyhow!("{error:#} (IAM user `{user}`; cleanup ran)"),
                Err(cleanup) => {
                    anyhow!("{error:#} (IAM user `{user}`; cleanup failed: {cleanup:#})")
                }
            });
        }
    };
    Ok(Issued {
        data: BTreeMap::from([
            ("accessKeyId".to_owned(), access_key_id),
            ("secretAccessKey".to_owned(), secret_access_key),
            ("userName".to_owned(), created.user_name.clone()),
        ]),
        revoke_data: serde_json::to_value(&created)?,
        ttl_cap_secs: None,
    })
}

pub(super) async fn revoke(config: &AwsIamUserConfig, revoke_data: &Value) -> Result<()> {
    let created: Created = serde_json::from_value(revoke_data.clone())
        .map_err(|_| anyhow!("lease IAM user record is malformed"))?;
    if !naming::is_generated_name(&created.user_name, b'-')
        || created
            .access_key_id
            .as_deref()
            .is_some_and(|id| !id.bytes().all(|b| b.is_ascii_alphanumeric()))
        || created.policy_arns.iter().any(|arn| !is_arn(arn))
        || created.iam_groups.iter().any(|g| !is_iam_name(g, 128))
    {
        bail!("lease IAM user record is malformed");
    }
    remove(config, &created).await
}

#[cfg(test)]
#[path = "aws_iam_test.rs"]
mod tests;

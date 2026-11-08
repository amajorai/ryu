//! Secret-sync targets: push-only destinations on deployment platforms.
//!
//! A target is an external store whose kind only accepts destinations:
//!
//! * **GitHub Actions** (`github-actions`): repository secrets, or one
//!   deployment environment's secrets. Each value is sealed to the
//!   repository's public key (libsodium sealed box) before it leaves Core.
//! * **Vercel** (`vercel`): project environment variables of type
//!   `encrypted`, upserted for the configured targets in one call.
//! * **AWS Secrets Manager** (`aws-secrets-manager`): one secret holds the
//!   whole folder as a JSON object (the console's key/value form). Requests
//!   are SigV4-signed with an access key.
//! * **Google Cloud Secret Manager** (`gcp-secret-manager`): one secret per
//!   key, with a new version only when the value changed. Auth is a
//!   service-account key (exchanged for an access token) or a raw token.
//!
//! GitHub, Vercel and Google Cloud are flat key spaces: a destination's
//! `remotePath` is an optional name prefix (`APP_` pushes `KEY` as
//! `APP_KEY`), and pushes upsert only, so a key deleted in Ryu stays on the
//! platform. AWS replaces its one secret as a whole, except that an empty
//! folder never wipes a non-empty secret. Every name is checked before the
//! first write, so one invalid key fails the push without a partial upload.
//!
//! All HTTP goes through [`super::net`]. No value, credential or response
//! body is logged or returned; errors carry the operation and status only.

pub mod aws;
pub mod gcp;
pub mod github;
pub mod vercel;

#[cfg(test)]
mod fake;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};

use super::{net, StoreCredentials, StoreKind, StoreRecord, TargetOptions};

/// Longest destination name prefix.
const MAX_PREFIX_LEN: usize = 64;
const VERCEL_TARGETS: [&str; 3] = ["production", "preview", "development"];

fn is_identifier(text: &str, extra: &[u8]) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || extra.contains(&b))
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

/// Keep and validate only the options `kind` uses.
pub fn prepare_options(kind: StoreKind, options: TargetOptions) -> Result<TargetOptions> {
    match kind {
        StoreKind::GithubActions => {
            let repository = trimmed(options.repository)
                .ok_or_else(|| anyhow!("GitHub targets need `repository` (owner/repo)"))?;
            let valid = repository.len() <= 200
                && matches!(repository.split_once('/'), Some((owner, repo))
                    if is_identifier(owner, b"-.") && is_identifier(repo, b"-."));
            if !valid {
                bail!("`repository` must be `owner/repo`");
            }
            let github_environment = trimmed(options.github_environment);
            if github_environment
                .as_deref()
                .is_some_and(|env| env.len() > 255 || !is_identifier(env, b"-."))
            {
                bail!("`githubEnvironment` is invalid");
            }
            Ok(TargetOptions {
                repository: Some(repository),
                github_environment,
                ..TargetOptions::default()
            })
        }
        StoreKind::Vercel => {
            let team_id = trimmed(options.team_id);
            if team_id
                .as_deref()
                .is_some_and(|team| team.len() > 64 || !is_identifier(team, b"-"))
            {
                bail!("`teamId` is invalid");
            }
            let mut vercel_targets = Vec::new();
            for target in &options.vercel_targets {
                let target = target.trim();
                if !VERCEL_TARGETS.contains(&target) {
                    bail!("`vercelTargets` entries must be production, preview or development");
                }
                if !vercel_targets.iter().any(|t| t == target) {
                    vercel_targets.push(target.to_owned());
                }
            }
            if vercel_targets.is_empty() {
                vercel_targets = VERCEL_TARGETS.map(str::to_owned).to_vec();
            }
            Ok(TargetOptions {
                team_id,
                vercel_targets,
                ..TargetOptions::default()
            })
        }
        StoreKind::AwsSecretsManager => {
            let region =
                trimmed(options.region).ok_or_else(|| anyhow!("AWS targets need `region`"))?;
            let valid = region.len() <= 32
                && region.contains('-')
                && region
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            if !valid {
                bail!("`region` is invalid");
            }
            Ok(TargetOptions {
                region: Some(region),
                ..TargetOptions::default()
            })
        }
        _ => Ok(TargetOptions::default()),
    }
}

/// The public API address for `kind` when the store gives none.
pub fn default_address(kind: StoreKind, options: &TargetOptions) -> String {
    match kind {
        StoreKind::GithubActions => "https://api.github.com".to_owned(),
        StoreKind::Vercel => "https://api.vercel.com".to_owned(),
        StoreKind::AwsSecretsManager => format!(
            "https://secretsmanager.{}.amazonaws.com",
            options.region.as_deref().unwrap_or_default()
        ),
        _ => "https://secretmanager.googleapis.com".to_owned(),
    }
}

/// Vercel and Google Cloud need a project; GitHub and AWS take none.
pub fn check_project(kind: StoreKind, project_id: &str) -> Result<()> {
    let needs = matches!(kind, StoreKind::Vercel | StoreKind::GcpSecretManager);
    if needs && (project_id.len() > 128 || !is_identifier(project_id, b"-.")) {
        bail!("{} stores need a valid `projectId`", kind.as_str());
    }
    if !needs && !project_id.is_empty() {
        bail!("{} stores take no `projectId`", kind.as_str());
    }
    Ok(())
}

/// Validate a destination's `remotePath` for `store`.
pub fn check_remote_path(store: &StoreRecord, remote_path: &str) -> Result<()> {
    match store.kind {
        StoreKind::AwsSecretsManager => {
            if aws::secret_name(store, remote_path).is_empty() {
                bail!("an AWS destination needs a `remotePath` (the secret name)");
            }
            Ok(())
        }
        kind => {
            let extra: &[u8] = if kind == StoreKind::GcpSecretManager {
                b"-"
            } else {
                b""
            };
            let valid = remote_path.is_empty()
                || (remote_path.len() <= MAX_PREFIX_LEN
                    && !remote_path.as_bytes()[0].is_ascii_digit()
                    && is_identifier(remote_path, extra));
            if !valid {
                bail!(
                    "{} destinations take an optional name prefix (`APP_`) as `remotePath`",
                    kind.as_str()
                );
            }
            Ok(())
        }
    }
}

/// `prefix` + `key` for a flat target.
fn prefixed(prefix: &str, values: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    values
        .iter()
        .map(|(key, value)| (format!("{prefix}{key}"), value.clone()))
        .collect()
}

/// `base` with `segments` appended (each percent-encoded).
fn endpoint(base: &url::Url, segments: &[&str]) -> Result<url::Url> {
    let mut url = base.clone();
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|()| anyhow!("store address cannot carry a path"))?;
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
    }
    Ok(url)
}

fn status_error(what: &str, status: reqwest::StatusCode) -> anyhow::Error {
    anyhow!("{what} failed with HTTP {}", status.as_u16())
}

/// The store's address and a guarded client for it.
async fn connect(store: &StoreRecord) -> Result<(url::Url, reqwest::Client)> {
    let base = net::validate_address(&store.address, net::Egress::from_env())?;
    let http = net::guarded_client(&base, net::Egress::from_env()).await?;
    Ok((base, http))
}

fn token(credentials: &StoreCredentials) -> Result<&str> {
    credentials
        .token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| anyhow!("the store has no token"))
}

/// Prove the target's credentials work without writing anything.
pub async fn check(store: &StoreRecord, credentials: &StoreCredentials) -> Result<()> {
    match store.kind {
        StoreKind::GithubActions => github::check(store, credentials).await,
        StoreKind::Vercel => vercel::check(store, credentials).await,
        StoreKind::AwsSecretsManager => aws::check(store, credentials).await,
        StoreKind::GcpSecretManager => gcp::check(store, credentials).await,
        kind => bail!("{} is not a secret-sync target", kind.as_str()),
    }
}

/// Push `values` to `remote_path`. Returns how many keys were pushed.
pub async fn push(
    store: &StoreRecord,
    credentials: &StoreCredentials,
    remote_path: &str,
    values: &BTreeMap<String, String>,
) -> Result<usize> {
    check_remote_path(store, remote_path)?;
    match store.kind {
        StoreKind::GithubActions => {
            github::push(store, credentials, &prefixed(remote_path, values)).await
        }
        StoreKind::Vercel => vercel::push(store, credentials, &prefixed(remote_path, values)).await,
        StoreKind::AwsSecretsManager => aws::push(store, credentials, remote_path, values).await,
        StoreKind::GcpSecretManager => {
            gcp::push(store, credentials, &prefixed(remote_path, values)).await
        }
        kind => bail!("{} is not a secret-sync target", kind.as_str()),
    }
}

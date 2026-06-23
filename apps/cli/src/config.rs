use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};

use crate::auth;

/// Config-as-code / GitOps client (U31).
///
/// `ryu apply -f gateway.yaml` validates and applies a scope's policy config to
/// the control plane; `ryu diff -f gateway.yaml` previews the change; `ryu
/// config revisions` lists history; `ryu config rollback <rev>` reverts. All of
/// these hit the same control-plane store the dashboard UI writes to, so a
/// config applied here is visible (and rollback-able) in the UI and vice versa.

const CONTROL_PLANE_BASE: &str = "/api/control-plane/orgs";

/// Parses `-f <path>` / `--file <path>` and `--org <id>` from a flat arg list.
struct ConfigArgs {
    file: Option<String>,
    org: Option<String>,
    rest: Vec<String>,
}

fn parse_config_args(args: &[String]) -> ConfigArgs {
    let mut file = None;
    let mut org = std::env::var("RYU_ORG").ok();
    let mut rest = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-f" | "--file" => {
                file = args.get(i + 1).cloned();
                i += 2;
            }
            "--org" => {
                org = args.get(i + 1).cloned();
                i += 2;
            }
            other => {
                rest.push(other.to_owned());
                i += 1;
            }
        }
    }
    ConfigArgs { file, org, rest }
}

/// Reads a YAML config file and converts it to the JSON body the control-plane
/// apply/diff endpoints accept. Validation of the policy shape happens
/// server-side so the CLI and UI share one validator.
fn read_config_file(path: &str) -> Result<serde_json::Value> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read config file '{path}'"))?;
    let value: serde_yaml::Value =
        serde_yaml::from_str(&text).with_context(|| format!("invalid YAML in '{path}'"))?;
    // serde_yaml::Value -> serde_json::Value keeps the structure intact.
    let json = serde_json::to_value(value).context("failed to convert YAML to JSON")?;
    Ok(json)
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn check(resp: reqwest::Response) -> Result<serde_json::Value> {
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    if !status.is_success() {
        let message = body
            .get("message")
            .or_else(|| body.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("request failed");
        bail!("{message} (HTTP {status})");
    }
    Ok(body)
}

fn require_org(org: Option<String>) -> Result<String> {
    org.ok_or_else(|| {
        anyhow!(
            "missing org — pass --org <id> or set RYU_ORG (find your org id in the dashboard or via GET /api/control-plane/orgs)"
        )
    })
}

/// Pretty-prints a diff plan returned by the control plane.
fn print_diff(diff: &serde_json::Value) {
    let changes = diff.get("changes").and_then(|v| v.as_array());
    let clean = diff.get("clean").and_then(|v| v.as_bool()).unwrap_or(false);
    if clean || changes.map(|c| c.is_empty()).unwrap_or(true) {
        println!("No changes — config matches the control plane.");
        return;
    }

    for change in changes.unwrap_or(&Vec::new()) {
        let action = change.get("action").and_then(|v| v.as_str()).unwrap_or("?");
        let level = change.get("level").and_then(|v| v.as_str()).unwrap_or("?");
        let sym = match action {
            "create" => "+",
            "delete" => "-",
            _ => "~",
        };
        let scope = ["teamId", "projectId", "userId"]
            .iter()
            .filter_map(|k| {
                change
                    .get(*k)
                    .and_then(|v| v.as_str())
                    .map(|v| format!("{}={v}", k.trim_end_matches("Id")))
            })
            .collect::<Vec<_>>()
            .join(" ");
        let scope_suffix = if scope.is_empty() { String::new() } else { format!(" ({scope})") };
        println!("  {sym} {action:<6} {level}{scope_suffix}");
    }
}

/// `ryu apply -f gateway.yaml [--org id]`
pub async fn run_apply(args: &[String]) -> Result<()> {
    let parsed = parse_config_args(args);
    let file = parsed
        .file
        .ok_or_else(|| anyhow!("usage: ryu apply -f <gateway.yaml> [--org <id>]"))?;
    let org = require_org(parsed.org)?;
    let (data, backend) = auth::require_token_and_url()?;
    let body = read_config_file(&file)?;

    let resp = http()
        .post(format!("{backend}{CONTROL_PLANE_BASE}/{org}/config/apply"))
        .header("Authorization", format!("Bearer {}", data.token))
        .json(&body)
        .send()
        .await
        .context("network request failed")?;
    let result = check(resp).await?;

    let revision = result.get("revision").and_then(|v| v.as_u64()).unwrap_or(0);
    let applied = result.get("applied").and_then(|v| v.as_u64()).unwrap_or(0);
    if let Some(diff) = result.get("diff") {
        print_diff(diff);
    }
    println!("Applied {applied} change(s). Now at revision {revision}.");
    Ok(())
}

/// `ryu diff -f gateway.yaml [--org id]`
pub async fn run_diff(args: &[String]) -> Result<()> {
    let parsed = parse_config_args(args);
    let file = parsed
        .file
        .ok_or_else(|| anyhow!("usage: ryu diff -f <gateway.yaml> [--org <id>]"))?;
    let org = require_org(parsed.org)?;
    let (data, backend) = auth::require_token_and_url()?;
    let body = read_config_file(&file)?;

    let resp = http()
        .post(format!("{backend}{CONTROL_PLANE_BASE}/{org}/config/diff"))
        .header("Authorization", format!("Bearer {}", data.token))
        .json(&body)
        .send()
        .await
        .context("network request failed")?;
    let diff = check(resp).await?;
    print_diff(&diff);
    Ok(())
}

/// `ryu config <subcommand>` — revisions / rollback / show.
pub async fn run_config(args: &[String]) -> Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("");
    let rest = if args.is_empty() { &[] } else { &args[1..] };

    match sub {
        "revisions" | "history" => run_revisions(rest).await,
        "rollback" => run_rollback(rest).await,
        "show" => run_show(rest).await,
        other => {
            eprintln!("unknown config subcommand: {other}");
            eprintln!();
            eprintln!("usage: ryu config <subcommand> [--org <id>]");
            eprintln!("  revisions          list applied revisions (newest first)");
            eprintln!("  rollback <rev>     restore a prior revision (new revision)");
            eprintln!("  show               print the org's current config as YAML");
            Ok(())
        }
    }
}

async fn run_revisions(args: &[String]) -> Result<()> {
    let parsed = parse_config_args(args);
    let org = require_org(parsed.org)?;
    let (data, backend) = auth::require_token_and_url()?;

    let resp = http()
        .get(format!("{backend}{CONTROL_PLANE_BASE}/{org}/config/revisions"))
        .header("Authorization", format!("Bearer {}", data.token))
        .send()
        .await
        .context("network request failed")?;
    let body = check(resp).await?;

    let revisions = body.get("revisions").and_then(|v| v.as_array());
    let Some(revisions) = revisions else {
        println!("No revisions yet.");
        return Ok(());
    };
    if revisions.is_empty() {
        println!("No revisions yet.");
        return Ok(());
    }

    println!("{:<6}  {:<10}  {:<8}  {}", "REV", "SOURCE", "POLICIES", "CREATED");
    println!("{}", "-".repeat(48));
    for rev in revisions {
        let revision = rev.get("revision").and_then(|v| v.as_u64()).unwrap_or(0);
        let source = rev.get("source").and_then(|v| v.as_str()).unwrap_or("—");
        let count = rev.get("policyCount").and_then(|v| v.as_u64()).unwrap_or(0);
        let created = rev
            .get("createdAt")
            .and_then(|v| v.as_str())
            .and_then(|s| s.split('T').next())
            .unwrap_or("—");
        let from = rev.get("rolledBackFrom").and_then(|v| v.as_u64());
        let label = match from {
            Some(f) => format!("{source} (←{f})"),
            None => source.to_owned(),
        };
        println!("{revision:<6}  {label:<10}  {count:<8}  {created}");
    }
    Ok(())
}

async fn run_rollback(args: &[String]) -> Result<()> {
    let parsed = parse_config_args(args);
    let org = require_org(parsed.org.clone())?;
    let target: u64 = parsed
        .rest
        .first()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| anyhow!("usage: ryu config rollback <revision> [--org <id>]"))?;
    let (data, backend) = auth::require_token_and_url()?;

    let resp = http()
        .post(format!("{backend}{CONTROL_PLANE_BASE}/{org}/config/rollback"))
        .header("Authorization", format!("Bearer {}", data.token))
        .json(&serde_json::json!({ "revision": target }))
        .send()
        .await
        .context("network request failed")?;
    let body = check(resp).await?;

    let revision = body.get("revision").and_then(|v| v.as_u64()).unwrap_or(0);
    println!("Rolled back to revision {target}. Now at revision {revision}.");
    Ok(())
}

async fn run_show(args: &[String]) -> Result<()> {
    let parsed = parse_config_args(args);
    let org = require_org(parsed.org)?;
    let (data, backend) = auth::require_token_and_url()?;

    let resp = http()
        .get(format!("{backend}{CONTROL_PLANE_BASE}/{org}/config"))
        .header("Authorization", format!("Bearer {}", data.token))
        .send()
        .await
        .context("network request failed")?;
    let body = check(resp).await?;

    // Render the config (policies) as YAML for round-tripping into a file.
    let yaml = serde_yaml::to_string(&body).context("failed to render config as YAML")?;
    print!("{yaml}");
    Ok(())
}

//! OTLP exporter presets for hosted LLM-observability backends.
//!
//! Every preset is a thin, documented mapping onto plain OTLP/HTTP: a traces
//! URL, request headers, and resource attributes. Nothing here opens a socket;
//! Core and Gateway feed the resolved [`ResolvedExport`] into their existing
//! consent-gated OTLP exporter, so a preset can never egress without the user's
//! `diagnostics-export-enabled` opt-in.
//!
//! Credentials are never configured as literal values. Each secret is a
//! [`SecretReference`] (`env:NAME`, `file:/abs/path`, or `secret:NAME` for the
//! Core vault), resolved at exporter build time.
//!
//! Wire shapes follow each vendor's published OTLP ingestion contract:
//!
//! | preset      | traces URL                                   | auth                                     |
//! |-------------|----------------------------------------------|------------------------------------------|
//! | langfuse    | `<host>/api/public/otel/v1/traces`           | `Authorization: Basic b64(pk:sk)`        |
//! | langsmith   | `<host>/otel/v1/traces`                      | `x-api-key`, `Langsmith-Project`         |
//! | braintrust  | `<host>/otel/v1/traces`                      | `Authorization: Bearer`, `x-bt-parent`   |
//! | phoenix     | `<host>/v1/traces`                           | optional `Authorization: Bearer`         |
//! | helicone    | `<host>/v1/trace/log-python`                 | `Authorization: Bearer`                  |
//! | datadog     | `https://otlp.<site>/v1/traces`              | `dd-api-key`, `dd-otlp-source: llmobs`   |
//! | otlp        | `<endpoint>/v1/traces`                       | optional `Authorization: Bearer`         |

use std::collections::BTreeMap;
use std::path::PathBuf;

use base64::Engine as _;

const TRACES_PATH: &str = "/v1/traces";

/// A supported export destination shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExporterPreset {
    /// Any OTLP/HTTP endpoint (Collector, Axiom, Grafana, PostHog, …).
    #[default]
    Otlp,
    /// Langfuse (cloud or self-hosted).
    Langfuse,
    /// LangSmith.
    LangSmith,
    /// Braintrust.
    Braintrust,
    /// Arize Phoenix (self-hosted or Phoenix Cloud).
    Phoenix,
    /// Helicone.
    Helicone,
    /// Datadog LLM Observability (agentless OTLP intake).
    Datadog,
}

impl ExporterPreset {
    /// Every preset in display order.
    pub const ALL: [Self; 7] = [
        Self::Otlp,
        Self::Langfuse,
        Self::LangSmith,
        Self::Braintrust,
        Self::Phoenix,
        Self::Helicone,
        Self::Datadog,
    ];

    /// Canonical config value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Otlp => "otlp",
            Self::Langfuse => "langfuse",
            Self::LangSmith => "langsmith",
            Self::Braintrust => "braintrust",
            Self::Phoenix => "phoenix",
            Self::Helicone => "helicone",
            Self::Datadog => "datadog",
        }
    }

    /// Tolerant parse; blank means the generic OTLP preset.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().replace('_', "-").as_str() {
            "" | "otlp" | "generic" | "custom" => Some(Self::Otlp),
            "langfuse" => Some(Self::Langfuse),
            "langsmith" => Some(Self::LangSmith),
            "braintrust" => Some(Self::Braintrust),
            "phoenix" | "arize-phoenix" | "arize" => Some(Self::Phoenix),
            "helicone" => Some(Self::Helicone),
            "datadog" => Some(Self::Datadog),
            _ => None,
        }
    }
}

/// Why a preset could not be resolved. Messages never contain secret values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PresetError {
    /// The generic preset needs an explicit endpoint.
    MissingEndpoint,
    /// A required credential was not configured or resolved empty.
    MissingSecret(&'static str),
    /// A required project/app name was not configured.
    MissingProject,
    /// A credential was configured as something other than a reference.
    InvalidSecretReference(String),
    /// A reference could not be read (missing env var, unreadable file, …).
    SecretUnavailable(String),
    /// An unknown preset name.
    UnknownPreset(String),
}

impl std::fmt::Display for PresetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingEndpoint => f.write_str("the otlp preset needs an endpoint"),
            Self::MissingSecret(which) => write!(f, "the {which} secret reference is not set"),
            Self::MissingProject => f.write_str("this preset needs a project name"),
            Self::InvalidSecretReference(detail) => write!(
                f,
                "invalid secret reference ({detail}); use env:NAME, file:/absolute/path, or secret:NAME"
            ),
            Self::SecretUnavailable(detail) => write!(f, "secret reference unavailable: {detail}"),
            Self::UnknownPreset(name) => write!(f, "unknown exporter preset `{name}`"),
        }
    }
}

impl std::error::Error for PresetError {}

/// Where a credential lives. Never a literal value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretReference {
    /// `env:NAME` — read from the process environment.
    Env(String),
    /// `file:/abs/path` — read (and trimmed) from a mounted secret file.
    File(PathBuf),
    /// `secret:NAME` — resolved by the Core vault (not available to Gateway).
    Vault(String),
}

impl SecretReference {
    /// Parse a reference. Bare strings are rejected so a credential can never
    /// be stored in plain preferences or config.
    pub fn parse(raw: &str) -> Result<Self, PresetError> {
        let raw = raw.trim();
        if let Some(name) = raw.strip_prefix("env:") {
            let name = name.trim();
            let valid = !name.is_empty()
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !name.starts_with(|c: char| c.is_ascii_digit());
            return if valid {
                Ok(Self::Env(name.to_owned()))
            } else {
                Err(PresetError::InvalidSecretReference(
                    "env: needs an environment variable name".into(),
                ))
            };
        }
        if let Some(path) = raw.strip_prefix("file:") {
            let path = PathBuf::from(path.trim());
            return if path.is_absolute() {
                Ok(Self::File(path))
            } else {
                Err(PresetError::InvalidSecretReference(
                    "file: needs an absolute path".into(),
                ))
            };
        }
        if let Some(body) = raw.strip_prefix("secret:") {
            let body = body.trim();
            return if body.is_empty() {
                Err(PresetError::InvalidSecretReference(
                    "secret: needs a vault secret name".into(),
                ))
            } else {
                Ok(Self::Vault(body.to_owned()))
            };
        }
        Err(PresetError::InvalidSecretReference(
            "a literal value is not accepted".into(),
        ))
    }

    /// Resolve an `env:` or `file:` reference. `secret:` references need the
    /// Core vault and return [`PresetError::SecretUnavailable`] here.
    pub fn resolve_local(&self) -> Result<String, PresetError> {
        let value = match self {
            Self::Env(name) => std::env::var(name)
                .map_err(|_| PresetError::SecretUnavailable(format!("env:{name} is not set")))?,
            Self::File(path) => std::fs::read_to_string(path).map_err(|error| {
                PresetError::SecretUnavailable(format!("file:{}: {error}", path.display()))
            })?,
            Self::Vault(name) => {
                return Err(PresetError::SecretUnavailable(format!(
                    "secret:{name} needs the Core vault"
                )))
            }
        };
        let value = value.trim().to_owned();
        if value.is_empty() {
            return Err(PresetError::SecretUnavailable(format!(
                "{} resolved to an empty value",
                self.label()
            )));
        }
        Ok(value)
    }

    /// The reference text (safe to log; contains no secret value).
    pub fn label(&self) -> String {
        match self {
            Self::Env(name) => format!("env:{name}"),
            Self::File(path) => format!("file:{}", path.display()),
            Self::Vault(name) => format!("secret:{name}"),
        }
    }
}

/// Preset configuration with credentials already resolved to values.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PresetSettings {
    /// Destination shape.
    pub preset: ExporterPreset,
    /// Base URL override (required for `otlp`; optional for hosted presets).
    pub endpoint: Option<String>,
    /// Project / app name (LangSmith project, Braintrust project, Phoenix
    /// project, Datadog ML app).
    pub project: Option<String>,
    /// Region or site (`us`/`eu` for Langfuse, LangSmith, Helicone; a Datadog
    /// site such as `us5`, `eu`, or `datadoghq.eu`).
    pub region: Option<String>,
    /// The primary credential (API key, or the Langfuse secret key).
    pub api_key: Option<String>,
    /// The Langfuse public key.
    pub public_key: Option<String>,
}

/// What the OTLP exporter needs for one destination.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResolvedExport {
    /// Full traces URL, used verbatim (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`).
    pub traces_endpoint: String,
    /// Request headers.
    pub headers: BTreeMap<String, String>,
    /// Extra resource attributes.
    pub resource_attributes: BTreeMap<String, String>,
}

impl ResolvedExport {
    /// Headers in the OTel env form (`k=v,k2=v2`).
    pub fn headers_env(&self) -> String {
        join_pairs(&self.headers)
    }

    /// Resource attributes in the OTel env form (`k=v,k2=v2`).
    pub fn resource_attributes_env(&self) -> String {
        join_pairs(&self.resource_attributes)
    }
}

fn join_pairs(pairs: &BTreeMap<String, String>) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{key}={}", value.replace(',', " ")))
        .collect::<Vec<_>>()
        .join(",")
}

fn clean(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// Join a base URL with a vendor ingestion prefix and the traces signal path.
/// A base that already ends in the full path, or in the prefix, is respected,
/// and a query string is preserved.
fn signal_url(base: &str, prefix: &str) -> String {
    let (base, query) = match base.trim().split_once('?') {
        Some((base, query)) => (base, Some(query)),
        None => (base.trim(), None),
    };
    let base = base.trim_end_matches('/');
    let mut url = if base.ends_with(TRACES_PATH) {
        base.to_owned()
    } else if !prefix.is_empty() && base.ends_with(prefix) {
        format!("{base}{TRACES_PATH}")
    } else {
        format!("{base}{prefix}{TRACES_PATH}")
    };
    if let Some(query) = query {
        url.push('?');
        url.push_str(query);
    }
    url
}

fn is_eu(region: Option<&str>) -> bool {
    clean(region).is_some_and(|region| region.eq_ignore_ascii_case("eu"))
}

/// Map a Datadog site shorthand to its domain.
pub fn datadog_site(region: Option<&str>) -> String {
    let Some(region) = clean(region) else {
        return "datadoghq.com".to_owned();
    };
    let lower = region.to_ascii_lowercase();
    if lower.contains('.') {
        return lower;
    }
    match lower.as_str() {
        "us" | "us1" => "datadoghq.com".to_owned(),
        "eu" | "eu1" => "datadoghq.eu".to_owned(),
        "gov" | "us1-fed" => "ddog-gov.com".to_owned(),
        other => format!("{other}.datadoghq.com"),
    }
}

/// Resolve a preset into the exporter's endpoint, headers, and resource
/// attributes.
pub fn resolve(settings: &PresetSettings) -> Result<ResolvedExport, PresetError> {
    let endpoint = clean(settings.endpoint.as_deref());
    let project = clean(settings.project.as_deref());
    let api_key = clean(settings.api_key.as_deref());
    let region = settings.region.as_deref();
    let mut out = ResolvedExport::default();
    match settings.preset {
        ExporterPreset::Otlp => {
            let endpoint = endpoint.ok_or(PresetError::MissingEndpoint)?;
            out.traces_endpoint = signal_url(endpoint, "");
            if let Some(key) = api_key {
                out.headers
                    .insert("Authorization".into(), format!("Bearer {key}"));
            }
        }
        ExporterPreset::Langfuse => {
            let public_key = clean(settings.public_key.as_deref())
                .ok_or(PresetError::MissingSecret("Langfuse public key"))?;
            let secret_key = api_key.ok_or(PresetError::MissingSecret("Langfuse secret key"))?;
            let default_host = if clean(region).is_some_and(|r| r.eq_ignore_ascii_case("us")) {
                "https://us.cloud.langfuse.com"
            } else {
                "https://cloud.langfuse.com"
            };
            out.traces_endpoint = signal_url(endpoint.unwrap_or(default_host), "/api/public/otel");
            let token = base64::engine::general_purpose::STANDARD
                .encode(format!("{public_key}:{secret_key}"));
            out.headers
                .insert("Authorization".into(), format!("Basic {token}"));
        }
        ExporterPreset::LangSmith => {
            let key = api_key.ok_or(PresetError::MissingSecret("LangSmith API key"))?;
            let default_host = if is_eu(region) {
                "https://eu.api.smith.langchain.com"
            } else {
                "https://api.smith.langchain.com"
            };
            out.traces_endpoint = signal_url(endpoint.unwrap_or(default_host), "/otel");
            out.headers.insert("x-api-key".into(), key.to_owned());
            if let Some(project) = project {
                out.headers
                    .insert("Langsmith-Project".into(), project.to_owned());
            }
        }
        ExporterPreset::Braintrust => {
            let key = api_key.ok_or(PresetError::MissingSecret("Braintrust API key"))?;
            let project = project.ok_or(PresetError::MissingProject)?;
            out.traces_endpoint =
                signal_url(endpoint.unwrap_or("https://api.braintrust.dev"), "/otel");
            out.headers
                .insert("Authorization".into(), format!("Bearer {key}"));
            out.headers
                .insert("x-bt-parent".into(), format!("project_name:{project}"));
        }
        ExporterPreset::Phoenix => {
            out.traces_endpoint = signal_url(endpoint.unwrap_or("http://localhost:6006"), "");
            if let Some(key) = api_key {
                out.headers
                    .insert("Authorization".into(), format!("Bearer {key}"));
            }
            if let Some(project) = project {
                out.resource_attributes
                    .insert("openinference.project.name".into(), project.to_owned());
            }
        }
        ExporterPreset::Helicone => {
            let key = api_key.ok_or(PresetError::MissingSecret("Helicone API key"))?;
            out.traces_endpoint = match endpoint {
                Some(url) if url.contains("/v1/trace/") => url.trim_end_matches('/').to_owned(),
                Some(base) => format!("{}/v1/trace/log-python", base.trim_end_matches('/')),
                None if is_eu(region) => "https://eu.api.helicone.ai/v1/trace/log-python".into(),
                None => "https://api.helicone.ai/v1/trace/log-python".into(),
            };
            out.headers
                .insert("Authorization".into(), format!("Bearer {key}"));
        }
        ExporterPreset::Datadog => {
            let key = api_key.ok_or(PresetError::MissingSecret("Datadog API key"))?;
            out.traces_endpoint = match endpoint {
                Some(url) => signal_url(url, ""),
                None => format!("https://otlp.{}{TRACES_PATH}", datadog_site(region)),
            };
            out.headers.insert("dd-api-key".into(), key.to_owned());
            out.headers
                .insert("dd-otlp-source".into(), "llmobs".to_owned());
            if let Some(project) = project {
                out.headers.insert("dd-ml-app".into(), project.to_owned());
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(preset: ExporterPreset) -> PresetSettings {
        PresetSettings {
            preset,
            api_key: Some("sk-test".into()),
            ..PresetSettings::default()
        }
    }

    #[test]
    fn preset_names_round_trip() {
        for preset in ExporterPreset::ALL {
            assert_eq!(ExporterPreset::parse(preset.as_str()), Some(preset));
        }
        assert_eq!(ExporterPreset::parse(""), Some(ExporterPreset::Otlp));
        assert_eq!(
            ExporterPreset::parse("Arize_Phoenix"),
            Some(ExporterPreset::Phoenix)
        );
        assert_eq!(ExporterPreset::parse("splunk"), None);
    }

    #[test]
    fn langfuse_uses_basic_auth_over_both_keys() {
        let mut cfg = settings(ExporterPreset::Langfuse);
        assert_eq!(
            resolve(&cfg),
            Err(PresetError::MissingSecret("Langfuse public key"))
        );
        cfg.public_key = Some("pk-lf".into());
        let out = resolve(&cfg).unwrap();
        assert_eq!(
            out.traces_endpoint,
            "https://cloud.langfuse.com/api/public/otel/v1/traces"
        );
        // base64("pk-lf:sk-test")
        assert_eq!(out.headers["Authorization"], "Basic cGstbGY6c2stdGVzdA==");
        cfg.region = Some("us".into());
        assert!(resolve(&cfg)
            .unwrap()
            .traces_endpoint
            .starts_with("https://us.cloud.langfuse.com/"));
        cfg.endpoint = Some("https://lf.internal/api/public/otel/".into());
        assert_eq!(
            resolve(&cfg).unwrap().traces_endpoint,
            "https://lf.internal/api/public/otel/v1/traces"
        );
    }

    #[test]
    fn langsmith_sets_api_key_and_project_headers() {
        let mut cfg = settings(ExporterPreset::LangSmith);
        cfg.project = Some("ryu-agents".into());
        let out = resolve(&cfg).unwrap();
        assert_eq!(
            out.traces_endpoint,
            "https://api.smith.langchain.com/otel/v1/traces"
        );
        assert_eq!(out.headers["x-api-key"], "sk-test");
        assert_eq!(out.headers["Langsmith-Project"], "ryu-agents");
        cfg.region = Some("EU".into());
        assert!(resolve(&cfg)
            .unwrap()
            .traces_endpoint
            .starts_with("https://eu.api.smith.langchain.com/"));
    }

    #[test]
    fn braintrust_requires_a_project_parent() {
        let mut cfg = settings(ExporterPreset::Braintrust);
        assert_eq!(resolve(&cfg), Err(PresetError::MissingProject));
        cfg.project = Some("evals".into());
        let out = resolve(&cfg).unwrap();
        assert_eq!(
            out.traces_endpoint,
            "https://api.braintrust.dev/otel/v1/traces"
        );
        assert_eq!(out.headers["Authorization"], "Bearer sk-test");
        assert_eq!(out.headers["x-bt-parent"], "project_name:evals");
    }

    #[test]
    fn phoenix_auth_is_optional_and_project_is_a_resource_attribute() {
        let cfg = PresetSettings {
            preset: ExporterPreset::Phoenix,
            project: Some("local".into()),
            ..PresetSettings::default()
        };
        let out = resolve(&cfg).unwrap();
        assert_eq!(out.traces_endpoint, "http://localhost:6006/v1/traces");
        assert!(out.headers.is_empty());
        assert_eq!(
            out.resource_attributes_env(),
            "openinference.project.name=local"
        );
    }

    #[test]
    fn helicone_and_datadog_map_regions() {
        let mut helicone = settings(ExporterPreset::Helicone);
        assert_eq!(
            resolve(&helicone).unwrap().traces_endpoint,
            "https://api.helicone.ai/v1/trace/log-python"
        );
        helicone.region = Some("eu".into());
        assert_eq!(
            resolve(&helicone).unwrap().traces_endpoint,
            "https://eu.api.helicone.ai/v1/trace/log-python"
        );

        let mut datadog = settings(ExporterPreset::Datadog);
        datadog.project = Some("ryu".into());
        let out = resolve(&datadog).unwrap();
        assert_eq!(out.traces_endpoint, "https://otlp.datadoghq.com/v1/traces");
        assert_eq!(out.headers["dd-api-key"], "sk-test");
        assert_eq!(out.headers["dd-otlp-source"], "llmobs");
        assert_eq!(out.headers["dd-ml-app"], "ryu");
        assert_eq!(datadog_site(Some("us5")), "us5.datadoghq.com");
        assert_eq!(datadog_site(Some("eu")), "datadoghq.eu");
        assert_eq!(datadog_site(Some("ddog-gov.com")), "ddog-gov.com");
    }

    #[test]
    fn generic_otlp_needs_an_endpoint() {
        let mut cfg = PresetSettings::default();
        assert_eq!(resolve(&cfg), Err(PresetError::MissingEndpoint));
        cfg.endpoint = Some("http://collector:4318/?a=1".into());
        let out = resolve(&cfg).unwrap();
        assert_eq!(out.traces_endpoint, "http://collector:4318/v1/traces?a=1");
        assert!(out.headers.is_empty());
    }

    #[test]
    fn headers_env_is_otel_pair_form() {
        let mut cfg = settings(ExporterPreset::Datadog);
        cfg.project = Some("a,b".into());
        let env = resolve(&cfg).unwrap().headers_env();
        assert_eq!(
            env,
            "dd-api-key=sk-test,dd-ml-app=a b,dd-otlp-source=llmobs"
        );
    }

    #[test]
    fn secret_references_reject_literals_and_resolve_env_and_file() {
        assert!(matches!(
            SecretReference::parse("sk-live-123"),
            Err(PresetError::InvalidSecretReference(_))
        ));
        assert!(SecretReference::parse("env:1BAD").is_err());
        assert!(SecretReference::parse("file:relative.txt").is_err());
        assert_eq!(
            SecretReference::parse(" secret:LANGFUSE_SK ").unwrap(),
            SecretReference::Vault("LANGFUSE_SK".into())
        );
        let vault = SecretReference::Vault("X".into());
        assert!(matches!(
            vault.resolve_local(),
            Err(PresetError::SecretUnavailable(_))
        ));

        let dir = std::env::temp_dir().join(format!("ryu-tracing-secret-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("key");
        std::fs::write(&file, "  file-secret\n").unwrap();
        let reference = SecretReference::parse(&format!("file:{}", file.display())).unwrap();
        assert_eq!(reference.resolve_local().unwrap(), "file-secret");
        std::fs::remove_dir_all(&dir).unwrap();

        let missing = SecretReference::parse("env:RYU_TRACING_TEST_SURELY_UNSET_VAR").unwrap();
        let error = missing.resolve_local().unwrap_err().to_string();
        assert!(error.contains("RYU_TRACING_TEST_SURELY_UNSET_VAR"));
        assert_eq!(missing.label(), "env:RYU_TRACING_TEST_SURELY_UNSET_VAR");
    }
}

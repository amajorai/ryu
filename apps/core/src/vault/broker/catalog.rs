//! Built-in service templates for common APIs.
//!
//! Each template carries the API host, a path prefix, the provider's auth
//! scheme, and a suggested `secret:` reference. Installing a template creates
//! an ordinary service; nothing here is special-cased by the proxy.

use std::sync::OnceLock;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::services::{ServiceAuth, ServiceInput};
use crate::vault::VaultError;

const CATALOG_JSON: &str = include_str!("catalog.json");

/// One template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTemplate {
    pub id: String,
    pub name: String,
    pub host: String,
    pub path_prefix: String,
    pub suggested_ref: String,
    pub auth: ServiceAuth,
}

/// Every built-in template.
pub fn templates() -> &'static [ServiceTemplate] {
    static CATALOG: OnceLock<Vec<ServiceTemplate>> = OnceLock::new();
    CATALOG
        .get_or_init(|| serde_json::from_str(CATALOG_JSON).expect("broker catalog.json is valid"))
}

/// The template id whose host is `host`, if any.
pub fn suggest_for_host(host: &str) -> Option<&'static str> {
    templates()
        .iter()
        .find(|template| template.host.eq_ignore_ascii_case(host))
        .map(|template| template.id.as_str())
}

fn replace_ref(auth: &ServiceAuth, from: &str, to: &str) -> ServiceAuth {
    let swap = |value: &String| {
        if value == from {
            to.to_owned()
        } else {
            value.clone()
        }
    };
    match auth {
        ServiceAuth::Bearer { token } => ServiceAuth::Bearer { token: swap(token) },
        ServiceAuth::Basic { username, password } => ServiceAuth::Basic {
            username: swap(username),
            password: swap(password),
        },
        ServiceAuth::ApiKey {
            header,
            value,
            prefix,
        } => ServiceAuth::ApiKey {
            header: header.clone(),
            value: swap(value),
            prefix: prefix.clone(),
        },
        ServiceAuth::Custom { headers } => ServiceAuth::Custom {
            headers: headers
                .iter()
                .map(|(name, template)| (name.clone(), template.replace(from, to)))
                .collect(),
        },
        ServiceAuth::Passthrough => ServiceAuth::Passthrough,
    }
}

/// A service built from a template, optionally pointing at another
/// credential reference.
pub fn instantiate(
    template_id: &str,
    name: Option<&str>,
    environment: &str,
    credential_ref: Option<&str>,
) -> Result<ServiceInput> {
    let template = templates()
        .iter()
        .find(|template| template.id == template_id)
        .ok_or_else(|| VaultError::NotFound(format!("catalog template `{template_id}`")))?;
    let auth = match credential_ref {
        Some(reference) => replace_ref(&template.auth, &template.suggested_ref, reference),
        None => template.auth.clone(),
    };
    ServiceInput {
        name: name.unwrap_or(&template.id).to_owned(),
        environment: environment.to_owned(),
        host: template.host.clone(),
        port: None,
        path_prefix: template.path_prefix.clone(),
        auth,
        substitutions: Vec::new(),
        enabled: true,
        allow_insecure_http: false,
        description: template.name.clone(),
        notes: String::new(),
    }
    .normalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_template_is_a_valid_service() {
        let ids: Vec<&str> = templates().iter().map(|t| t.id.as_str()).collect();
        for expected in [
            "anthropic",
            "openai",
            "github",
            "gitlab",
            "gemini",
            "linear",
            "npm",
            "slack",
            "stripe",
        ] {
            assert!(ids.contains(&expected), "{expected}");
        }
        for template in templates() {
            let service = instantiate(&template.id, None, "default", None).unwrap();
            assert!(
                service.auth.refs().contains(&template.suggested_ref),
                "{}",
                template.id
            );
        }
    }

    #[test]
    fn instantiation_overrides_name_and_reference() {
        let service = instantiate(
            "openai",
            Some("openai-prod"),
            "prod",
            Some("secret:prod:/ai/KEY"),
        )
        .unwrap();
        assert_eq!(service.name, "openai-prod");
        assert_eq!(service.environment, "prod");
        assert_eq!(
            service.auth,
            ServiceAuth::Bearer {
                token: "secret:prod:/ai/KEY".into()
            }
        );
        assert!(instantiate("missing", None, "default", None).is_err());
        assert!(instantiate("openai", None, "default", Some("OPENAI")).is_err());
        assert_eq!(suggest_for_host("API.OPENAI.COM"), Some("openai"));
    }
}

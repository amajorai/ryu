//! Verified routing-region metadata for registered providers.

use super::*;

pub(super) fn provider_regions(config: &ProvidersConfig) -> HashMap<String, String> {
    let mut regions = HashMap::new();
    if let Some(polly) = config.polly.as_ref() {
        regions.insert("polly".to_owned(), polly.region.clone());
    }
    if let Some(config) = config.genai.as_ref() {
        for descriptor in ryu_gw_credentials::SDK_PROVIDERS {
            let Some(account) = config.accounts.get(descriptor.kind) else {
                continue;
            };
            let region = match &account.context {
                ryu_gw_credentials::SdkEndpointConfig::Default => Some("global".to_owned()),
                ryu_gw_credentials::SdkEndpointConfig::Vertex { location, .. } => {
                    Some(location.clone())
                }
                ryu_gw_credentials::SdkEndpointConfig::BedrockApi { region } => {
                    Some(region.clone())
                }
                ryu_gw_credentials::SdkEndpointConfig::Ollama { base_url } => {
                    reqwest::Url::parse(base_url)
                        .ok()
                        .filter(|url| {
                            url.host_str().is_some_and(|host| {
                                matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
                            })
                        })
                        .map(|_| "local".to_owned())
                }
            };
            if let Some(region) = region {
                regions.insert(descriptor.provider_id.to_owned(), region);
            }
        }
    }
    if let Some(provider) = config.compatible.get("qwen") {
        if let Some(region) = region_from_qwen_url(&provider.base_url) {
            regions.insert("qwen".to_owned(), region.to_owned());
        }
    }
    if let Some(provider) = &config.bedrock {
        if let Some(region) = region_from_bedrock_url(&provider.base_url) {
            regions.insert(BEDROCK_PROVIDER_ID.to_string(), region);
        }
    }
    if let Some(provider) = &config.vertex {
        if let Some(region) = region_from_vertex_url(&provider.base_url) {
            regions.insert(VERTEX_PROVIDER_ID.to_string(), region);
        }
    }
    regions
}

/// Read only explicitly declared SDK import variables; never expose their material.
pub(crate) fn sdk_environment() -> std::collections::BTreeMap<String, String> {
    ryu_gw_credentials::SDK_PROVIDERS
        .iter()
        .filter_map(|descriptor| descriptor.default_env)
        .filter_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| (name.to_owned(), value))
        })
        .collect()
}

pub(super) fn region_from_qwen_url(base_url: &str) -> Option<&'static str> {
    let url = reqwest::Url::parse(base_url).ok()?;
    let host = url.host_str()?;
    for (region, legacy) in [
        ("ap-southeast-1", "dashscope-intl.aliyuncs.com"),
        ("cn-beijing", "dashscope.aliyuncs.com"),
        ("us-east-1", "dashscope-us.aliyuncs.com"),
        ("cn-hongkong", "cn-hongkong.dashscope.aliyuncs.com"),
    ] {
        if host == legacy || host.ends_with(&format!(".{region}.maas.aliyuncs.com")) {
            return Some(region);
        }
    }
    None
}

fn region_from_bedrock_url(base_url: &str) -> Option<String> {
    let host = reqwest::Url::parse(base_url)
        .ok()?
        .host_str()?
        .to_ascii_lowercase();
    let region = host
        .strip_prefix("bedrock-mantle.")?
        .strip_suffix(".api.aws")?;
    (!region.is_empty()).then(|| region.to_string())
}

fn region_from_vertex_url(base_url: &str) -> Option<String> {
    let host = reqwest::Url::parse(base_url)
        .ok()?
        .host_str()?
        .to_ascii_lowercase();
    let region = host.strip_suffix("-aiplatform.googleapis.com")?;
    (!region.is_empty()).then(|| region.to_string())
}

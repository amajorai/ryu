//! Shared SDK provider metadata, grounded in the pinned GenAI 0.6.5 default build.
//!
//! This table describes Ryu's implemented operations. SDK features alone do not
//! establish OAuth, subscription, embedding, or speech support. Environment names
//! are metadata for explicit import; they do not authorize ambient fallback.

/// The credential material accepted by a provider account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SdkAuthKind {
    ApiKey,
    BearerToken,
    NoAuth,
}

/// Operations implemented by Ryu's SDK provider runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SdkOperation {
    Chat,
    Stream,
    Image,
}

/// Endpoint context required in addition to account authentication.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SdkContextKind {
    Default,
    Vertex,
    BedrockApi,
    Ollama,
}

/// Operator-supplied endpoint context. Config and network boundaries validate
/// these values before use; this carrier never reads ambient environment data.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SdkEndpointConfig {
    Default,
    Vertex { project: String, location: String },
    BedrockApi { region: String },
    Ollama { base_url: String },
}

impl<'de> serde::Deserialize<'de> for SdkEndpointConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Serde ignores extra fields on internally tagged unit variants, even
        // with deny_unknown_fields. An empty struct variant closes that gap.
        #[derive(serde::Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
        enum WireConfig {
            Default {},
            Vertex { project: String, location: String },
            BedrockApi { region: String },
            Ollama { base_url: String },
        }
        Ok(match WireConfig::deserialize(deserializer)? {
            WireConfig::Default {} => Self::Default,
            WireConfig::Vertex { project, location } => Self::Vertex { project, location },
            WireConfig::BedrockApi { region } => Self::BedrockApi { region },
            WireConfig::Ollama { base_url } => Self::Ollama { base_url },
        })
    }
}

impl Default for SdkEndpointConfig {
    fn default() -> Self {
        Self::Default
    }
}

impl SdkEndpointConfig {
    pub fn kind(&self) -> SdkContextKind {
        match self {
            Self::Default => SdkContextKind::Default,
            Self::Vertex { .. } => SdkContextKind::Vertex,
            Self::BedrockApi { .. } => SdkContextKind::BedrockApi,
            Self::Ollama { .. } => SdkContextKind::Ollama,
        }
    }
}

/// Non-secret metadata shared by config, dispatch, and account editors.
///
/// `kind` retains the SDK namespace spelling. `provider_id` identifies the
/// executable Ryu route, while `account_scope` preserves account hash identity.
/// The GitHub SDK variant serves GitHub Models, not Copilot OAuth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct SdkProviderDescriptor {
    pub kind: &'static str,
    pub provider_id: &'static str,
    pub account_scope: &'static str,
    pub label: &'static str,
    pub brand: &'static str,
    pub auth_kind: SdkAuthKind,
    pub default_env: Option<&'static str>,
    pub operations: &'static [SdkOperation],
    pub context_kind: SdkContextKind,
}

const CHAT_OPERATIONS: &[SdkOperation] = &[SdkOperation::Chat, SdkOperation::Stream];
const GEMINI_OPERATIONS: &[SdkOperation] = &[
    SdkOperation::Chat,
    SdkOperation::Stream,
    SdkOperation::Image,
];

/// Every adapter enabled in GenAI 0.6.5's default build.
///
/// Bedrock SigV4 is feature-gated upstream and is deliberately absent. Native and
/// OpenAI-compatible providers retain their separate routes and account scopes.
pub const SDK_PROVIDERS: &[SdkProviderDescriptor] = &[
    SdkProviderDescriptor {
        kind: "openai",
        provider_id: "genai-openai",
        account_scope: "genai-openai",
        label: "OpenAI (Chat Completions)",
        brand: "openai",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("OPENAI_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "openai_resp",
        provider_id: "genai-openai-resp",
        account_scope: "genai-openai-resp",
        label: "OpenAI (Responses)",
        brand: "openai",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("OPENAI_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "gemini",
        provider_id: "genai",
        account_scope: "gemini",
        label: "Google Gemini",
        brand: "gemini",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("GEMINI_API_KEY"),
        operations: GEMINI_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "anthropic",
        provider_id: "genai-anthropic",
        account_scope: "genai-anthropic",
        label: "Anthropic",
        brand: "anthropic",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("ANTHROPIC_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "fireworks",
        provider_id: "genai-fireworks",
        account_scope: "genai-fireworks",
        label: "Fireworks AI",
        brand: "fireworks",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("FIREWORKS_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "together",
        provider_id: "genai-together",
        account_scope: "genai-together",
        label: "Together AI",
        brand: "together",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("TOGETHER_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "groq",
        provider_id: "genai-groq",
        account_scope: "genai-groq",
        label: "Groq",
        brand: "groq",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("GROQ_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "aihubmix",
        provider_id: "genai-aihubmix",
        account_scope: "genai-aihubmix",
        label: "AIHubMix",
        brand: "aihubmix",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("AIHUBMIX_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "mimo",
        provider_id: "genai-mimo",
        account_scope: "genai-mimo",
        label: "MiMo",
        brand: "mimo",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("MIMO_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "moonshot",
        provider_id: "genai-moonshot",
        account_scope: "genai-moonshot",
        label: "Moonshot AI",
        brand: "moonshot",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("MOONSHOT_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "nebius",
        provider_id: "genai-nebius",
        account_scope: "genai-nebius",
        label: "Nebius",
        brand: "nebius",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("NEBIUS_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "xai",
        provider_id: "genai-xai",
        account_scope: "genai-xai",
        label: "xAI",
        brand: "xai",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("XAI_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "deepseek",
        provider_id: "genai-deepseek",
        account_scope: "genai-deepseek",
        label: "DeepSeek",
        brand: "deepseek",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("DEEPSEEK_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "zai",
        provider_id: "genai-zai",
        account_scope: "genai-zai",
        label: "Z.AI",
        brand: "zai",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("ZAI_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "bigmodel",
        provider_id: "genai-bigmodel",
        account_scope: "genai-bigmodel",
        label: "BigModel",
        brand: "bigmodel",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("BIGMODEL_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "aliyun",
        provider_id: "genai-aliyun",
        account_scope: "genai-aliyun",
        label: "Alibaba Cloud",
        brand: "aliyun",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("ALIYUN_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "baidu",
        provider_id: "genai-baidu",
        account_scope: "genai-baidu",
        label: "Baidu",
        brand: "baidu",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("BAIDU_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "cohere",
        provider_id: "genai-cohere",
        account_scope: "genai-cohere",
        label: "Cohere",
        brand: "cohere",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("COHERE_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "ollama",
        provider_id: "genai-ollama",
        account_scope: "genai-ollama",
        label: "Ollama",
        brand: "ollama",
        auth_kind: SdkAuthKind::NoAuth,
        default_env: None,
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Ollama,
    },
    SdkProviderDescriptor {
        kind: "ollama_cloud",
        provider_id: "genai-ollama-cloud",
        account_scope: "genai-ollama-cloud",
        label: "Ollama Cloud",
        brand: "ollama",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("OLLAMA_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "vertex",
        provider_id: "genai-vertex",
        account_scope: "genai-vertex",
        label: "Google Vertex AI",
        brand: "google-cloud",
        auth_kind: SdkAuthKind::BearerToken,
        default_env: Some("VERTEX_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Vertex,
    },
    SdkProviderDescriptor {
        kind: "github_copilot",
        provider_id: "genai-github-copilot",
        account_scope: "genai-github-copilot",
        label: "GitHub Models",
        brand: "github-models",
        auth_kind: SdkAuthKind::BearerToken,
        default_env: Some("GITHUB_TOKEN"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "opencode_go",
        provider_id: "genai-opencode-go",
        account_scope: "genai-opencode-go",
        label: "OpenCode Go",
        brand: "opencode",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("OPENCODE_GO_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "bedrock_api",
        provider_id: "genai-bedrock-api",
        account_scope: "genai-bedrock-api",
        label: "Amazon Bedrock (API token)",
        brand: "aws",
        auth_kind: SdkAuthKind::BearerToken,
        default_env: Some("BEDROCK_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::BedrockApi,
    },
    SdkProviderDescriptor {
        kind: "open_router",
        provider_id: "genai-open-router",
        account_scope: "genai-open-router",
        label: "OpenRouter",
        brand: "openrouter",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("OPEN_ROUTER_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
    SdkProviderDescriptor {
        kind: "minimax",
        provider_id: "genai-minimax",
        account_scope: "genai-minimax",
        label: "MiniMax",
        brand: "minimax",
        auth_kind: SdkAuthKind::ApiKey,
        default_env: Some("MINIMAX_API_KEY"),
        operations: CHAT_OPERATIONS,
        context_kind: SdkContextKind::Default,
    },
];

/// Look up a canonical SDK kind. Aliases and model namespaces are resolved by
/// the SDK-dependent providers crate, not this metadata boundary.
pub fn sdk_provider_by_kind(kind: &str) -> Option<&'static SdkProviderDescriptor> {
    SDK_PROVIDERS.iter().find(|provider| provider.kind == kind)
}

/// Look up an executable Ryu SDK route without accepting native route aliases.
pub fn sdk_provider_by_id(id: &str) -> Option<&'static SdkProviderDescriptor> {
    SDK_PROVIDERS
        .iter()
        .find(|provider| provider.provider_id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn inventory_covers_the_default_build_and_excludes_feature_gated_sigv4() {
        let expected = [
            "openai",
            "openai_resp",
            "gemini",
            "anthropic",
            "fireworks",
            "together",
            "groq",
            "aihubmix",
            "mimo",
            "moonshot",
            "nebius",
            "xai",
            "deepseek",
            "zai",
            "bigmodel",
            "aliyun",
            "baidu",
            "cohere",
            "ollama",
            "ollama_cloud",
            "vertex",
            "github_copilot",
            "opencode_go",
            "bedrock_api",
            "open_router",
            "minimax",
        ];
        let actual: HashSet<_> = SDK_PROVIDERS.iter().map(|provider| provider.kind).collect();
        assert_eq!(SDK_PROVIDERS.len(), expected.len());
        assert_eq!(actual, expected.into_iter().collect());
        assert!(sdk_provider_by_kind("bedrock_sigv4").is_none());
    }

    #[test]
    fn route_and_account_ids_are_unique_valid_and_separate_from_native_routes() {
        let mut kinds = HashSet::new();
        let mut routes = HashSet::new();
        let mut scopes = HashSet::new();
        for provider in SDK_PROVIDERS {
            assert!(kinds.insert(provider.kind));
            assert!(routes.insert(provider.provider_id));
            assert!(scopes.insert(provider.account_scope));
            for id in [provider.provider_id, provider.account_scope] {
                assert!(id.bytes().all(|byte| byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || byte == b'-'));
                assert!(!id.starts_with('-') && !id.ends_with('-'));
            }
            assert!(!provider.label.is_empty());
            assert!(!provider.brand.is_empty());
            if provider.kind != "gemini" {
                assert_eq!(
                    provider.provider_id,
                    format!("genai-{}", provider.kind.replace('_', "-"))
                );
                assert_eq!(provider.account_scope, provider.provider_id);
            }
            assert!(crate::direct_compatible_provider_url(provider.provider_id).is_none());
        }
        for native in [
            "openai",
            "anthropic",
            "groq",
            "fireworks",
            "together",
            "github-copilot",
        ] {
            assert!(sdk_provider_by_id(native).is_none());
        }
    }

    #[test]
    fn gemini_preserves_route_scope_and_account_hash() {
        let gemini = sdk_provider_by_kind("gemini").unwrap();
        assert_eq!(gemini.provider_id, "genai");
        assert_eq!(gemini.account_scope, "gemini");
        assert_eq!(sdk_provider_by_id("genai"), Some(gemini));
        assert!(sdk_provider_by_id("genai-gemini").is_none());
        assert_eq!(
            crate::provider_account_id(gemini.account_scope, "synthetic-account-material"),
            "ad7c9f42a42d00275742fd90ed0cf2485e2541528fafcd1a68763d04fc4872b6"
        );
    }

    #[test]
    fn lookups_roundtrip_and_reject_noncanonical_input() {
        for provider in SDK_PROVIDERS {
            assert_eq!(sdk_provider_by_kind(provider.kind), Some(provider));
            assert_eq!(sdk_provider_by_id(provider.provider_id), Some(provider));
        }
        for unknown in [
            "",
            "OpenAI",
            " openai",
            "openai ",
            "openai::gpt-4",
            "openai-resp",
            "genai-openai",
            "genai",
            "https://example.test",
        ] {
            assert!(sdk_provider_by_kind(unknown).is_none(), "{unknown}");
        }
        for unknown in [
            "",
            "Genai",
            " genai",
            "genai ",
            "genai_openai",
            "gemini",
            "genai-openai_resp",
            "genai-bedrock-sigv4",
            "https://example.test",
        ] {
            assert!(sdk_provider_by_id(unknown).is_none(), "{unknown}");
        }
    }

    #[test]
    fn authentication_and_endpoint_context_are_truthful() {
        for provider in SDK_PROVIDERS {
            let expected_auth = match provider.kind {
                "ollama" => SdkAuthKind::NoAuth,
                "vertex" | "github_copilot" | "bedrock_api" => SdkAuthKind::BearerToken,
                _ => SdkAuthKind::ApiKey,
            };
            assert_eq!(provider.auth_kind, expected_auth, "{}", provider.kind);
            let expected_context = match provider.kind {
                "vertex" => SdkContextKind::Vertex,
                "bedrock_api" => SdkContextKind::BedrockApi,
                "ollama" => SdkContextKind::Ollama,
                _ => SdkContextKind::Default,
            };
            assert_eq!(provider.context_kind, expected_context, "{}", provider.kind);
            assert_eq!(provider.default_env.is_none(), provider.kind == "ollama");
        }
        let github = sdk_provider_by_kind("github_copilot").unwrap();
        assert_eq!(github.label, "GitHub Models");
        assert_eq!(github.brand, "github-models");
        assert_eq!(
            sdk_provider_by_kind("vertex").unwrap().brand,
            "google-cloud"
        );
        assert_eq!(github.default_env, Some("GITHUB_TOKEN"));
        assert_eq!(
            sdk_provider_by_kind("vertex").unwrap().default_env,
            Some("VERTEX_API_KEY")
        );
        assert_eq!(
            sdk_provider_by_kind("bedrock_api").unwrap().default_env,
            Some("BEDROCK_API_KEY")
        );
        assert_eq!(
            sdk_provider_by_kind("ollama_cloud").unwrap().default_env,
            Some("OLLAMA_API_KEY")
        );
    }

    #[test]
    fn environment_names_match_the_pinned_sdk_defaults() {
        let expected = [
            ("openai", Some("OPENAI_API_KEY")),
            ("openai_resp", Some("OPENAI_API_KEY")),
            ("gemini", Some("GEMINI_API_KEY")),
            ("anthropic", Some("ANTHROPIC_API_KEY")),
            ("fireworks", Some("FIREWORKS_API_KEY")),
            ("together", Some("TOGETHER_API_KEY")),
            ("groq", Some("GROQ_API_KEY")),
            ("aihubmix", Some("AIHUBMIX_API_KEY")),
            ("mimo", Some("MIMO_API_KEY")),
            ("moonshot", Some("MOONSHOT_API_KEY")),
            ("nebius", Some("NEBIUS_API_KEY")),
            ("xai", Some("XAI_API_KEY")),
            ("deepseek", Some("DEEPSEEK_API_KEY")),
            ("zai", Some("ZAI_API_KEY")),
            ("bigmodel", Some("BIGMODEL_API_KEY")),
            ("aliyun", Some("ALIYUN_API_KEY")),
            ("baidu", Some("BAIDU_API_KEY")),
            ("cohere", Some("COHERE_API_KEY")),
            ("ollama", None),
            ("ollama_cloud", Some("OLLAMA_API_KEY")),
            ("vertex", Some("VERTEX_API_KEY")),
            ("github_copilot", Some("GITHUB_TOKEN")),
            ("opencode_go", Some("OPENCODE_GO_API_KEY")),
            ("bedrock_api", Some("BEDROCK_API_KEY")),
            ("open_router", Some("OPEN_ROUTER_API_KEY")),
            ("minimax", Some("MINIMAX_API_KEY")),
        ];
        assert_eq!(expected.len(), SDK_PROVIDERS.len());
        for (kind, env) in expected {
            assert_eq!(
                sdk_provider_by_kind(kind).unwrap().default_env,
                env,
                "{kind}"
            );
        }
    }

    #[test]
    fn capabilities_advertise_only_implemented_operations() {
        for provider in SDK_PROVIDERS {
            assert_eq!(
                provider.operations,
                if provider.kind == "gemini" {
                    &[
                        SdkOperation::Chat,
                        SdkOperation::Stream,
                        SdkOperation::Image,
                    ][..]
                } else {
                    &[SdkOperation::Chat, SdkOperation::Stream][..]
                }
            );
        }
    }

    #[test]
    fn metadata_serialization_has_explicit_auth_and_context() {
        let ollama = serde_json::to_value(sdk_provider_by_kind("ollama").unwrap()).unwrap();
        assert_eq!(ollama["auth_kind"], "no_auth");
        assert_eq!(ollama["context_kind"], "ollama");
        assert_eq!(ollama["default_env"], serde_json::Value::Null);
        assert_eq!(ollama["operations"], serde_json::json!(["chat", "stream"]));
        assert_eq!(
            serde_json::from_str::<SdkAuthKind>("\"bearer_token\"").unwrap(),
            SdkAuthKind::BearerToken
        );
        assert!(serde_json::from_str::<SdkAuthKind>("\"oauth\"").is_err());
        assert!(serde_json::from_str::<SdkContextKind>("\"bedrock_sigv4\"").is_err());
        assert!(serde_json::from_str::<SdkOperation>("\"embedding\"").is_err());
    }

    #[test]
    fn endpoint_config_roundtrips_with_tagged_context() {
        let cases = [
            (
                SdkEndpointConfig::Default,
                serde_json::json!({"kind": "default"}),
                SdkContextKind::Default,
            ),
            (
                SdkEndpointConfig::Vertex {
                    project: "test-project".into(),
                    location: "global".into(),
                },
                serde_json::json!({"kind": "vertex", "project": "test-project", "location": "global"}),
                SdkContextKind::Vertex,
            ),
            (
                SdkEndpointConfig::BedrockApi {
                    region: "us-east-1".into(),
                },
                serde_json::json!({"kind": "bedrock_api", "region": "us-east-1"}),
                SdkContextKind::BedrockApi,
            ),
            (
                SdkEndpointConfig::Ollama {
                    base_url: "http://127.0.0.1:11434/".into(),
                },
                serde_json::json!({"kind": "ollama", "base_url": "http://127.0.0.1:11434/"}),
                SdkContextKind::Ollama,
            ),
        ];
        assert_eq!(SdkEndpointConfig::default(), SdkEndpointConfig::Default);
        for (config, wire, kind) in cases {
            assert_eq!(config.kind(), kind);
            assert_eq!(serde_json::to_value(&config).unwrap(), wire);
            assert_eq!(
                serde_json::from_value::<SdkEndpointConfig>(wire).unwrap(),
                config
            );
        }
    }

    #[test]
    fn endpoint_config_rejects_unknown_fields_variants_and_missing_context() {
        for wire in [
            serde_json::json!({"kind": "default", "api_key": "synthetic"}),
            serde_json::json!({"kind": "vertex", "project": "p", "location": "global", "region": "r"}),
            serde_json::json!({"kind": "bedrock_api", "region": "us-east-1", "access_key": "synthetic"}),
            serde_json::json!({"kind": "ollama", "base_url": "http://localhost/", "api_key": "synthetic"}),
            serde_json::json!({"kind": "vertex", "project": "p"}),
            serde_json::json!({"kind": "bedrock_api"}),
            serde_json::json!({"kind": "ollama"}),
            serde_json::json!({"kind": "bedrock_sigv4"}),
            serde_json::json!({}),
        ] {
            assert!(
                serde_json::from_value::<SdkEndpointConfig>(wire.clone()).is_err(),
                "{wire}"
            );
        }
    }
}

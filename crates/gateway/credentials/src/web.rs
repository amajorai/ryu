//! Authored web-service account contracts. Descriptors are adapter contracts,
//! not evidence of registration, credential validity, or live API availability.
//! No constructor reads environment variables or Core plugin secret stores.

use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_WEB_ACCOUNTS: usize = 32;
pub const MAX_WEB_API_KEY_BYTES: usize = 4096;
pub const MAX_GOOGLE_ENGINE_ID_BYTES: usize = 256;
/// January 1, 2027, 00:00:00 UTC; Google Custom Search JSON API discontinuation.
pub const GOOGLE_PSE_SUNSET_UNIX_SECONDS: u64 = 1_798_761_600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebOperation {
    Search,
    Fetch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebContentFormat {
    Markdown,
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WebAuthRequirement {
    ApiKey,
    ApiKeyOrExplicitAnonymous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WebContextKind {
    Default,
    GooglePse,
    SearchApi,
}

/// Closed inventory of initial direct web-service adapter contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum WebProviderKind {
    #[serde(rename = "tavily")]
    Tavily,
    #[serde(rename = "brave")]
    Brave,
    #[serde(rename = "serper")]
    Serper,
    #[serde(rename = "exa")]
    Exa,
    #[serde(rename = "linkup")]
    Linkup,
    #[serde(rename = "parallel")]
    Parallel,
    #[serde(rename = "perplexity-search")]
    PerplexitySearch,
    #[serde(rename = "google-pse")]
    GooglePse,
    #[serde(rename = "searchapi")]
    SearchApi,
    #[serde(rename = "firecrawl")]
    Firecrawl,
    #[serde(rename = "jina-reader")]
    JinaReader,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct WebProviderDescriptor {
    pub kind: WebProviderKind,
    pub provider_id: &'static str,
    pub label: &'static str,
    pub operations: &'static [WebOperation],
    pub formats: &'static [WebContentFormat],
    pub auth: WebAuthRequirement,
    pub context: WebContextKind,
}

const SEARCH: &[WebOperation] = &[WebOperation::Search];
const FETCH: &[WebOperation] = &[WebOperation::Fetch];
const BOTH: &[WebOperation] = &[WebOperation::Search, WebOperation::Fetch];
const NO_FORMATS: &[WebContentFormat] = &[];
const MARKDOWN: &[WebContentFormat] = &[WebContentFormat::Markdown];
const TEXT: &[WebContentFormat] = &[WebContentFormat::Text];
const MARKDOWN_TEXT: &[WebContentFormat] = &[WebContentFormat::Markdown, WebContentFormat::Text];

pub const WEB_PROVIDERS: &[WebProviderDescriptor] = &[
    WebProviderDescriptor {
        kind: WebProviderKind::Tavily,
        provider_id: "tavily",
        label: "Tavily",
        operations: BOTH,
        formats: MARKDOWN_TEXT,
        auth: WebAuthRequirement::ApiKey,
        context: WebContextKind::Default,
    },
    WebProviderDescriptor {
        kind: WebProviderKind::Brave,
        provider_id: "brave",
        label: "Brave Search",
        operations: SEARCH,
        formats: NO_FORMATS,
        auth: WebAuthRequirement::ApiKey,
        context: WebContextKind::Default,
    },
    WebProviderDescriptor {
        kind: WebProviderKind::Serper,
        provider_id: "serper",
        label: "Serper",
        operations: SEARCH,
        formats: NO_FORMATS,
        auth: WebAuthRequirement::ApiKey,
        context: WebContextKind::Default,
    },
    WebProviderDescriptor {
        kind: WebProviderKind::Exa,
        provider_id: "exa",
        label: "Exa",
        operations: BOTH,
        formats: TEXT,
        auth: WebAuthRequirement::ApiKey,
        context: WebContextKind::Default,
    },
    WebProviderDescriptor {
        kind: WebProviderKind::Linkup,
        provider_id: "linkup",
        label: "Linkup",
        operations: SEARCH,
        formats: NO_FORMATS,
        auth: WebAuthRequirement::ApiKey,
        context: WebContextKind::Default,
    },
    WebProviderDescriptor {
        kind: WebProviderKind::Parallel,
        provider_id: "parallel",
        label: "Parallel",
        operations: SEARCH,
        formats: NO_FORMATS,
        auth: WebAuthRequirement::ApiKey,
        context: WebContextKind::Default,
    },
    WebProviderDescriptor {
        kind: WebProviderKind::PerplexitySearch,
        provider_id: "perplexity-search",
        label: "Perplexity Search",
        operations: SEARCH,
        formats: NO_FORMATS,
        auth: WebAuthRequirement::ApiKey,
        context: WebContextKind::Default,
    },
    WebProviderDescriptor {
        kind: WebProviderKind::GooglePse,
        provider_id: "google-pse",
        label: "Google Custom Search (existing customers)",
        operations: SEARCH,
        formats: NO_FORMATS,
        auth: WebAuthRequirement::ApiKey,
        context: WebContextKind::GooglePse,
    },
    WebProviderDescriptor {
        kind: WebProviderKind::SearchApi,
        provider_id: "searchapi",
        label: "SearchAPI",
        operations: SEARCH,
        formats: NO_FORMATS,
        auth: WebAuthRequirement::ApiKey,
        context: WebContextKind::SearchApi,
    },
    WebProviderDescriptor {
        kind: WebProviderKind::Firecrawl,
        provider_id: "firecrawl",
        label: "Firecrawl",
        operations: FETCH,
        formats: MARKDOWN,
        auth: WebAuthRequirement::ApiKey,
        context: WebContextKind::Default,
    },
    WebProviderDescriptor {
        kind: WebProviderKind::JinaReader,
        provider_id: "jina-reader",
        label: "Jina Reader",
        operations: FETCH,
        formats: MARKDOWN,
        auth: WebAuthRequirement::ApiKeyOrExplicitAnonymous,
        context: WebContextKind::Default,
    },
];

impl WebProviderKind {
    pub fn descriptor(self) -> &'static WebProviderDescriptor {
        // Each enum variant has exactly one row; the exhaustive inventory test
        // below makes missing/duplicate rows an explicit contract failure.
        WEB_PROVIDERS
            .iter()
            .find(|row| row.kind == self)
            .expect("web provider inventory")
    }
}

pub fn web_provider_by_id(id: &str) -> Option<&'static WebProviderDescriptor> {
    WEB_PROVIDERS.iter().find(|row| row.provider_id == id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchApiEngine {
    Google,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WebAccountContext {
    Default,
    GooglePse {
        engine_id: String,
        existing_customer_acknowledged: bool,
    },
    SearchApi {
        engine: SearchApiEngine,
    },
}

impl Default for WebAccountContext {
    fn default() -> Self {
        Self::Default
    }
}

impl<'de> Deserialize<'de> for WebAccountContext {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Empty struct closes Serde's extra-field loophole for tagged unit values.
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
        enum Wire {
            Default {},
            GooglePse {
                engine_id: String,
                #[serde(default)]
                existing_customer_acknowledged: bool,
            },
            SearchApi {
                engine: SearchApiEngine,
            },
        }
        let context = match Wire::deserialize(deserializer)? {
            Wire::Default {} => Self::Default,
            Wire::GooglePse {
                engine_id,
                existing_customer_acknowledged,
            } => Self::GooglePse {
                engine_id,
                existing_customer_acknowledged,
            },
            Wire::SearchApi { engine } => Self::SearchApi { engine },
        };
        context.normalized().map_err(serde::de::Error::custom)
    }
}

impl fmt::Debug for WebAccountContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Default => f.write_str("Default"),
            Self::GooglePse {
                existing_customer_acknowledged,
                ..
            } => f
                .debug_struct("GooglePse")
                .field("engine_id", &"REDACTED")
                .field(
                    "existing_customer_acknowledged",
                    existing_customer_acknowledged,
                )
                .finish(),
            Self::SearchApi { engine } => {
                f.debug_struct("SearchApi").field("engine", engine).finish()
            }
        }
    }
}

impl WebAccountContext {
    pub fn kind(&self) -> WebContextKind {
        match self {
            Self::Default => WebContextKind::Default,
            Self::GooglePse { .. } => WebContextKind::GooglePse,
            Self::SearchApi { .. } => WebContextKind::SearchApi,
        }
    }

    pub fn normalized(&self) -> Result<Self, WebConfigError> {
        match self {
            Self::GooglePse {
                engine_id,
                existing_customer_acknowledged,
            } => {
                let engine_id = engine_id.trim();
                // Legacy Google IDs commonly contain a colon. This is an ID,
                // never a URL/path. Preserve case; encode it as a query value.
                if engine_id.is_empty()
                    || engine_id.len() > MAX_GOOGLE_ENGINE_ID_BYTES
                    || !engine_id.bytes().all(|value| {
                        value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b'.' | b':')
                    })
                {
                    return Err(WebConfigError::InvalidEngineId);
                }
                Ok(Self::GooglePse {
                    engine_id: engine_id.to_owned(),
                    existing_customer_acknowledged: *existing_customer_acknowledged,
                })
            }
            other => Ok(other.clone()),
        }
    }
}

/// Private authored custody: Serialize is for the protected config writer only.
/// Status surfaces must use safe_metadata(), never serialize this account.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct WebAccountConfig {
    api_key: String,
    context: WebAccountContext,
}

impl<'de> Deserialize<'de> for WebAccountConfig {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            api_key: String,
            #[serde(default)]
            context: WebAccountContext,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.api_key, wire.context).map_err(serde::de::Error::custom)
    }
}

impl fmt::Debug for WebAccountConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WebAccountConfig")
            .field("api_key", &"REDACTED")
            .field("context", &self.context)
            .finish()
    }
}

impl WebAccountConfig {
    pub fn new(api_key: String, context: WebAccountContext) -> Result<Self, WebConfigError> {
        if api_key.is_empty()
            || api_key.len() > MAX_WEB_API_KEY_BYTES
            || !api_key.bytes().all(|value| value.is_ascii_graphic())
        {
            return Err(WebConfigError::InvalidCredential);
        }
        Ok(Self {
            api_key,
            context: context.normalized()?,
        })
    }

    /// Only provider construction and protected authored writing need material.
    pub fn api_key(&self) -> &str {
        &self.api_key
    }
    pub fn context(&self) -> &WebAccountContext {
        &self.context
    }

    pub fn validate_for(&self, kind: WebProviderKind) -> Result<(), WebConfigError> {
        if self.context.kind() == kind.descriptor().context {
            Ok(())
        } else {
            Err(WebConfigError::ContextMismatch)
        }
    }

    /// Context-qualified identity; existing native/SDK account hashes are untouched.
    pub fn account_id(&self, kind: WebProviderKind) -> Result<String, WebConfigError> {
        self.validate_for(kind)?;
        fn field(hash: &mut Sha256, value: &[u8]) {
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value);
        }
        let mut hash = Sha256::new();
        field(&mut hash, b"ryu-web-provider-account-v1");
        field(&mut hash, kind.descriptor().provider_id.as_bytes());
        field(&mut hash, self.api_key.as_bytes());
        match &self.context {
            WebAccountContext::Default => field(&mut hash, b"default"),
            WebAccountContext::GooglePse { engine_id, .. } => {
                field(&mut hash, b"google_pse");
                field(&mut hash, engine_id.as_bytes());
            }
            WebAccountContext::SearchApi {
                engine: SearchApiEngine::Google,
            } => {
                field(&mut hash, b"search_api");
                field(&mut hash, b"google");
            }
        }
        Ok(format!("{:x}", hash.finalize()))
    }

    pub fn safe_metadata(
        &self,
        kind: WebProviderKind,
        now_unix_seconds: u64,
    ) -> Result<WebAccountMetadata, WebConfigError> {
        Ok(WebAccountMetadata {
            account_id: self.account_id(kind)?,
            context_kind: self.context.kind(),
            diagnostic: self.eligibility_diagnostic(now_unix_seconds),
        })
    }

    /// Config validity never establishes vendor eligibility or credential validity.
    pub fn eligibility_diagnostic(
        &self,
        now_unix_seconds: u64,
    ) -> Option<WebEligibilityDiagnostic> {
        match &self.context {
            WebAccountContext::GooglePse { .. }
                if now_unix_seconds >= GOOGLE_PSE_SUNSET_UNIX_SECONDS =>
            {
                Some(WebEligibilityDiagnostic::GooglePseDiscontinued)
            }
            WebAccountContext::GooglePse {
                existing_customer_acknowledged: false,
                ..
            } => Some(WebEligibilityDiagnostic::ExistingCustomerRequired),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WebAccountMetadata {
    pub account_id: String,
    pub context_kind: WebContextKind,
    pub diagnostic: Option<WebEligibilityDiagnostic>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WebEligibilityDiagnostic {
    ExistingCustomerRequired,
    GooglePseDiscontinued,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum WebProviderConfig {
    Accounts { accounts: Vec<WebAccountConfig> },
    Anonymous {},
}

impl fmt::Debug for WebProviderConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Accounts { accounts } => f
                .debug_struct("Accounts")
                .field("account_count", &accounts.len())
                .finish(),
            Self::Anonymous {} => f.write_str("Anonymous"),
        }
    }
}

impl WebProviderConfig {
    pub fn new_accounts(
        kind: WebProviderKind,
        accounts: Vec<WebAccountConfig>,
    ) -> Result<Self, WebConfigError> {
        let config = Self::Accounts { accounts };
        config.validate_for(kind)?;
        Ok(config)
    }

    pub fn anonymous(kind: WebProviderKind) -> Result<Self, WebConfigError> {
        let config = Self::Anonymous {};
        config.validate_for(kind)?;
        Ok(config)
    }

    /// Safe status projection. Callers still distinguish configured from live-applied.
    pub fn safe_account_metadata(
        &self,
        kind: WebProviderKind,
        now_unix_seconds: u64,
    ) -> Result<Vec<WebAccountMetadata>, WebConfigError> {
        self.validate_for(kind)?;
        self.accounts()
            .iter()
            .map(|account| account.safe_metadata(kind, now_unix_seconds))
            .collect()
    }

    /// Called with the parsed map key at the authored configuration boundary.
    /// Duplicate key/context rows are rejected; keys across engines remain distinct.
    pub fn validate_for(&self, kind: WebProviderKind) -> Result<(), WebConfigError> {
        match self {
            Self::Anonymous {} if kind == WebProviderKind::JinaReader => Ok(()),
            Self::Anonymous {} => Err(WebConfigError::AnonymousNotSupported),
            Self::Accounts { accounts } => {
                if accounts.is_empty() || accounts.len() > MAX_WEB_ACCOUNTS {
                    return Err(WebConfigError::AccountCount);
                }
                let mut ids = HashSet::new();
                for account in accounts {
                    if !ids.insert(account.account_id(kind)?) {
                        return Err(WebConfigError::DuplicateAccount);
                    }
                }
                Ok(())
            }
        }
    }

    pub fn accounts(&self) -> &[WebAccountConfig] {
        match self {
            Self::Accounts { accounts } => accounts,
            Self::Anonymous {} => &[],
        }
    }
    pub fn is_anonymous(&self) -> bool {
        matches!(self, Self::Anonymous {})
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebConfigError {
    InvalidCredential,
    InvalidEngineId,
    ContextMismatch,
    AnonymousNotSupported,
    AccountCount,
    DuplicateAccount,
}

impl fmt::Display for WebConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidCredential => {
                "web API key must contain 1–4096 printable ASCII bytes without whitespace"
            }
            Self::InvalidEngineId => "Google search engine ID must contain 1–256 identifier bytes",
            Self::ContextMismatch => "web account context does not match its provider",
            Self::AnonymousNotSupported => {
                "anonymous web service configuration is only supported by Jina Reader"
            }
            Self::AccountCount => "web provider needs 1–32 accounts",
            Self::DuplicateAccount => "duplicate web credential and execution context",
        })
    }
}
impl std::error::Error for WebConfigError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn google(engine: &str, acknowledged: bool) -> WebAccountConfig {
        WebAccountConfig::new(
            "synthetic-key".into(),
            WebAccountContext::GooglePse {
                engine_id: engine.into(),
                existing_customer_acknowledged: acknowledged,
            },
        )
        .unwrap()
    }

    #[test]
    fn inventory_has_nine_search_and_four_fetch_contracts_without_inference_aliases() {
        let kinds = [
            WebProviderKind::Tavily,
            WebProviderKind::Brave,
            WebProviderKind::Serper,
            WebProviderKind::Exa,
            WebProviderKind::Linkup,
            WebProviderKind::Parallel,
            WebProviderKind::PerplexitySearch,
            WebProviderKind::GooglePse,
            WebProviderKind::SearchApi,
            WebProviderKind::Firecrawl,
            WebProviderKind::JinaReader,
        ];
        assert_eq!(WEB_PROVIDERS.len(), kinds.len());
        let mut ids = HashSet::new();
        for kind in kinds {
            let row = kind.descriptor();
            assert_eq!(
                WEB_PROVIDERS
                    .iter()
                    .filter(|other| other.kind == kind)
                    .count(),
                1
            );
            assert!(ids.insert(row.provider_id));
            assert_eq!(web_provider_by_id(row.provider_id), Some(row));
            assert_eq!(
                row.formats.is_empty(),
                !row.operations.contains(&WebOperation::Fetch)
            );
            assert_eq!(
                serde_json::from_value::<WebProviderKind>(json!(row.provider_id)).unwrap(),
                kind
            );
        }
        assert_eq!(
            WEB_PROVIDERS
                .iter()
                .filter(|row| row.operations.contains(&WebOperation::Search))
                .count(),
            9
        );
        assert_eq!(
            WEB_PROVIDERS
                .iter()
                .filter(|row| row.operations.contains(&WebOperation::Fetch))
                .count(),
            4
        );
        assert!(web_provider_by_id("jina").is_none());
        assert!(web_provider_by_id("perplexity").is_none());
        assert!(web_provider_by_id("openai").is_none());
    }

    #[test]
    fn formats_preserve_native_extraction_truth() {
        assert_eq!(WebProviderKind::Exa.descriptor().formats, TEXT);
        assert_eq!(WebProviderKind::Firecrawl.descriptor().formats, MARKDOWN);
        assert_eq!(WebProviderKind::JinaReader.descriptor().formats, MARKDOWN);
        assert_eq!(WebProviderKind::Tavily.descriptor().formats, MARKDOWN_TEXT);
    }

    #[test]
    fn google_identity_normalizes_context_but_excludes_acknowledgment() {
        let first = google(" 123:engine-one ", false);
        let acknowledged = google("123:engine-one", true);
        assert_eq!(
            first.account_id(WebProviderKind::GooglePse).unwrap(),
            "70aa4b161322345a9fdd5e7f658e0ae6ff1e1cafc1575f271d21872daa94ee2b"
        );
        assert_eq!(
            first.account_id(WebProviderKind::GooglePse).unwrap(),
            acknowledged.account_id(WebProviderKind::GooglePse).unwrap()
        );
        assert_ne!(
            first.account_id(WebProviderKind::GooglePse).unwrap(),
            google("123:engine-two", true)
                .account_id(WebProviderKind::GooglePse)
                .unwrap()
        );
        assert_ne!(
            google("Case", true)
                .account_id(WebProviderKind::GooglePse)
                .unwrap(),
            google("case", true)
                .account_id(WebProviderKind::GooglePse)
                .unwrap()
        );
        assert!(first.account_id(WebProviderKind::Tavily).is_err());
    }

    #[test]
    fn duplicate_detection_preserves_two_engines_with_one_key() {
        let first = google("engine-one", false);
        let second = google("engine-two", true);
        assert!(WebProviderConfig::Accounts {
            accounts: vec![first.clone(), second]
        }
        .validate_for(WebProviderKind::GooglePse)
        .is_ok());
        assert_eq!(
            WebProviderConfig::Accounts {
                accounts: vec![first, google("engine-one", true)]
            }
            .validate_for(WebProviderKind::GooglePse),
            Err(WebConfigError::DuplicateAccount)
        );
    }

    #[test]
    fn google_eligibility_is_clock_testable_and_not_a_constructor_gate() {
        let unacknowledged = google("engine", false);
        let acknowledged = google("engine", true);
        assert_eq!(
            unacknowledged.eligibility_diagnostic(GOOGLE_PSE_SUNSET_UNIX_SECONDS - 1),
            Some(WebEligibilityDiagnostic::ExistingCustomerRequired)
        );
        assert_eq!(
            acknowledged.eligibility_diagnostic(GOOGLE_PSE_SUNSET_UNIX_SECONDS - 1),
            None
        );
        for account in [unacknowledged, acknowledged] {
            assert_eq!(
                account.eligibility_diagnostic(GOOGLE_PSE_SUNSET_UNIX_SECONDS),
                Some(WebEligibilityDiagnostic::GooglePseDiscontinued)
            );
        }
    }

    #[test]
    fn anonymous_jina_is_explicit_and_never_creates_account_material() {
        let anonymous: WebProviderConfig =
            serde_json::from_value(json!({"mode":"anonymous"})).unwrap();
        assert!(anonymous.validate_for(WebProviderKind::JinaReader).is_ok());
        assert!(anonymous.is_anonymous());
        assert!(anonymous.accounts().is_empty());
        assert_eq!(
            anonymous.validate_for(WebProviderKind::Tavily),
            Err(WebConfigError::AnonymousNotSupported)
        );
        assert_eq!(
            WebProviderConfig::Accounts { accounts: vec![] }
                .validate_for(WebProviderKind::JinaReader),
            Err(WebConfigError::AccountCount)
        );
        for wire in [
            json!({"mode":"anonymous","accounts":[]}),
            json!({"mode":"anonymous","api_key":"synthetic-key"}),
            json!({}),
            json!({"mode":"oauth"}),
        ] {
            assert!(serde_json::from_value::<WebProviderConfig>(wire).is_err());
        }
    }

    #[test]
    fn credential_and_context_limits_reject_unsafe_material_without_echoing_it() {
        for key in [
            String::new(),
            " ".into(),
            "key\r\nheader".into(),
            "key with space".into(),
            "é".into(),
            "x".repeat(MAX_WEB_API_KEY_BYTES + 1),
        ] {
            let error = WebAccountConfig::new(key, WebAccountContext::Default).unwrap_err();
            assert_eq!(error, WebConfigError::InvalidCredential);
            assert!(!error.to_string().contains("header"));
        }
        assert!(WebAccountConfig::new(
            "x".repeat(MAX_WEB_API_KEY_BYTES),
            WebAccountContext::Default
        )
        .is_ok());
        for engine in [
            String::new(),
            "https://engine".into(),
            "engine?key=secret".into(),
            "engine/path".into(),
            "engine with space".into(),
            "x".repeat(MAX_GOOGLE_ENGINE_ID_BYTES + 1),
        ] {
            assert_eq!(
                WebAccountConfig::new(
                    "synthetic-key".into(),
                    WebAccountContext::GooglePse {
                        engine_id: engine,
                        existing_customer_acknowledged: false
                    }
                )
                .unwrap_err(),
                WebConfigError::InvalidEngineId
            );
        }
        assert!(google(&"x".repeat(MAX_GOOGLE_ENGINE_ID_BYTES), false)
            .account_id(WebProviderKind::GooglePse)
            .is_ok());
    }

    #[test]
    fn safe_metadata_and_debug_omit_key_and_engine_but_private_config_roundtrips() {
        let account = google("private-engine", true);
        let metadata = serde_json::to_value(
            account
                .safe_metadata(WebProviderKind::GooglePse, 0)
                .unwrap(),
        )
        .unwrap()
        .to_string();
        let debug = format!(
            "{account:?} {:?}",
            WebProviderConfig::Accounts {
                accounts: vec![account.clone()]
            }
        );
        for value in [metadata, debug] {
            assert!(!value.contains("synthetic-key"));
            assert!(!value.contains("private-engine"));
        }
        assert_eq!(
            serde_json::from_value::<WebAccountConfig>(serde_json::to_value(&account).unwrap())
                .unwrap(),
            account
        );
    }

    #[test]
    fn context_deserialization_rejects_unknown_and_wrong_shapes() {
        for wire in [
            json!({"kind":"default","api_key":"synthetic"}),
            json!({"kind":"google_pse","engine_id":"valid","url":"https://secret"}),
            json!({"kind":"google_pse"}),
            json!({"kind":"search_api","engine":"bing"}),
            json!({"kind":"oauth"}),
        ] {
            assert!(serde_json::from_value::<WebAccountContext>(wire).is_err());
        }
        let account: WebAccountConfig = serde_json::from_value(json!({"api_key":"synthetic-key","context":{"kind":"google_pse","engine_id":" engine "}})).unwrap();
        assert_eq!(
            account.eligibility_diagnostic(0),
            Some(WebEligibilityDiagnostic::ExistingCustomerRequired)
        );
        assert!(WebProviderConfig::Accounts {
            accounts: vec![account]
        }
        .validate_for(WebProviderKind::GooglePse)
        .is_ok());
    }

    #[test]
    fn account_count_kind_and_domain_separation_are_enforced() {
        let account =
            WebAccountConfig::new("synthetic-key".into(), WebAccountContext::Default).unwrap();
        assert_ne!(
            account.account_id(WebProviderKind::Tavily).unwrap(),
            account.account_id(WebProviderKind::Brave).unwrap()
        );
        assert_ne!(
            account.account_id(WebProviderKind::Tavily).unwrap(),
            crate::provider_account_id("tavily", "synthetic-key")
        );
        assert!(account.validate_for(WebProviderKind::GooglePse).is_err());
        let accounts = (0..MAX_WEB_ACCOUNTS)
            .map(|index| {
                WebAccountConfig::new(format!("key-{index}"), WebAccountContext::Default).unwrap()
            })
            .collect::<Vec<_>>();
        assert!(WebProviderConfig::Accounts {
            accounts: accounts.clone()
        }
        .validate_for(WebProviderKind::Tavily)
        .is_ok());
        let mut excess = accounts;
        excess.push(account);
        assert_eq!(
            WebProviderConfig::Accounts { accounts: excess }.validate_for(WebProviderKind::Tavily),
            Err(WebConfigError::AccountCount)
        );
    }
}

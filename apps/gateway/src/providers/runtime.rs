//! Coherent provider generations. Requests clone one snapshot before routing.
//! Secrets remain private runtime custody; publication never recreates wallets,
//! auth, reservations, accepted jobs or budgets.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::sync::{Arc, RwLock};

use ryu_gw_credentials::ConfigRevision;
pub use ryu_gw_credentials::ProviderRuntimeEpoch as ProviderEpoch;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{Provider, ProviderRegistry};
use crate::config::{
    EgressConfig, GatewayConfig, ProviderEnvironment, ProviderId, ProvidersConfig, RoutingConfig,
};
use crate::egress::EgressPools;
use crate::error::GatewayError;
use crate::provider_pools::ProviderPools;
use crate::quota::ProviderQuotas;
use crate::router::{RouteDecision, RouterRegistry};
use crate::web_config::{BoundWebPrice, WebPricingSnapshot, WebServicePrices};
use crate::web_pools::WebServicePools;
use ryu_gw_credentials::web::{
    web_provider_by_id, WebContentFormat, WebOperation, WebProviderKind,
};

pub struct ProviderRuntime {
    current: Arc<RwLock<Arc<ProviderSnapshot>>>,
    /// All configuration mutations/application attempts share this serializer.
    pub(crate) config_update: tokio::sync::Mutex<()>,
    #[cfg(test)]
    test_environment: Arc<std::sync::Mutex<Option<ProviderEnvironment>>>,
    #[cfg(test)]
    test_pause: tokio::sync::Mutex<Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
}

/// Immutable provider policy, context, routing and readiness publication.
/// Interior pool health belongs exclusively to this generation.
pub struct ProviderSnapshot {
    pub epoch: ProviderEpoch,
    pub authored_revision: Option<ConfigRevision>,
    pub providers: ProviderRegistry,
    pub router: Arc<RouterRegistry>,
    pub provider_pools: ProviderPools,
    pub web_pools: WebServicePools,
    pub web_pricing: WebPricingSnapshot,
    pub config: ProvidersConfig,
    pub routing: RoutingConfig,
    pub quota: CurrentProviderQuotas,
    pub(crate) models_cache: crate::api::models::ModelCache,
    egress: Arc<EgressPools>,
    egress_config: EgressConfig,
    environment: BTreeMap<String, String>,
    entry_identities: HashMap<String, [u8; 32]>,
    inputs: ProviderInputs,
    native_sources: HashMap<String, &'static str>,
}

/// Explicit runtime custody. No serialization or material-revealing Debug.
#[derive(Clone, Default)]
pub(crate) struct ProviderInputs {
    environment: ProviderEnvironment,
    fleet: Option<Arc<crate::provider_vault::VaultSourceSnapshot>>,
}

impl ProviderInputs {
    pub(crate) fn from_loaded(config: &GatewayConfig) -> Self {
        Self {
            environment: config.provider_environment.clone().unwrap_or_default(),
            fleet: config.provider_vault_source.clone(),
        }
    }

    fn identity(&self) -> [u8; 32] {
        let mut hash = Sha256::new();
        hash.update(self.environment.identity());
        if let Some(fleet) = &self.fleet {
            hash.update([1]);
            hash.update(fleet.identity());
        } else {
            hash.update([0]);
        }
        hash.finalize().into()
    }

    fn native_sources(
        &self,
        config: &ProvidersConfig,
        applied_scopes: Option<&[String]>,
    ) -> HashMap<String, &'static str> {
        let mut sources = self.environment.native_sources(config);
        let scopes =
            applied_scopes.or_else(|| self.fleet.as_ref().map(|fleet| fleet.applied_scopes()));
        for scope in scopes.into_iter().flatten() {
            sources.insert(scope.clone(), "fleet");
        }
        sources
    }

    /// Pure validation against the guarded authored value and captured custody.
    /// It constructs no clients/providers and performs no network operations.
    pub(crate) fn validate_policies(
        &self,
        mut authored: GatewayConfig,
        updates: &ryu_gw_credentials::ProviderAccountPolicies,
        revision: &ConfigRevision,
    ) -> Result<ryu_gw_credentials::ProviderAccountPolicies, GatewayError> {
        self.environment
            .apply(&mut authored)
            .map_err(GatewayError::BadRequest)?;
        if let Some(fleet) = &self.fleet {
            fleet.apply(&mut authored, &self.environment).map_err(|_| {
                GatewayError::BadRequest(
                    "Captured fleet provider configuration is invalid".to_owned(),
                )
            })?;
        }
        let count: usize = updates.values().map(HashMap::len).sum();
        if count == 0 || count > 128 {
            return Err(GatewayError::BadRequest(
                "Update between 1 and 128 provider accounts per request".to_owned(),
            ));
        }
        let mut normalized = HashMap::new();
        for (scope, policies) in updates {
            let descriptor = if scope == "gemini" {
                ryu_gw_credentials::sdk_provider_by_kind("gemini")
            } else {
                ryu_gw_credentials::sdk_provider_by_id(scope)
                    .filter(|descriptor| descriptor.account_scope == scope)
            };
            if let Some(web) = web_provider_by_id(scope) {
                let connection = authored
                    .providers
                    .web
                    .get(&web.kind)
                    .ok_or_else(|| GatewayError::ConfigConflict(revision.clone()))?;
                let ids = connection
                    .accounts()
                    .iter()
                    .map(|row| row.account_id(web.kind))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| {
                        GatewayError::BadRequest("Invalid web account context".to_owned())
                    })?;
                let mut entries = HashMap::new();
                for (id, policy) in policies {
                    if !ids.contains(id) {
                        return Err(GatewayError::ConfigConflict(revision.clone()));
                    }
                    entries.insert(
                        id.clone(),
                        policy.normalized().map_err(GatewayError::BadRequest)?,
                    );
                }
                normalized.insert(scope.clone(), entries);
                continue;
            }
            let keys = if let Some(descriptor) = descriptor {
                match authored.providers.genai.as_ref() {
                    Some(sdk) => sdk
                        .resolve_keys(descriptor.kind, self.environment.values())
                        .map_err(GatewayError::BadRequest)?
                        .into_iter()
                        .map(|entry| entry.key)
                        .collect(),
                    None => Vec::new(),
                }
            } else {
                authored.providers.account_keys(scope)
            };
            let ids: Vec<_> = keys
                .iter()
                .map(|key| ryu_gw_credentials::provider_account_id(scope, key))
                .collect();
            if ids.is_empty() {
                return Err(GatewayError::ConfigConflict(revision.clone()));
            }
            let mut entries = HashMap::new();
            for (id, policy) in policies {
                if !ids.contains(id) {
                    return Err(GatewayError::ConfigConflict(revision.clone()));
                }
                entries.insert(
                    id.clone(),
                    policy.normalized().map_err(GatewayError::BadRequest)?,
                );
            }
            normalized.insert(scope.clone(), entries);
        }
        Ok(normalized)
    }
}

/// Current executable entries may share an original sink, but changed entries
/// never read rows from the old credential generation's feedback sink.
pub struct CurrentProviderQuotas {
    sources: HashMap<String, Arc<ProviderQuotas>>,
}

impl CurrentProviderQuotas {
    pub fn observation(&self, provider: &str) -> Option<ryu_gw_providers::quota::QuotaObservation> {
        self.sources.get(provider)?.observation(provider)
    }
    pub fn snapshot(&self) -> serde_json::Value {
        let mut result = serde_json::Map::new();
        for (provider, source) in &self.sources {
            if let Some(row) = source.snapshot().get(provider) {
                result.insert(provider.clone(), row.clone());
            }
        }
        serde_json::Value::Object(result)
    }

    #[cfg(test)]
    pub fn record_success(&self, provider: &str, info: &ryu_gw_providers::RateLimitInfo) {
        if let Some(source) = self.sources.get(provider) {
            source.record_success(provider, info);
        }
    }

    #[cfg(test)]
    pub fn record_rate_limited(
        &self,
        provider: &str,
        retry_after: Option<u64>,
        reset_at: Option<u64>,
    ) {
        if let Some(source) = self.sources.get(provider) {
            source.record_rate_limited(provider, retry_after, reset_at);
        }
    }
}

fn entry_identities(
    config: &ProvidersConfig,
    registry: &ProviderRegistry,
    egress: &EgressPools,
    environment: &BTreeMap<String, String>,
) -> HashMap<String, [u8; 32]> {
    // Serialization is used only inside this function, never logged or retained.
    let serialized = serde_json::to_value(config).expect("provider config serialization");
    registry
        .available_providers()
        .into_iter()
        .map(|id| {
            let mut digest = Sha256::new();
            let account_scope;
            if let Some(web) = web_provider_by_id(&id) {
                account_scope = web.provider_id;
                digest.update(
                    serde_json::to_vec(&config.web.get(&web.kind))
                        .expect("web provider serialization"),
                );
            } else if let Some(descriptor) = ryu_gw_credentials::sdk_provider_by_id(&id) {
                account_scope = descriptor.account_scope;
                let sdk = config.genai.as_ref().expect("registered SDK config");
                let account = sdk
                    .accounts
                    .get(descriptor.kind)
                    .expect("registered SDK kind");
                digest.update(serde_json::to_vec(account).expect("SDK config serialization"));
                // Serde skips fleet provenance: include resolved material/source explicitly.
                for entry in sdk
                    .resolve_keys(descriptor.kind, environment)
                    .unwrap_or_default()
                {
                    digest.update(entry.key.len().to_be_bytes());
                    digest.update(entry.key.as_bytes());
                    digest.update([match entry.source {
                        crate::config::SdkKeySource::Stored => 0,
                        crate::config::SdkKeySource::Environment => 1,
                        crate::config::SdkKeySource::Fleet => 2,
                    }]);
                }
            } else {
                account_scope = id.as_str();
                let field = id.replace('-', "_");
                let settings = serialized
                    .get(&field)
                    .or_else(|| {
                        serialized
                            .get("compatible")
                            .and_then(|compatible| compatible.get(&id))
                    })
                    .unwrap_or(&serde_json::Value::Null);
                digest
                    .update(serde_json::to_vec(settings).expect("provider settings serialization"));
            }
            if let Some(policies) = config.account_policies.get(account_scope) {
                // Stable order avoids spurious pool rebuilds from HashMap iteration.
                let ordered: BTreeMap<_, _> = policies.iter().collect();
                digest.update(serde_json::to_vec(&ordered).expect("account policy serialization"));
            }
            // Strategy and drain threshold are applied only when a provider is built,
            // so a change must rebuild it. The tag byte keeps "absent" (the defaults)
            // distinct from any explicit value, so clearing an entry rebuilds too.
            match config.account_strategies.get(account_scope) {
                Some(strategy) => {
                    digest.update([1]);
                    digest.update(
                        serde_json::to_vec(strategy).expect("account strategy serialization"),
                    );
                }
                None => digest.update([0]),
            }
            match config.account_drain_thresholds.get(account_scope) {
                Some(percent) => digest.update([1, *percent]),
                None => digest.update([0]),
            }
            if let Some((name, fingerprint)) = egress.assignment_identity(&id) {
                digest.update(name.len().to_be_bytes());
                digest.update(name.as_bytes());
                digest.update(fingerprint);
            } else {
                // Ambient proxy changes also change the executable transport.
                for name in [
                    "HTTP_PROXY",
                    "HTTPS_PROXY",
                    "ALL_PROXY",
                    "NO_PROXY",
                    "http_proxy",
                    "https_proxy",
                    "all_proxy",
                    "no_proxy",
                ] {
                    let value = std::env::var(name).unwrap_or_default();
                    digest.update(value.len().to_be_bytes());
                    digest.update(value.as_bytes());
                }
            }
            (id, digest.finalize().into())
        })
        .collect()
}

impl fmt::Debug for ProviderSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderSnapshot")
            .field("epoch", &self.epoch)
            .field(
                "provider_count",
                &self.providers.available_providers().len(),
            )
            .finish_non_exhaustive()
    }
}

/// Actual canonical owner and governed metadata, bound to one snapshot.
pub struct BoundRoute {
    pub provider_id: ProviderId,
    pub model: String,
    pub provider: Arc<dyn Provider>,
    pub region: Option<String>,
    pub epoch: ProviderEpoch,
    pub cache_allowed: bool,
}

pub struct BoundWebRoute {
    pub kind: WebProviderKind,
    pub operation: WebOperation,
    pub provider: Arc<dyn Provider>,
    pub region: Option<String>,
    pub epoch: ProviderEpoch,
    pub price: Option<BoundWebPrice>,
}

impl ProviderSnapshot {
    pub fn bind_web(
        &self,
        kind: WebProviderKind,
        operation: WebOperation,
        format: Option<WebContentFormat>,
        now: u64,
    ) -> Result<BoundWebRoute, GatewayError> {
        let descriptor = kind.descriptor();
        if !descriptor.operations.contains(&operation)
            || format.is_some_and(|format| {
                operation != WebOperation::Fetch || !descriptor.formats.contains(&format)
            })
        {
            return Err(GatewayError::BadRequest(
                "Web provider does not support the requested operation or format".to_owned(),
            ));
        }
        let connection = self.config.web.get(&kind).ok_or_else(|| {
            GatewayError::ProviderError("Web provider is not configured".to_owned())
        })?;
        if !connection.is_anonymous()
            && !connection.accounts().iter().any(|row| {
                row.eligibility_diagnostic(now).is_none()
                    && row.account_id(kind).ok().is_some_and(|id| {
                        self.config
                            .account_policies
                            .get(descriptor.provider_id)
                            .and_then(|policies| policies.get(&id))
                            .is_none_or(|policy| policy.enabled)
                    })
            })
        {
            return Err(GatewayError::ProviderError(
                "Web provider has no eligible accounts".to_owned(),
            ));
        }
        let provider = self
            .providers
            .get_owned(descriptor.provider_id)
            .filter(|provider| {
                provider
                    .web_descriptor()
                    .is_some_and(|actual| actual.kind == kind)
            })
            .ok_or_else(|| GatewayError::ProviderError("Web provider is not active".to_owned()))?;
        Ok(BoundWebRoute {
            kind,
            operation,
            provider,
            region: self.providers.region_for(descriptor.provider_id),
            epoch: self.epoch,
            price: self.web_pricing.quote(kind, operation),
        })
    }
    pub fn bind(&self, decision: &RouteDecision) -> Result<BoundRoute, GatewayError> {
        let provider_id =
            if ryu_gw_credentials::sdk_provider_by_id(decision.provider.as_str()).is_some() {
                self.providers
                    .canonicalize_sdk_route(decision.provider.as_str(), &decision.model)
                    .map(ProviderId::from)
                    .ok_or_else(|| {
                        GatewayError::BadRequest(
                            "SDK connection is inactive or model belongs to another connection"
                                .to_owned(),
                        )
                    })?
            } else {
                decision.provider.clone()
            };
        let provider = self
            .providers
            .get_owned(provider_id.as_str())
            .ok_or_else(|| {
                GatewayError::BadRequest("Provider connection is not configured".to_owned())
            })?;
        Ok(BoundRoute {
            region: self.providers.region_for(provider_id.as_str()),
            cache_allowed: !provider.has_rotating_accounts(),
            provider_id,
            model: decision.model.clone(),
            provider,
            epoch: self.epoch,
        })
    }

    pub(crate) fn safe_provider_view(&self) -> crate::api::config::ProvidersView {
        crate::api::config::redact_snapshot_providers(
            &self.config,
            &self.environment,
            &self.providers,
            &self.native_sources,
        )
    }

    /// The egress proxy configuration this snapshot was built from. Read by
    /// the egress posture report, which needs pool shape but never a value
    /// from the environment.
    pub(crate) fn egress_config(&self) -> &EgressConfig {
        &self.egress_config
    }
}

impl ProviderRuntime {
    pub(crate) fn from_parts(
        config: ProvidersConfig,
        routing: RoutingConfig,
        egress_config: EgressConfig,
        environment: BTreeMap<String, String>,
        providers: ProviderRegistry,
        router: RouterRegistry,
        provider_pools: ProviderPools,
        egress: EgressPools,
        quota: Arc<ProviderQuotas>,
        inputs: ProviderInputs,
        web_pricing: WebPricingSnapshot,
    ) -> Self {
        let web_pools = WebServicePools::new(&routing).expect("validated web service pools");
        let native_sources = inputs.native_sources(&config, None);
        let entry_identities = entry_identities(&config, &providers, &egress, &environment);
        let sources = providers
            .available_providers()
            .into_iter()
            .map(|id| (id, Arc::clone(&quota)))
            .collect();
        router.set_registered_providers(providers.available_providers());
        Self {
            current: Arc::new(RwLock::new(Arc::new(ProviderSnapshot {
                epoch: ProviderEpoch {
                    boot: Uuid::new_v4(),
                    sequence: 0,
                },
                authored_revision: None,
                providers,
                router: Arc::new(router),
                provider_pools,
                web_pools,
                web_pricing,
                config,
                routing,
                quota: CurrentProviderQuotas { sources },
                models_cache: Default::default(),
                egress: Arc::new(egress),
                egress_config,
                environment,
                entry_identities,
                inputs,
                native_sources,
            }))),
            config_update: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            test_environment: Arc::new(std::sync::Mutex::new(None)),
            #[cfg(test)]
            test_pause: tokio::sync::Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> Arc<ProviderSnapshot> {
        Arc::clone(&self.current.read().expect("provider runtime lock"))
    }

    pub(crate) fn capture_policy_inputs(&self) -> ProviderInputs {
        let snapshot = self.snapshot();
        ProviderInputs {
            environment: self.capture_environment(&snapshot.egress_config),
            fleet: snapshot.inputs.fleet.clone(),
        }
    }

    fn capture_environment(&self, egress: &EgressConfig) -> ProviderEnvironment {
        #[cfg(test)]
        if let Some(environment) = self
            .test_environment
            .lock()
            .expect("test source lock")
            .clone()
        {
            return environment;
        }
        ProviderEnvironment::capture(egress)
    }

    #[cfg(test)]
    pub(crate) fn set_environment_for_test(&self, environment: ProviderEnvironment) {
        *self.test_environment.lock().expect("test source lock") = Some(environment);
    }

    /// Revision-only application; no authored-file guard crosses network/audit.
    pub(crate) async fn apply_revision(
        &self,
        path: std::path::PathBuf,
        requested: ConfigRevision,
    ) -> ryu_gw_credentials::ProviderApplyOutcome {
        let _application = self.config_update.lock().await;
        self.apply_revision_locked(path, requested).await
    }

    /// Config PUT already holds the application serializer.
    pub(crate) async fn apply_revision_locked(
        &self,
        path: std::path::PathBuf,
        requested: ConfigRevision,
    ) -> ryu_gw_credentials::ProviderApplyOutcome {
        use ryu_gw_credentials::{ProviderApplyErrorCode as Code, ProviderApplyOutcome as Outcome};
        let failure = |code| Outcome::Failed {
            requested_revision: requested.clone(),
            active_revision: self.snapshot().authored_revision.clone(),
            code,
        };
        let read_path = path.clone();
        let captured = tokio::task::spawn_blocking(move || {
            let guard = ryu_gw_credentials::ConfigFileTransaction::acquire(&read_path)?;
            let snapshot = guard.snapshot();
            Ok::<_, ryu_gw_credentials::ConfigCommitError>((
                snapshot.bytes().to_vec(),
                snapshot.revision().clone(),
                snapshot.exists(),
            ))
        })
        .await;
        let (bytes, revision, exists) = match captured {
            Ok(Ok(captured)) => captured,
            _ => return failure(Code::ConfigUnavailable),
        };
        if revision != requested {
            return Outcome::Superseded {
                requested_revision: requested,
                current_revision: revision,
            };
        }
        if !exists {
            return failure(Code::ConfigUnavailable);
        }
        let authored = std::str::from_utf8(&bytes)
            .ok()
            .and_then(|bytes| GatewayConfig::from_authored_str(bytes).ok());
        let Some(mut effective) = authored else {
            return failure(Code::InvalidConfig);
        };
        let original = self.snapshot();
        let inputs = ProviderInputs {
            environment: self.capture_environment(&effective.egress),
            fleet: original.inputs.fleet.clone(),
        };
        if inputs.environment.apply(&mut effective).is_err() {
            return failure(Code::InvalidConfig);
        }
        let scopes = match &inputs.fleet {
            Some(fleet) => match fleet.apply(&mut effective, &inputs.environment) {
                Ok(scopes) => Some(scopes),
                Err(_) => return failure(Code::InvalidConfig),
            },
            None => None,
        };
        let identity = inputs.identity();
        let candidate = if original.authored_revision.as_ref() == Some(&requested)
            && original.inputs.identity() == identity
        {
            None
        } else {
            match self.build_candidate_with_inputs(
                effective.providers,
                effective.routing,
                effective.egress.clone(),
                inputs.environment.values().clone(),
                Some(requested.clone()),
                inputs,
                scopes.as_deref(),
                Some(effective.credits.web_service_prices.clone()),
            ) {
                Ok(candidate) => Some(candidate),
                Err(_) => return failure(Code::InvalidConfig),
            }
        };
        let current = Arc::clone(&self.current);
        #[cfg(test)]
        if let Some((ready, resume)) = self.test_pause.lock().await.take() {
            ready.notify_one();
            resume.notified().await;
        }
        #[cfg(test)]
        let test_environment = Arc::clone(&self.test_environment);
        let final_requested = requested.clone();
        let egress = effective.egress;
        let result = tokio::task::spawn_blocking(move || {
            // This entire guarded section is synchronous: compare, capture
            // source identity, then publish one Arc. No HTTP/audit/process wait.
            let guard = match ryu_gw_credentials::ConfigFileTransaction::acquire(&path) {
                Ok(guard) => guard,
                Err(_) => return Err(Code::ConfigUnavailable),
            };
            let latest = guard.snapshot().revision().clone();
            if latest != final_requested {
                return Ok(Outcome::Superseded {
                    requested_revision: final_requested,
                    current_revision: latest,
                });
            }
            let active = Arc::clone(&current.read().expect("provider runtime lock"));
            let environment = ProviderEnvironment::capture(&egress);
            #[cfg(test)]
            let environment = test_environment
                .lock()
                .expect("test source lock")
                .clone()
                .unwrap_or(environment);
            let actual = ProviderInputs {
                environment,
                fleet: active.inputs.fleet.clone(),
            };
            if actual.identity() != identity {
                return Err(Code::SourcesChanged);
            }
            match candidate {
                Some(candidate) => {
                    let epoch = publish_candidate(&current, candidate)
                        .map_err(|_| Code::PublicationFailed)?;
                    Ok(Outcome::Applied {
                        requested_revision: final_requested.clone(),
                        applied_revision: final_requested,
                        epoch,
                    })
                }
                None => {
                    if active.authored_revision.as_ref() != Some(&final_requested)
                        || active.inputs.identity() != identity
                    {
                        return Err(Code::PublicationFailed);
                    }
                    Ok(Outcome::AlreadyApplied {
                        requested_revision: final_requested.clone(),
                        applied_revision: final_requested,
                        epoch: active.epoch,
                    })
                }
            }
        })
        .await;
        match result {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(code)) => failure(code),
            Err(_) => failure(Code::PublicationFailed),
        }
    }

    /// Build outside publication/file locks; callers coordinate revision checks.
    /// An error leaves the current generation entirely unchanged.
    pub(crate) fn build_candidate(
        &self,
        config: ProvidersConfig,
        routing: RoutingConfig,
        egress_config: EgressConfig,
        environment: BTreeMap<String, String>,
        authored_revision: Option<ConfigRevision>,
    ) -> Result<ProviderSnapshot, String> {
        let inputs = ProviderInputs {
            environment: ProviderEnvironment::from_values(environment.clone()),
            fleet: self.snapshot().inputs.fleet.clone(),
        };
        self.build_candidate_with_inputs(
            config,
            routing,
            egress_config,
            environment,
            authored_revision,
            inputs,
            None,
            None,
        )
    }

    fn build_candidate_with_inputs(
        &self,
        config: ProvidersConfig,
        routing: RoutingConfig,
        egress_config: EgressConfig,
        environment: BTreeMap<String, String>,
        authored_revision: Option<ConfigRevision>,
        inputs: ProviderInputs,
        applied_scopes: Option<&[String]>,
        web_prices: Option<WebServicePrices>,
    ) -> Result<ProviderSnapshot, String> {
        let previous = self.snapshot();
        for (kind, connection) in &config.web {
            connection
                .validate_for(*kind)
                .map_err(|_| "Invalid web provider configuration")?;
        }
        let web_pricing = previous
            .web_pricing
            .with_prices(web_prices.unwrap_or_else(|| previous.web_pricing.prices().clone()))?;
        if let Some(sdk) = &config.genai {
            for (kind, account) in &sdk.accounts {
                account.validate(kind)?;
            }
        }
        let native_sources = inputs.native_sources(&config, applied_scopes);
        let sequence = previous
            .epoch
            .sequence
            .checked_add(1)
            .ok_or("Provider generation limit reached")?;
        let egress = EgressPools::new_reusing_with_environment(
            &egress_config,
            Some(&previous.egress),
            inputs.environment.values(),
        )?;
        let quota = Arc::new(ProviderQuotas::new());
        // Custody is fixed for the process, so a rebuilt generation keeps the
        // custody the boot registry was built for (fleet-only slots stay put).
        let mut providers = ProviderRegistry::build_with_environment(
            &config,
            Some(&egress),
            Arc::clone(&quota),
            &environment,
            previous.providers.custody(),
        );
        let entry_identities = entry_identities(&config, &providers, &egress, &environment);
        let mut sources = HashMap::new();
        let mut unchanged_providers = std::collections::HashSet::new();
        for id in providers.available_providers() {
            let source = if previous.entry_identities.get(&id) == entry_identities.get(&id) {
                unchanged_providers.insert(id.clone());
                if let Some(provider) = previous.providers.get_owned(&id) {
                    providers.insert(id.clone(), provider);
                }
                if let Some(provider) = previous.providers.batch_provider_owned(&id) {
                    providers.batch_providers.insert(id.clone(), provider);
                }
                previous
                    .quota
                    .sources
                    .get(&id)
                    .map(Arc::clone)
                    .unwrap_or_else(|| Arc::clone(&quota))
            } else {
                Arc::clone(&quota)
            };
            sources.insert(id, source);
        }
        let routing_unchanged = serde_json::to_value(&routing)
            .map_err(|_| "routing configuration failed")?
            == serde_json::to_value(&previous.routing)
                .map_err(|_| "routing configuration failed")?;
        let router = if routing_unchanged {
            Arc::clone(&previous.router)
        } else {
            let router = RouterRegistry::new(routing.clone());
            if !router.set_active(&previous.router.active_id()) {
                return Err(
                    "Active router backend cannot be rebuilt for provider publication".to_owned(),
                );
            }
            Arc::new(router)
        };
        router.set_registered_providers(providers.available_providers());
        let provider_pools = ProviderPools::new_reusing(
            &routing,
            &previous.routing,
            &previous.provider_pools,
            &unchanged_providers,
        )?;
        let web_pools = WebServicePools::new_reusing(
            &routing,
            &previous.routing,
            &previous.web_pools,
            &unchanged_providers,
        )?;
        Ok(ProviderSnapshot {
            epoch: ProviderEpoch {
                boot: previous.epoch.boot,
                sequence,
            },
            authored_revision,
            providers,
            router,
            provider_pools,
            web_pools,
            web_pricing,
            config,
            routing,
            quota: CurrentProviderQuotas { sources },
            models_cache: Default::default(),
            egress: Arc::new(egress),
            egress_config,
            environment,
            entry_identities,
            inputs,
            native_sources,
        })
    }

    pub(crate) fn candidate_with_policies(
        &self,
        updates: &ryu_gw_credentials::ProviderAccountPolicies,
    ) -> Result<ProviderSnapshot, String> {
        let previous = self.snapshot();
        let normalized = previous
            .providers
            .validate_account_policy_updates(updates)?;
        let mut config = previous.config.clone();
        for (scope, policies) in normalized {
            config
                .account_policies
                .entry(scope)
                .or_default()
                .extend(policies);
        }
        self.build_candidate(
            config,
            previous.routing.clone(),
            previous.egress_config.clone(),
            previous.environment.clone(),
            previous.authored_revision.clone(),
        )
    }

    /// Caller must serialize candidate creation/revision validation/publication.
    pub(crate) fn publish(&self, candidate: ProviderSnapshot) -> Result<ProviderEpoch, String> {
        publish_candidate(&self.current, candidate)
    }

    /// Exclusive test setup only; cannot mutate a snapshot held by a request.
    #[cfg(test)]
    pub fn register_for_test(&mut self, provider: Arc<dyn Provider>) {
        let current = Arc::get_mut(&mut self.current)
            .expect("exclusive test runtime setup")
            .get_mut()
            .expect("provider runtime lock");
        let snapshot = Arc::get_mut(current).expect("register fixtures before capturing snapshots");
        snapshot
            .quota
            .sources
            .entry(provider.name().to_owned())
            .or_insert_with(|| Arc::new(ProviderQuotas::new()));
        snapshot.providers.register(provider);
        snapshot
            .router
            .set_registered_providers(snapshot.providers.available_providers());
    }

    #[cfg(test)]
    pub fn register_as_for_test(&mut self, id: &'static str, provider: Arc<dyn Provider>) {
        let current = Arc::get_mut(&mut self.current)
            .expect("exclusive test runtime setup")
            .get_mut()
            .expect("provider runtime lock");
        let snapshot = Arc::get_mut(current).expect("register fixtures before capturing snapshots");
        snapshot
            .quota
            .sources
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(ProviderQuotas::new()));
        snapshot.providers.register_as(id, provider);
        snapshot
            .router
            .set_registered_providers(snapshot.providers.available_providers());
    }

    /// Publish a replacement fixture while an older request holds its snapshot.
    /// Production application always uses authored/source-validated candidates.
    #[cfg(test)]
    pub(crate) fn publish_for_test(&self, provider: Arc<dyn Provider>) -> ProviderEpoch {
        let old = self.snapshot();
        let id = provider.name().to_owned();
        let mut providers = old.providers.clone_for_test();
        providers.register(provider);
        old.router
            .set_registered_providers(providers.available_providers());
        let mut sources = old.quota.sources.clone();
        sources.insert(id.clone(), Arc::new(ProviderQuotas::new()));
        let mut identities = old.entry_identities.clone();
        identities.remove(&id);
        self.publish(ProviderSnapshot {
            epoch: ProviderEpoch {
                boot: old.epoch.boot,
                sequence: old.epoch.sequence.checked_add(1).unwrap(),
            },
            authored_revision: None,
            providers,
            router: Arc::clone(&old.router),
            provider_pools: old.provider_pools.clone(),
            web_pools: old.web_pools.clone(),
            web_pricing: old.web_pricing.clone(),
            config: old.config.clone(),
            routing: old.routing.clone(),
            quota: CurrentProviderQuotas { sources },
            models_cache: Default::default(),
            egress: Arc::clone(&old.egress),
            egress_config: old.egress_config.clone(),
            environment: old.environment.clone(),
            entry_identities: identities,
            inputs: old.inputs.clone(),
            native_sources: old.native_sources.clone(),
        })
        .unwrap()
    }
}

fn publish_candidate(
    current: &RwLock<Arc<ProviderSnapshot>>,
    candidate: ProviderSnapshot,
) -> Result<ProviderEpoch, String> {
    let mut current = current.write().expect("provider runtime lock");
    if candidate.epoch.boot != current.epoch.boot
        || current.epoch.sequence.checked_add(1) != Some(candidate.epoch.sequence)
    {
        return Err("Provider candidate has been superseded".to_owned());
    }
    let epoch = candidate.epoch;
    *current = Arc::new(candidate);
    Ok(epoch)
}

#[cfg(test)]
mod tests {
    #[test]
    fn edge_opt_in_publication_preserves_unrelated_connection_and_disables_cleanly() {
        let mut config = configured();
        let runtime = runtime(config.clone());
        let first = runtime.snapshot();
        config.edge_tts = Some(crate::config::EdgeTtsConfig {
            anonymous_consumer_opt_in: true,
        });
        let enabled = runtime
            .build_candidate(
                config.clone(),
                RoutingConfig::default(),
                EgressConfig::default(),
                BTreeMap::new(),
                None,
            )
            .unwrap();
        assert!(enabled.providers.get_owned("edge-tts").is_some());
        assert!(enabled.providers.region_for("edge-tts").is_none());
        assert!(Arc::ptr_eq(
            &first.providers.get_owned("openai").unwrap(),
            &enabled.providers.get_owned("openai").unwrap()
        ));
        let view = serde_json::to_value(enabled.safe_provider_view()).unwrap();
        assert_eq!(view["edge_tts"]["mode"], "anonymous");
        config.edge_tts.as_mut().unwrap().anonymous_consumer_opt_in = false;
        let disabled = runtime
            .build_candidate(
                config,
                RoutingConfig::default(),
                EgressConfig::default(),
                BTreeMap::new(),
                None,
            )
            .unwrap();
        assert!(disabled.providers.get_owned("edge-tts").is_none());
    }

    #[test]
    fn router_selection_survives_provider_reload_with_and_without_routing_changes() {
        let mut config = configured();
        let runtime = runtime(config.clone());
        let original = runtime.snapshot();
        // The live `backends.router` swap (config PUT) mutates the published router.
        assert!(original.router.set_active("litellm"));
        assert_eq!(runtime.snapshot().router.active_id(), "litellm");

        // Provider-only reload: routing is unchanged, so the router is reused.
        config.openai.as_mut().expect("openai configured").api_key = "runtime-key-b".into();
        let provider_only = runtime
            .build_candidate(
                config.clone(),
                original.routing.clone(),
                original.egress_config.clone(),
                original.environment.clone(),
                None,
            )
            .unwrap();
        runtime.publish(provider_only).unwrap();
        let reloaded = runtime.snapshot();
        assert_ne!(original.epoch, reloaded.epoch);
        assert_eq!(reloaded.router.active_id(), "litellm");

        // Routing change: the registry is rebuilt and must re-apply the selection.
        let mut routing = reloaded.routing.clone();
        routing.fallback_chain = vec![ProviderId::from("openai")];
        let rerouted = runtime
            .build_candidate(
                config,
                routing,
                reloaded.egress_config.clone(),
                reloaded.environment.clone(),
                None,
            )
            .unwrap();
        assert!(!Arc::ptr_eq(&reloaded.router, &rerouted.router));
        runtime.publish(rerouted).unwrap();
        let rebuilt = runtime.snapshot();
        assert_ne!(reloaded.epoch, rebuilt.epoch);
        assert_eq!(rebuilt.router.active_id(), "litellm");
    }

    #[test]
    fn account_strategy_and_drain_threshold_changes_rebuild_only_that_provider() {
        // Both settings are written into a provider's account pool only when it is
        // built, so reusing the previous instance would keep the old routing.
        let mut config = configured();
        let runtime = runtime(config.clone());
        let original = runtime.snapshot();
        let rebuild = |config: ProvidersConfig| {
            let snapshot = runtime.snapshot();
            let candidate = runtime
                .build_candidate(
                    config,
                    snapshot.routing.clone(),
                    snapshot.egress_config.clone(),
                    snapshot.environment.clone(),
                    None,
                )
                .unwrap();
            runtime.publish(candidate).unwrap();
            runtime.snapshot()
        };
        let openai = |snapshot: &ProviderSnapshot| snapshot.providers.get_owned("openai").unwrap();

        config.account_strategies.insert(
            "openai".into(),
            ryu_gw_providers::AccountSelectionStrategy::FillFirst,
        );
        let strategy = rebuild(config.clone());
        assert!(!Arc::ptr_eq(&openai(&original), &openai(&strategy)));
        assert!(Arc::ptr_eq(
            &original.providers.get_owned("genai-groq").unwrap(),
            &strategy.providers.get_owned("genai-groq").unwrap()
        ));

        config.account_drain_thresholds.insert("openai".into(), 50);
        let threshold = rebuild(config.clone());
        assert!(!Arc::ptr_eq(&openai(&strategy), &openai(&threshold)));

        // An identical config still reuses the live instance.
        let same = rebuild(config.clone());
        assert!(Arc::ptr_eq(&openai(&threshold), &openai(&same)));

        // Clearing back to the defaults must rebuild as well.
        config.account_strategies.clear();
        config.account_drain_thresholds.clear();
        let cleared = rebuild(config);
        assert!(!Arc::ptr_eq(&openai(&same), &openai(&cleared)));
    }

    use super::*;

    fn runtime(config: ProvidersConfig) -> ProviderRuntime {
        runtime_for(config, crate::custody::GatewayCustody::SelfHosted)
    }

    fn runtime_for(
        config: ProvidersConfig,
        custody: crate::custody::GatewayCustody,
    ) -> ProviderRuntime {
        let routing = RoutingConfig::default();
        let egress_config = EgressConfig::default();
        let environment = BTreeMap::new();
        let egress = EgressPools::new(&egress_config).unwrap();
        let quota = Arc::new(ProviderQuotas::new());
        let providers = ProviderRegistry::build_with_environment(
            &config,
            Some(&egress),
            Arc::clone(&quota),
            &environment,
            custody,
        );
        ProviderRuntime::from_parts(
            config,
            routing.clone(),
            egress_config,
            environment,
            providers,
            RouterRegistry::new(routing.clone()),
            ProviderPools::new(&routing).unwrap(),
            egress,
            quota,
            ProviderInputs {
                environment: ProviderEnvironment::default(),
                fleet: None,
            },
            WebPricingSnapshot::new(Default::default(), &crate::config::CreditsConfig::default())
                .unwrap(),
        )
    }

    fn configured() -> ProvidersConfig {
        serde_json::from_value(serde_json::json!({
            "openai":{"api_key":"runtime-key-a","base_url":"https://api.openai.com/v1"},
            "genai":{"accounts":{
                "groq":{"api_key":"sdk-test","allow_env":false},
                "vertex":{"api_key":"vertex-token","allow_env":false,"context":{"kind":"vertex","project":"test-project","location":"europe-west1"}}
            }}
        })).unwrap()
    }

    #[test]
    fn a_reload_keeps_the_vercel_lane_bound_to_the_boot_custody() {
        let approved: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "vercel": {
                "api_key": "vercel-fixture-key",
                "resale_permission": "approved:VERCEL-RESALE-FIXTURE-1"
            }
        }))
        .unwrap();
        for (custody, registered) in [
            (crate::custody::GatewayCustody::Fleet, true),
            (crate::custody::GatewayCustody::SelfHosted, false),
            (crate::custody::GatewayCustody::ManagedNode, false),
        ] {
            let runtime = runtime_for(approved.clone(), custody);
            let original = runtime.snapshot();
            assert_eq!(
                original.providers.get("vercel").is_some(),
                registered,
                "{custody:?}"
            );
            let candidate = runtime
                .build_candidate(
                    approved.clone(),
                    original.routing.clone(),
                    original.egress_config.clone(),
                    original.environment.clone(),
                    None,
                )
                .unwrap();
            runtime.publish(candidate).unwrap();
            let reloaded = runtime.snapshot();
            assert_ne!(original.epoch, reloaded.epoch);
            assert_eq!(reloaded.providers.custody(), custody);
            assert_eq!(
                reloaded.providers.get("vercel").is_some(),
                registered,
                "{custody:?}"
            );
        }
    }

    #[test]
    fn web_registration_context_ids_no_models_and_live_generation_keep_other_connections() {
        let mut config = configured();
        config.web=serde_json::from_value(serde_json::json!({
            "google-pse":{"mode":"accounts","accounts":[{"api_key":"google-shared-secret","context":{"kind":"google_pse","engine_id":"first-engine","existing_customer_acknowledged":true}},{"api_key":"google-shared-secret","context":{"kind":"google_pse","engine_id":"second-engine","existing_customer_acknowledged":true}}]},
            "jina-reader":{"mode":"anonymous"},
            "exa":{"mode":"accounts","accounts":[{"api_key":"exa-secret"}]},
            "tavily":{"mode":"accounts","accounts":[{"api_key":"tavily-secret"}]}
        })).unwrap();
        let runtime = runtime(config);
        let original = runtime.snapshot();
        assert!(original.providers.get("openai").is_some());
        assert!(original.providers.get("genai-groq").is_some());
        let first = original
            .bind_web(WebProviderKind::GooglePse, WebOperation::Search, None, 0)
            .unwrap();
        assert_eq!(first.provider.name(), "google-pse");
        assert!(first.region.is_none());
        assert!(first.price.is_none());
        assert!(original
            .bind_web(
                WebProviderKind::GooglePse,
                WebOperation::Search,
                None,
                ryu_gw_credentials::web::GOOGLE_PSE_SUNSET_UNIX_SECONDS
            )
            .is_err());
        assert!(original
            .bind_web(
                WebProviderKind::JinaReader,
                WebOperation::Fetch,
                Some(WebContentFormat::Markdown),
                0
            )
            .is_ok());
        assert!(original
            .bind_web(
                WebProviderKind::Exa,
                WebOperation::Fetch,
                Some(WebContentFormat::Markdown),
                0
            )
            .is_err());
        let view = serde_json::to_value(original.safe_provider_view()).unwrap();
        assert_eq!(view["accounts"]["google-pse"].as_array().unwrap().len(), 2);
        assert!(view["accounts"].get("jina-reader").is_none());
        assert!(!view.to_string().contains("google-shared-secret"));
        let mut changed = original.config.clone();
        let connection = changed.web.get_mut(&WebProviderKind::GooglePse).unwrap();
        let ryu_gw_credentials::web::WebProviderConfig::Accounts { accounts } = connection else {
            panic!("keyed Google");
        };
        accounts[0] = ryu_gw_credentials::web::WebAccountConfig::new(
            "google-shared-secret".into(),
            ryu_gw_credentials::web::WebAccountContext::GooglePse {
                engine_id: "replacement-engine".into(),
                existing_customer_acknowledged: true,
            },
        )
        .unwrap();
        let candidate = runtime
            .build_candidate(
                changed,
                original.routing.clone(),
                original.egress_config.clone(),
                original.environment.clone(),
                None,
            )
            .unwrap();
        runtime.publish(candidate).unwrap();
        let next = runtime.snapshot();
        assert_ne!(original.epoch, next.epoch);
        assert!(!Arc::ptr_eq(
            &first.provider,
            &next.providers.get_owned("google-pse").unwrap()
        ));
        assert!(Arc::ptr_eq(
            &original.providers.get_owned("openai").unwrap(),
            &next.providers.get_owned("openai").unwrap()
        ));
        assert!(Arc::ptr_eq(
            &original.providers.get_owned("tavily").unwrap(),
            &next.providers.get_owned("tavily").unwrap()
        ));
    }

    #[tokio::test]
    async fn authored_web_price_application_is_pinned_without_changing_global_markup_or_wallet() {
        let file =
            crate::config::test_config_path::ConfigPathGuard::isolated("web-price-generation");
        let runtime = runtime(configured());
        runtime.set_environment_for_test(ProviderEnvironment::default());
        let mut config = authored("runtime-key-a");
        config.providers.web=serde_json::from_value(serde_json::json!({"tavily":{"mode":"accounts","accounts":[{"api_key":"web-price-secret"}]}})).unwrap();
        config.credits.markup_bps = 9999; // Provider-only receipt does not apply global money policy.
        config.credits.web_service_prices.insert(
            WebProviderKind::Tavily,
            HashMap::from([(
                WebOperation::Search,
                crate::web_config::WebServicePrice {
                    reservation_micro_usd_per_call: 100,
                    max_reported_micro_usd_per_call: 90,
                    fallback_micro_usd_per_call: 80,
                },
            )]),
        );
        let revision = persist(file.path(), &config);
        runtime
            .apply_revision(file.path().to_owned(), revision)
            .await;
        let previous = runtime.snapshot();
        let old = previous
            .bind_web(WebProviderKind::Tavily, WebOperation::Search, None, 0)
            .unwrap();
        assert_eq!(old.price.unwrap().markup_bps, 0);
        assert_eq!(old.price.unwrap().reservation(), Some(100));
        config
            .credits
            .web_service_prices
            .get_mut(&WebProviderKind::Tavily)
            .unwrap()
            .get_mut(&WebOperation::Search)
            .unwrap()
            .fallback_micro_usd_per_call = 70;
        let revision = persist(file.path(), &config);
        runtime
            .apply_revision(file.path().to_owned(), revision)
            .await;
        let next = runtime.snapshot();
        let new = next
            .bind_web(WebProviderKind::Tavily, WebOperation::Search, None, 0)
            .unwrap();
        assert_eq!(old.price.unwrap().price.fallback_micro_usd_per_call, 80);
        assert_eq!(new.price.unwrap().price.fallback_micro_usd_per_call, 70);
        assert!(Arc::ptr_eq(&old.provider, &new.provider));
        assert_ne!(old.epoch, new.epoch);
    }

    fn persist(path: &std::path::Path, config: &GatewayConfig) -> ConfigRevision {
        crate::config::test_config_path::ensure_test_seal_key();
        let mut transaction = ryu_gw_credentials::ConfigFileTransaction::acquire(path).unwrap();
        let previous = transaction.snapshot().revision().clone();
        transaction
            .commit(&previous, toml::to_string(config).unwrap().as_bytes())
            .unwrap()
    }

    fn authored(key: &str) -> GatewayConfig {
        let mut config = GatewayConfig::default();
        config.providers = configured();
        config.providers.openai.as_mut().unwrap().api_key = key.to_owned();
        config
            .providers
            .environment_imports
            .insert("openai".to_owned(), false);
        config
    }

    #[tokio::test]
    async fn exact_revision_applies_once_and_stale_or_invalid_bytes_preserve_runtime() {
        use ryu_gw_credentials::{ProviderApplyErrorCode as Code, ProviderApplyOutcome as Outcome};
        let file =
            crate::config::test_config_path::ConfigPathGuard::isolated("provider-exact-apply");
        let runtime = runtime(configured());
        runtime.set_environment_for_test(ProviderEnvironment::default());
        let original = runtime.snapshot();
        let revision = persist(file.path(), &authored("runtime-key-b"));
        let receipt = runtime
            .apply_revision(file.path().to_owned(), revision.clone())
            .await;
        assert!(matches!(receipt, Outcome::Applied { .. }));
        assert!(receipt.validates_request(&revision));
        let applied = runtime.snapshot();
        assert_eq!(
            applied.config.openai.as_ref().unwrap().api_key,
            "runtime-key-b"
        );
        assert_eq!(applied.authored_revision.as_ref(), Some(&revision));
        assert!(Arc::ptr_eq(
            &original.providers.get_owned("genai-groq").unwrap(),
            &applied.providers.get_owned("genai-groq").unwrap()
        ));
        let repeated = runtime
            .apply_revision(file.path().to_owned(), revision.clone())
            .await;
        assert!(matches!(repeated, Outcome::AlreadyApplied { .. }));
        assert!(Arc::ptr_eq(&applied, &runtime.snapshot()));
        let newer = persist(file.path(), &authored("runtime-key-c"));
        assert!(
            matches!(runtime.apply_revision(file.path().to_owned(),revision).await,Outcome::Superseded {current_revision,..} if current_revision==newer)
        );
        assert!(Arc::ptr_eq(&applied, &runtime.snapshot()));
        let mut transaction =
            ryu_gw_credentials::ConfigFileTransaction::acquire(file.path()).unwrap();
        let expected = transaction.snapshot().revision().clone();
        let invalid = transaction
            .commit(
                &expected,
                b"[providers.openai]\napi_key='private-test-material'\n[broken",
            )
            .unwrap();
        drop(transaction);
        let rejected = runtime
            .apply_revision(file.path().to_owned(), invalid)
            .await;
        assert!(matches!(
            rejected,
            Outcome::Failed {
                code: Code::InvalidConfig,
                ..
            }
        ));
        assert!(!serde_json::to_string(&rejected)
            .unwrap()
            .contains("private-test-material"));
        assert!(Arc::ptr_eq(&applied, &runtime.snapshot()));
    }

    #[tokio::test]
    async fn co_operating_writer_can_commit_during_build_and_supersedes_candidate() {
        use ryu_gw_credentials::ProviderApplyOutcome as Outcome;
        let file =
            crate::config::test_config_path::ConfigPathGuard::isolated("provider-writer-race");
        let runtime = Arc::new(runtime(configured()));
        runtime.set_environment_for_test(ProviderEnvironment::default());
        let original = runtime.snapshot();
        let revision = persist(file.path(), &authored("runtime-key-b"));
        let ready = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        *runtime.test_pause.lock().await = Some((Arc::clone(&ready), Arc::clone(&resume)));
        let pending = tokio::spawn({
            let runtime = Arc::clone(&runtime);
            let path = file.path().to_owned();
            async move { runtime.apply_revision(path, revision).await }
        });
        ready.notified().await;
        // Acquiring/committing here would fail if the builder retained its file lock.
        let newest = persist(file.path(), &authored("runtime-key-c"));
        resume.notify_one();
        assert!(
            matches!(pending.await.unwrap(),Outcome::Superseded {current_revision,..} if current_revision==newest)
        );
        assert!(Arc::ptr_eq(&original, &runtime.snapshot()));
    }

    #[tokio::test]
    async fn changed_source_during_build_is_not_published() {
        use ryu_gw_credentials::{ProviderApplyErrorCode as Code, ProviderApplyOutcome as Outcome};
        let file =
            crate::config::test_config_path::ConfigPathGuard::isolated("provider-source-race");
        let runtime = Arc::new(runtime(configured()));
        runtime.set_environment_for_test(ProviderEnvironment::from_values(BTreeMap::from([(
            "OPENAI_API_KEY".to_owned(),
            "source-a".to_owned(),
        )])));
        let original = runtime.snapshot();
        let revision = persist(file.path(), &authored("runtime-key-b"));
        let ready = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        *runtime.test_pause.lock().await = Some((Arc::clone(&ready), Arc::clone(&resume)));
        let pending = tokio::spawn({
            let runtime = Arc::clone(&runtime);
            let path = file.path().to_owned();
            async move { runtime.apply_revision(path, revision).await }
        });
        ready.notified().await;
        runtime.set_environment_for_test(ProviderEnvironment::from_values(BTreeMap::from([(
            "OPENAI_API_KEY".to_owned(),
            "source-b".to_owned(),
        )])));
        resume.notify_one();
        assert!(matches!(
            pending.await.unwrap(),
            Outcome::Failed {
                code: Code::SourcesChanged,
                ..
            }
        ));
        assert!(Arc::ptr_eq(&original, &runtime.snapshot()));
    }

    #[tokio::test]
    async fn closed_native_import_keeps_authored_replacement_and_clear_from_resurrection() {
        let file =
            crate::config::test_config_path::ConfigPathGuard::isolated("native-source-choice");
        let runtime = runtime(configured());
        let environment = ProviderEnvironment::from_values(BTreeMap::from([(
            "OPENAI_API_KEY".to_owned(),
            "old-spawn-pref".to_owned(),
        )]));
        assert!(!format!("{environment:?}").contains("old-spawn-pref"));
        runtime.set_environment_for_test(environment);
        let mut config = authored("stored-new");
        config.providers.environment_imports.clear();
        let imported = persist(file.path(), &config);
        runtime
            .apply_revision(file.path().to_owned(), imported)
            .await;
        let imported_view = serde_json::to_value(runtime.snapshot().safe_provider_view()).unwrap();
        assert_eq!(
            imported_view["accounts"]["openai"][0]["source"],
            "environment"
        );
        config
            .providers
            .environment_imports
            .insert("openai".to_owned(), false);
        let replaced = persist(file.path(), &config);
        runtime
            .apply_revision(file.path().to_owned(), replaced)
            .await;
        let snapshot = runtime.snapshot();
        assert_eq!(
            snapshot.config.openai.as_ref().unwrap().api_key,
            "stored-new"
        );
        let stored_view = serde_json::to_value(snapshot.safe_provider_view()).unwrap();
        assert_eq!(stored_view["accounts"]["openai"][0]["source"], "stored");
        config.providers.openai = None;
        let cleared = persist(file.path(), &config);
        runtime
            .apply_revision(file.path().to_owned(), cleared)
            .await;
        assert!(runtime.snapshot().providers.get("openai").is_none());
        assert!(runtime.snapshot().config.openai.is_none());
    }

    #[test]
    fn policy_publication_changes_new_pool_and_preserves_captured_policy() {
        let runtime = runtime(configured());
        let original = runtime.snapshot();
        let id = ryu_gw_credentials::provider_account_id("openai", "runtime-key-a");
        let updates = std::collections::HashMap::from([(
            "openai".to_owned(),
            std::collections::HashMap::from([(
                id.clone(),
                ryu_gw_credentials::ProviderAccountPolicy {
                    drain_threshold_percent: None,
                    name: "Disabled new calls".to_owned(),
                    enabled: false,
                    priority: 3,
                },
            )]),
        )]);
        let old_provider = original.providers.get_owned("openai").unwrap();
        assert!(!old_provider.has_rotating_accounts());
        let candidate = runtime.candidate_with_policies(&updates).unwrap();
        runtime.publish(candidate).unwrap();
        let replacement = runtime.snapshot();
        assert_ne!(original.epoch, replacement.epoch);
        assert!(original.providers.account_policy_snapshot().is_empty());
        assert!(!old_provider.has_rotating_accounts());
        assert!(replacement
            .providers
            .get("openai")
            .unwrap()
            .has_rotating_accounts());
        assert!(!Arc::ptr_eq(
            &old_provider,
            &replacement.providers.get_owned("openai").unwrap()
        ));
        assert!(Arc::ptr_eq(
            &original.providers.get_owned("genai-groq").unwrap(),
            &replacement.providers.get_owned("genai-groq").unwrap()
        ));
        assert_eq!(
            replacement.config.account_policies["openai"][&id].name,
            "Disabled new calls"
        );
        let safe = serde_json::to_value(replacement.safe_provider_view()).unwrap();
        assert_eq!(safe["accounts"]["openai"][0]["enabled"], false);
        assert!(!safe.to_string().contains("runtime-key-a"));
    }

    #[test]
    fn context_region_owner_readiness_and_epoch_publish_together() {
        let runtime = runtime(configured());
        let original = runtime.snapshot();
        let decision = RouteDecision {
            provider: ProviderId::from("genai"),
            model: "vertex::gemini-2.5-flash".to_owned(),
        };
        let old = original.bind(&decision).unwrap();
        assert_eq!(old.provider_id.as_str(), "genai-vertex");
        assert_eq!(old.region.as_deref(), Some("europe-west1"));
        let mut config = original.config.clone();
        config
            .genai
            .as_mut()
            .unwrap()
            .accounts
            .get_mut("vertex")
            .unwrap()
            .context = ryu_gw_credentials::SdkEndpointConfig::Vertex {
            project: "new-project".to_owned(),
            location: "us-central1".to_owned(),
        };
        let candidate = runtime
            .build_candidate(
                config,
                original.routing.clone(),
                original.egress_config.clone(),
                original.environment.clone(),
                None,
            )
            .unwrap();
        runtime.publish(candidate).unwrap();
        let replacement = runtime.snapshot();
        let new = replacement.bind(&decision).unwrap();
        assert_eq!(new.region.as_deref(), Some("us-central1"));
        assert_ne!(old.epoch, new.epoch);
        assert_eq!(
            original.bind(&decision).unwrap().region.as_deref(),
            Some("europe-west1")
        );
        assert_eq!(
            original.providers.available_providers(),
            replacement.providers.available_providers()
        );
        let safe = serde_json::to_value(replacement.safe_provider_view()).unwrap();
        let vertex = safe["genai"]["sdk_providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["kind"] == "vertex")
            .unwrap();
        assert_eq!(vertex["context"]["location"], "us-central1");
        assert_eq!(vertex["configured"], true);
        assert!(replacement
            .bind(&RouteDecision {
                provider: ProviderId::from("genai-groq"),
                model: decision.model.clone()
            })
            .is_err());
    }

    #[test]
    fn failed_candidate_and_stale_publication_leave_current_generation_intact() {
        let runtime = runtime(configured());
        let original = runtime.snapshot();
        let candidate = runtime
            .build_candidate(
                original.config.clone(),
                original.routing.clone(),
                original.egress_config.clone(),
                original.environment.clone(),
                None,
            )
            .unwrap();
        let stale = runtime
            .build_candidate(
                original.config.clone(),
                original.routing.clone(),
                original.egress_config.clone(),
                original.environment.clone(),
                None,
            )
            .unwrap();
        runtime.publish(candidate).unwrap();
        let applied = runtime.snapshot();
        assert!(runtime.publish(stale).is_err());
        assert!(Arc::ptr_eq(&applied, &runtime.snapshot()));
        let mut invalid = original.egress_config.clone();
        invalid
            .assignments
            .insert("openai".to_owned(), "missing".to_owned());
        assert!(runtime
            .build_candidate(
                original.config.clone(),
                original.routing.clone(),
                invalid,
                original.environment.clone(),
                None
            )
            .is_err());
        assert!(Arc::ptr_eq(&applied, &runtime.snapshot()));
    }

    #[test]
    fn old_quota_feedback_cannot_overwrite_replacement_metrics() {
        let runtime = runtime(configured());
        let old = runtime.snapshot();
        let mut changed = old.config.clone();
        changed.openai.as_mut().unwrap().api_key = "runtime-key-b".to_owned();
        let candidate = runtime
            .build_candidate(
                changed,
                old.routing.clone(),
                old.egress_config.clone(),
                old.environment.clone(),
                None,
            )
            .unwrap();
        runtime.publish(candidate).unwrap();
        let current = runtime.snapshot();
        old.quota.record_success(
            "openai",
            &ryu_gw_providers::RateLimitInfo {
                remaining: Some(1),
                ..Default::default()
            },
        );
        assert_eq!(old.quota.snapshot()["openai"]["remaining"], 1);
        assert_eq!(current.quota.snapshot(), serde_json::json!({}));
        assert_ne!(
            old.epoch.circuit_key("openai"),
            current.epoch.circuit_key("openai")
        );
    }

    #[tokio::test]
    async fn late_discovery_only_populates_its_captured_snapshot() {
        let runtime = runtime(configured());
        let old = runtime.snapshot();
        let started = Arc::new(tokio::sync::Notify::new());
        let finish = Arc::new(tokio::sync::Notify::new());
        let task = tokio::spawn({
            let old = Arc::clone(&old);
            let started = Arc::clone(&started);
            let finish = Arc::clone(&finish);
            async move {
                old.models_cache
                    .get_or_discover(async {
                        started.notify_one();
                        finish.notified().await;
                        vec![serde_json::json!({"id":"old-model"})]
                    })
                    .await
            }
        });
        started.notified().await;
        let candidate = runtime
            .build_candidate(
                old.config.clone(),
                old.routing.clone(),
                old.egress_config.clone(),
                old.environment.clone(),
                None,
            )
            .unwrap();
        runtime.publish(candidate).unwrap();
        let current = runtime.snapshot();
        let fresh = current
            .models_cache
            .get_or_discover(async { vec![serde_json::json!({"id":"new-model"})] })
            .await;
        finish.notify_one();
        assert_eq!(task.await.unwrap()[0]["id"], "old-model");
        assert_eq!(fresh[0]["id"], "new-model");
        assert_eq!(
            current
                .models_cache
                .get_or_discover(async { panic!("current discovery should be cached") })
                .await[0]["id"],
            "new-model"
        );
    }
}

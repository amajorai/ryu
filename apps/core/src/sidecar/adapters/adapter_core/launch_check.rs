use super::*;

/// The route id a launch check uses for an agent that is not saved yet: any
/// custom agent id behaves the same, since its routing switch has no saved
/// value and it is none of the built-in ids.
const UNSAVED_AGENT_ROUTE_ID: &str = "agent_unsaved";

/// Refusal code: the agent's account access does not allow the model provider
/// the engine calls itself ([`limited_route_refusal`]).
pub const LAUNCH_REFUSED_PROVIDER_ACCESS: &str = "provider_access_refused";
/// Refusal code: the agent would run on Ryu's managed Pi, which is set to call
/// its provider directly, so Gateway could not limit its model providers.
pub const LAUNCH_REFUSED_MANAGED_PI_DIRECT: &str = "managed_pi_direct_routing";
/// Refusal code: the engine must run in the account-access sandbox and this
/// computer has none (the code of [`acp::account_sandbox_failure`]).
pub const LAUNCH_REFUSED_SANDBOX: &str = "account_access_sandbox_unavailable";
/// Refusal code: the agent's model providers are limited, which only a Gateway
/// Core spawned itself can enforce, and this node uses a remote or
/// operator-run Gateway.
pub const LAUNCH_REFUSED_UNMANAGED_GATEWAY: &str = "unmanaged_gateway";

/// The refusal for a limited agent when the Gateway is not the one Core manages
/// ([`crate::sidecar::gateway::gateway_bearer_for_agent`] refuses its bearer).
pub(crate) const UNMANAGED_GATEWAY_REFUSAL: &str = "This agent's account access limits which model providers it may use, and that is only enforced through the Gateway Ryu manages. Use the Gateway Ryu manages, or change the agent's account access.";

/// The refusal for a limited agent on Ryu's managed Pi while that Pi calls its
/// provider directly ([`acp::ryu_pi_acp_cmd_for_agent`] and the fallback in
/// [`ryu_agent_route_with_user_jwt`] refuse it).
const MANAGED_PI_DIRECT_REFUSAL: &str = "This agent runs on Ryu's own Pi, which is set to call its model provider directly, so Ryu can't limit which model providers it uses. It won't start while this agent's model providers are limited. Turn Gateway routing back on in Ryu's Pi settings, choose another engine, or use Acts as you or Both with Limit to selected accounts off.";

/// Whether Core would start an agent's engine, decided before its first turn by
/// the same checks the launch path runs, with the same refusal text.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, utoipa::ToSchema)]
pub struct AgentLaunchCheck {
    /// Whether the engine would start under this account access.
    pub launchable: bool,
    /// Why it would not, as the user would be told at launch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// A stable code for the refusal: `provider_access_refused`,
    /// `managed_pi_direct_routing`, `account_access_sandbox_unavailable` or
    /// `unmanaged_gateway`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Whether this computer can run an engine in the account-access sandbox.
    pub sandbox_supported: bool,
    /// Whether the agent runs on Ryu's managed engine because its model
    /// providers are limited (a custom agent saved on the "Ryu" engine).
    pub runs_on_managed_pi: bool,
    /// The model provider (Gateway registry id) the engine calls itself with
    /// the user's own sign-in or key under the current routing, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor_provider: Option<String>,
    /// Where the default model comes from when the agent runs on Ryu's managed
    /// engine with limited model providers (see
    /// [`crate::pi_config::limited_agent_model_choice`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limited_model_source: Option<crate::pi_config::LimitedModelSource>,
    /// A warning that does not stop the engine starting: the limited agent
    /// would start on the local model, which is not downloaded, so its turns
    /// would fail.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_warning: Option<String>,
    /// Whether the agent may be allowed the user's model providers (any mode
    /// but "Its own identity"). Not sent; it picks the warning's wording.
    #[serde(skip)]
    may_use_user_providers: bool,
}

/// [`AgentLaunchCheck::model_warning`] for an agent that may be allowed the
/// user's model providers.
pub const NO_USABLE_MODEL_WARNING: &str = "This agent has no model it can use, so its turns will fail. Your default model isn't one it may use or one Ryu credits pay for, and the local model isn't downloaded. Download the local model, choose a default model marked Free, or allow a model provider you're signed in to.";

/// [`AgentLaunchCheck::model_warning`] for an "Its own identity" agent, which
/// never uses the user's model providers.
pub const NO_USABLE_MODEL_WARNING_OWN_IDENTITY: &str = "This agent has no model it can use, so its turns will fail. With its own identity it can only use Ryu credits or a local model: your default model isn't one Ryu credits pay for, and the local model isn't downloaded. Download the local model, or choose a default model marked Free.";

impl AgentLaunchCheck {
    fn refuse(mut self, code: &str, reason: String) -> Self {
        self.launchable = false;
        self.code = Some(code.to_owned());
        self.reason = Some(reason);
        self
    }

    /// Add [`Self::model_warning`] when the agent would start on the local
    /// model and `local_model_present` says its weights are not on disk. The
    /// caller reads that (`llamacpp::active_chat_model_present`) because it is
    /// async.
    pub fn with_model_warning(mut self, local_model_present: bool) -> Self {
        if self.launchable
            && self.limited_model_source == Some(crate::pi_config::LimitedModelSource::Local)
            && !local_model_present
        {
            let warning = if self.may_use_user_providers {
                NO_USABLE_MODEL_WARNING
            } else {
                NO_USABLE_MODEL_WARNING_OWN_IDENTITY
            };
            self.model_warning = Some(warning.to_owned());
        }
        self
    }
}

/// Whether Core would start `engine` for an agent with `policy`, saved as
/// `agent_id` (`None` for one not saved yet). `sandbox_support` is
/// [`crate::agent_sandbox::untrusted_support`], passed in so tests can pick it.
///
/// It runs the launch path's own account-access checks in its order: Ryu's
/// managed engine refuses a limited agent while it calls its provider directly;
/// any other engine must pass [`limited_route_refusal`]; and an engine Core
/// spawns for a confined agent needs the OS sandbox, which only Ryu's managed
/// engine may run without (on its brokered tools alone, see
/// `confine_for_agent`). Folder trust is not known here, and does not change
/// these answers.
pub fn agent_launch_check(
    agent_id: Option<&str>,
    engine: &str,
    policy: &crate::agent_access::AgentAccountPolicy,
    acp_registry: &AcpAgentRegistry,
    sandbox_support: Result<(), String>,
) -> AgentLaunchCheck {
    let engine = engine.trim();
    let route_id = agent_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(UNSAVED_AGENT_ROUTE_ID);
    let provider_access = policy.user_provider_access();
    let provider_access = provider_access.as_deref();
    let confinement = crate::agent_access::AccountConfinement::for_policy(policy);
    let runs_on_managed_pi =
        crate::agents::runs_limited_on_managed_pi(route_id, Some(engine), provider_access);
    let check = AgentLaunchCheck {
        launchable: true,
        reason: None,
        code: None,
        sandbox_supported: sandbox_support.is_ok(),
        runs_on_managed_pi,
        vendor_provider: None,
        limited_model_source: None,
        model_warning: None,
        may_use_user_providers: policy.allows_user_accounts(),
    };
    if route_id == "ryu" || crate::agents::runs_on_ryu_engine(route_id) || runs_on_managed_pi {
        let Some(provider_access) = provider_access else {
            return check;
        };
        if !crate::pi_config::is_gateway_routing() {
            return check.refuse(
                LAUNCH_REFUSED_MANAGED_PI_DIRECT,
                MANAGED_PI_DIRECT_REFUSAL.to_owned(),
            );
        }
        if !crate::sidecar::gateway::core_spawned_local_gateway() {
            return check.refuse(
                LAUNCH_REFUSED_UNMANAGED_GATEWAY,
                UNMANAGED_GATEWAY_REFUSAL.to_owned(),
            );
        }
        let mut check = check;
        check.limited_model_source =
            Some(crate::pi_config::limited_agent_model_choice(provider_access).source);
        return check;
    }
    if is_default_agent(Some(route_id)) {
        return check;
    }
    let Some((launched, _)) = launched_engine(engine, acp_registry) else {
        return check;
    };
    let mut check = check;
    if let crate::agent_access::ProviderReach::Vendor(vendor) =
        current_provider_reach(route_id, launched)
    {
        check.vendor_provider = Some(vendor.to_owned());
    }
    if let Some(reason) = limited_route_refusal(route_id, engine, acp_registry, provider_access) {
        return check.refuse(LAUNCH_REFUSED_PROVIDER_ACCESS, reason);
    }
    // A Gateway-reach engine of a limited agent gets a Gateway bearer carrying
    // its provider access, which only the Gateway Core manages can verify.
    if provider_access.is_some()
        && current_provider_reach(route_id, launched) == crate::agent_access::ProviderReach::Gateway
        && !crate::sidecar::gateway::core_spawned_local_gateway()
    {
        return check.refuse(
            LAUNCH_REFUSED_UNMANAGED_GATEWAY,
            UNMANAGED_GATEWAY_REFUSAL.to_owned(),
        );
    }
    let spawns_engine = matches!(
        launched,
        LaunchedEngine::AcpExec(_) | LaunchedEngine::Registry { acp: true, .. }
    );
    if confinement.is_confined() && spawns_engine {
        if let Err(reason) = sandbox_support {
            let failure = acp::account_sandbox_failure(&reason, confinement);
            return check.refuse(LAUNCH_REFUSED_SANDBOX, failure.message);
        }
    }
    check
}

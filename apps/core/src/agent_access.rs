//! Per-agent account policy: whose accounts an agent may act with.
//!
//! An agent's [`AgentIdentityMode`] says whether it acts as the user
//! (`managed`), under its own identity (`individual`), or both (`mixed`). Its
//! optional [`AgentRecord::account_access`] allowlist then narrows which
//! accounts it may use. This module is the one place that parses the allowlist
//! grammar and answers "may this agent use this account?"; the runtime seams
//! (the governed MCP dispatch core, MCP OAuth profile selection, the vault
//! agent-account capabilities and Composio trigger subscriptions) only ask.
//!
//! Every answer fails closed. A key that does not parse grants nothing, and a
//! restricted agent never falls back to an account it was not given. A legacy
//! record (`managed` with no allowlist) is [`AgentAccountPolicy::is_unrestricted`]
//! and keeps exactly the behaviour every agent had before this setting existed,
//! including the vault agent accounts it may already own. Only a `managed` agent
//! the user has limited loses those.
//!
//! Delegation never escapes a restriction: a restricted agent may only hand work
//! to (or create) an agent whose reach into the user's accounts
//! [`AgentAccountPolicy::is_within`] its own.
//!
//! `platform:treg` is enforced on app provider calls: an app that does work for
//! an agent (including work it defers, such as a scheduled social post) hands
//! back the Core-signed agent grant it received, and Core checks
//! [`AgentAccountPolicy::authorize_managed_provider_call`] against that agent's
//! current record before the call reaches Gateway.
//!
//! `provider:<id>` keys limit which of the user's model providers the agent's
//! inference may use. [`AgentAccountPolicy::user_provider_access`] resolves
//! them; Core sends the list to Gateway on every inference hop it makes for the
//! agent (the chat header and the signed scope of ACP, Pi and Codex bearers),
//! and Gateway skips any provider outside it. Ryu's platform-credit slots,
//! keyless local engines and a hosted organisation's managed inference (served
//! from Ryu Cloud's own keys and billed to the organisation, on a Gateway that
//! bills tenants) are not the user's accounts and stay open; the
//! organisation's model and provider policy still applies to them. A turn
//! that would go straight to a provider with a key, bypassing Gateway, is
//! refused for a limited agent.
//!
//! Engines that call their provider themselves are checked when Core launches
//! them ([`self_called_provider_permitted`]): Claude Code, Codex on its ChatGPT
//! sign-in, Gemini CLI and Kiro start for a limited agent only when that
//! vendor's `provider:<id>` key is allowed, and then use the user's own sign-in
//! for it. Any other engine that calls its provider itself, or whose Gateway
//! routing is off, does not start for a limited agent. An agent with only its
//! own identity has no user providers, so it can run none of them.
//!
//! The keys say which accounts an agent may use through Ryu; the files those
//! accounts live in must not be readable around that. Every limited agent's
//! engine therefore runs in the OS sandbox ([`AccountConfinement`],
//! [`crate::agent_sandbox::account_restricted_masks`]), in trusted folders
//! too: it hides Core's tokens, keys, databases (including the agent's own
//! account access), app data and logs, and, when the agent's model providers
//! are limited, every stored provider key and sign-in except the one its own
//! engine signs in with. On macOS it also denies the Keychain daemons and files
//! to the sandboxed process tree, except to Claude Code, whose own sign-in is a
//! Keychain item; a job the engine has launchd or LaunchServices start runs
//! outside the sandbox, so this is not a complete Keychain boundary (see
//! [`crate::agent_sandbox`]). Where the host has no sandbox, only Ryu's own engine
//! may run a limited agent, with its brokered tools only; other engines are
//! refused at launch.

use std::collections::HashSet;

use serde_json::Value;

use crate::agents::{AgentIdentityMode, AgentRecord};
use crate::sidecar::adapters::ComposioConnectionBinding;

/// One entry of an agent's account allowlist, in its canonical string form
/// `<kind>:<rest>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum AccountKey {
    /// `composio:<connected_account_id>`: one of the user's Composio accounts.
    Composio(String),
    /// `mcp:<profile_id>:<plugin_id>:<server>`: one MCP OAuth sign-in, keyed
    /// exactly like [`crate::connection_policy::mcp_connection_key`].
    Mcp(String),
    /// `provider:<id>`: one of the user's model providers (a Gateway registry
    /// id such as `openai`, `anthropic`, `genai` for Gemini, or `core`).
    Provider(String),
    /// `platform:treg`: the per-agent Treg switch.
    PlatformTreg,
    /// `platform:desktop`: control of the user's desktop (Ghost) and what
    /// Shadow captured from it, and the user's paired Ryu devices (`device.*`).
    /// It is the user's own machine and hardware, so an agent with only its own
    /// identity never gets it.
    PlatformDesktop,
    /// `mcp-secret:<server-or-plugin>`: an MCP server or app tool that calls
    /// out with one of the user's saved keys (a `secret:`, `vault:` or `env:`
    /// reference, or a key typed into the server's own settings). Keyed by the
    /// owning plugin id, or by the server name for a server the user added.
    McpSecret(String),
    /// `agent:<vault_account_id>`: one of the agent's own vault accounts.
    AgentAccount(String),
    /// `agent-composio:<connected_account_id>`: a Composio account connected
    /// to the agent's own entity, never one of the user's.
    AgentComposio(String),
}

impl AccountKey {
    /// Parse one allowlist entry. Anything malformed is `None`, and callers
    /// drop it, so a typo can only ever grant less.
    pub fn parse(raw: &str) -> Option<Self> {
        let (kind, rest) = raw.trim().split_once(':')?;
        if rest.is_empty() || rest.trim() != rest {
            return None;
        }
        match kind {
            "composio" => Some(Self::Composio(rest.to_owned())),
            "mcp" => {
                let (profile, plugin_and_server) = rest.split_once(':')?;
                let (plugin, server) = plugin_and_server.rsplit_once(':')?;
                (!profile.is_empty() && !plugin.is_empty() && !server.is_empty())
                    .then(|| Self::Mcp(rest.to_owned()))
            }
            "provider" => Some(Self::Provider(rest.to_owned())),
            "platform" => match rest {
                "treg" => Some(Self::PlatformTreg),
                "desktop" => Some(Self::PlatformDesktop),
                _ => None,
            },
            "mcp-secret" => Some(Self::McpSecret(rest.to_owned())),
            "agent" => Some(Self::AgentAccount(rest.to_owned())),
            "agent-composio" => Some(Self::AgentComposio(rest.to_owned())),
            _ => None,
        }
    }

    /// The canonical `<kind>:<rest>` form [`Self::parse`] reads back.
    pub fn to_key_string(&self) -> String {
        match self {
            Self::Composio(id) => format!("composio:{id}"),
            Self::Mcp(rest) => format!("mcp:{rest}"),
            Self::Provider(id) => format!("provider:{id}"),
            Self::PlatformTreg => "platform:treg".to_owned(),
            Self::PlatformDesktop => "platform:desktop".to_owned(),
            Self::McpSecret(id) => format!("mcp-secret:{id}"),
            Self::AgentAccount(id) => format!("agent:{id}"),
            Self::AgentComposio(id) => format!("agent-composio:{id}"),
        }
    }

    /// Whether the key names something the agent owns (its vault accounts and
    /// its own Composio accounts), as opposed to one of the user's accounts.
    pub fn is_agent_owned(&self) -> bool {
        matches!(self, Self::AgentAccount(_) | Self::AgentComposio(_))
    }

    /// The key for one MCP OAuth binding.
    pub fn mcp(profile_id: &str, plugin_id: &str, server_name: &str) -> Self {
        Self::Mcp(crate::connection_policy::mcp_connection_key(
            profile_id,
            plugin_id,
            server_name,
        ))
    }
}

/// How a Composio action is executed for an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposioRoute {
    /// As the user. `None` leaves Composio's default account for the user's
    /// entity in charge (today's behaviour); `Some` pins one allowed account.
    User {
        connected_account_id: Option<String>,
    },
    /// As the agent's own Composio entity, never the user's. `None` leaves
    /// Composio's default account for that entity in charge (an agent with no
    /// allowlist); `Some` pins one of its own accounts the allowlist names.
    Agent {
        entity: String,
        connected_account_id: Option<String>,
    },
    /// No account this agent may use can run the action.
    Denied,
}

/// The resolved account policy of one agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentAccountPolicy {
    mode: AgentIdentityMode,
    /// `None` is unrestricted; `Some` holds only the keys that parsed.
    allow: Option<HashSet<AccountKey>>,
}

impl AgentAccountPolicy {
    pub fn from_record(record: &AgentRecord) -> Self {
        Self::from_parts(record.identity_mode, record.account_access.as_deref())
    }

    pub fn from_parts(mode: AgentIdentityMode, account_access: Option<&[String]>) -> Self {
        Self {
            mode,
            allow: account_access.map(|keys| {
                keys.iter()
                    .filter_map(|key| AccountKey::parse(key))
                    .collect()
            }),
        }
    }

    /// A legacy agent: acts as the user with every account, as before.
    pub fn is_unrestricted(&self) -> bool {
        self.mode == AgentIdentityMode::Managed && self.allow.is_none()
    }

    /// Whether the agent may act with any of the user's accounts.
    pub fn allows_user_accounts(&self) -> bool {
        self.mode != AgentIdentityMode::Individual
    }

    /// Whether the agent may have and use accounts of its own. A legacy
    /// (unrestricted `managed`) agent keeps the vault agent accounts it could
    /// already create; a `managed` agent the user limited has none.
    pub fn allows_own_accounts(&self) -> bool {
        self.mode != AgentIdentityMode::Managed || self.allow.is_none()
    }

    /// Whether everything of the user's that this policy reaches, `ceiling`
    /// reaches too. Own accounts and an agent's own Composio entity belong to
    /// that agent, never the user, so only user-account reach is compared,
    /// plus Treg, which applies whatever the identity mode.
    /// A restricted agent may only delegate to, or create, an agent within it.
    pub fn is_within(&self, ceiling: &Self) -> bool {
        if ceiling.is_unrestricted() {
            return true;
        }
        if self.allows_treg() && !ceiling.allows_treg() {
            return false;
        }
        if !self.allows_user_accounts() {
            return true;
        }
        if !ceiling.allows_user_accounts() {
            return false;
        }
        match (&ceiling.allow, &self.allow) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some(ceiling_keys), Some(keys)) => keys
                .iter()
                .filter(|key| !key.is_agent_owned())
                .all(|key| ceiling_keys.contains(key)),
        }
    }

    /// The identity mode and allowlist an agent created by an agent with this
    /// policy starts with. `requested` is the mode the creator asked for; a
    /// restricted creator's allowlist always carries over (minus its own vault
    /// accounts, which stay its own), and a result wider than the creator is
    /// refused. An unrestricted creator gets exactly what it asked for.
    pub fn for_created_agent(
        &self,
        requested: Option<AgentIdentityMode>,
    ) -> Result<(AgentIdentityMode, Option<Vec<String>>), String> {
        if self.is_unrestricted() {
            return Ok((requested.unwrap_or_default(), None));
        }
        let mode = requested.unwrap_or(self.mode);
        let access = self.allow.as_ref().map(|keys| {
            let mut keys: Vec<String> = keys
                .iter()
                .filter(|key| !key.is_agent_owned())
                .map(AccountKey::to_key_string)
                .collect();
            keys.sort();
            keys
        });
        let created = Self::from_parts(mode, access.as_deref());
        if created.is_within(self) {
            Ok((mode, access))
        } else {
            Err(format!(
                "this agent's account access is limited, so it cannot create a '{}' agent that could use more of your accounts",
                mode.as_str()
            ))
        }
    }

    fn allowlisted(&self, key: &AccountKey) -> bool {
        self.allow.as_ref().is_none_or(|allow| allow.contains(key))
    }

    /// One of the user's Composio connected accounts.
    pub fn allows_composio_account(&self, connected_account_id: &str) -> bool {
        self.allows_user_accounts()
            && self.allowlisted(&AccountKey::Composio(connected_account_id.to_owned()))
    }

    /// One of the user's MCP OAuth sign-ins.
    pub fn allows_mcp(&self, profile_id: &str, plugin_id: &str, server_name: &str) -> bool {
        self.allows_user_accounts()
            && self.allowlisted(&AccountKey::mcp(profile_id, plugin_id, server_name))
    }

    /// An MCP server or app tool that calls out with one of the user's saved
    /// keys, by owning plugin id (or server name for a server the user added).
    pub fn allows_saved_key(&self, server_or_plugin: &str) -> bool {
        self.allows_user_accounts()
            && self.allowlisted(&AccountKey::McpSecret(server_or_plugin.to_owned()))
    }

    /// Control of the user's desktop (Ghost), Shadow's captures of it, and the
    /// user's paired Ryu devices.
    pub fn allows_desktop(&self) -> bool {
        self.allows_user_accounts() && self.allowlisted(&AccountKey::PlatformDesktop)
    }

    /// The Treg switch. Treg is a platform route with no per-user accounts, so
    /// only the allowlist decides it, whatever the identity mode.
    pub fn allows_treg(&self) -> bool {
        self.allowlisted(&AccountKey::PlatformTreg)
    }

    /// The user's model providers (Gateway registry ids) this agent's
    /// inference may use, sorted. `None` is unrestricted: a legacy agent, or a
    /// `mixed` one with no allowlist. An `individual` agent never uses the
    /// user's providers, so it always gets the empty list; any other agent with
    /// an allowlist gets exactly its `provider:` keys. Malformed ids are dropped.
    pub fn user_provider_access(&self) -> Option<Vec<String>> {
        if !self.allows_user_accounts() {
            return Some(Vec::new());
        }
        let allow = self.allow.as_ref()?;
        let mut ids: Vec<String> = allow
            .iter()
            .filter_map(|key| match key {
                AccountKey::Provider(id) if ryu_gw_credentials::is_provider_access_id(id) => {
                    Some(id.clone())
                }
                _ => None,
            })
            .collect();
        ids.sort();
        ids.dedup();
        Some(ids)
    }

    /// [`Self::user_provider_access`] in its `x-ryu-agent-provider-access`
    /// header form: comma-separated ids, or `none` for the empty list.
    pub fn provider_access_header(&self) -> Option<String> {
        self.user_provider_access()
            .map(|ids| provider_access_header_value(&ids))
    }

    /// Whether an app may make a managed provider call (`providers.call`) for
    /// this agent. `account_id` is the provider account the call names. A
    /// restricted agent may only use Treg when allowed, and Composio only on a
    /// named account it may use; any other provider, or no provider (which
    /// would let Gateway pick one), is refused.
    pub fn authorize_managed_provider_call(
        &self,
        provider: &str,
        account_id: Option<&str>,
    ) -> Result<(), String> {
        if self.is_unrestricted() {
            return Ok(());
        }
        match provider.trim() {
            "treg" if self.allows_treg() => Ok(()),
            "treg" => Err("this agent is not allowed to use Treg; allow it in the agent's account access".to_owned()),
            "composio" => match account_id.map(str::trim).filter(|id| !id.is_empty()) {
                Some(id) if self.allows_composio_account(id) => Ok(()),
                Some(_) => Err("this agent is not allowed to use that connected account; allow it in the agent's account access".to_owned()),
                None => Err("this agent's account access is limited, so an app must name the connected account it uses".to_owned()),
            },
            // `builtin` lets Gateway pick the provider per call, so a limited
            // agent gets the same answer as an unnamed call: name the provider.
            "" | "builtin" => Err("this agent's account access is limited, so an app must name the provider it calls".to_owned()),
            other => Err(format!(
                "this agent's account access is limited and does not cover the '{other}' provider"
            )),
        }
    }

    /// One of the agent's own vault accounts.
    pub fn allows_agent_account(&self, vault_account_id: &str) -> bool {
        self.allows_own_accounts()
            && self.allowlisted(&AccountKey::AgentAccount(vault_account_id.to_owned()))
    }

    /// One Composio account connected to the agent's own entity.
    pub fn allows_own_composio_account(&self, connected_account_id: &str) -> bool {
        self.allows_own_accounts()
            && self.allowlisted(&AccountKey::AgentComposio(connected_account_id.to_owned()))
    }

    /// Whether a Composio trigger may deliver events from one account on the
    /// agent's own entity. A `managed` agent ("Acts as you") never routes
    /// Composio through an own entity ([`Self::route_composio`]) and cannot
    /// connect own apps, so even a legacy one with no allowlist receives none.
    pub fn allows_own_composio_trigger(&self, connected_account_id: &str) -> bool {
        self.mode != AgentIdentityMode::Managed
            && self.allows_own_composio_account(connected_account_id)
    }

    /// Whether `entity` is exactly `agent_id`'s own Composio entity
    /// ([`Self::composio_agent_entity`]) for some non-empty owner. The agent id
    /// must follow a `:`, so `agent:u1:xa1` is not agent `a1`'s entity.
    pub fn is_own_composio_entity(entity: &str, agent_id: &str) -> bool {
        !agent_id.is_empty()
            && entity
                .strip_prefix("agent:")
                .and_then(|rest| rest.strip_suffix(agent_id))
                .and_then(|owner| owner.strip_suffix(':'))
                .is_some_and(|owner| !owner.is_empty())
    }

    /// Whether [`Self::route_composio`] needs the active accounts of the
    /// agent's own entity for the action's toolkit: only when an allowlist
    /// decides which of them the agent may use and names at least one.
    pub fn needs_own_composio_accounts(&self) -> bool {
        !self.is_unrestricted()
            && self.allows_own_accounts()
            && self.allow.as_ref().is_some_and(|allow| {
                allow
                    .iter()
                    .any(|key| matches!(key, AccountKey::AgentComposio(_)))
            })
    }

    /// The user's Identity Vault profiles this agent may act with: all bound
    /// ones, or none for an agent with its own identity.
    pub fn user_identity_profiles(&self, profile_ids: Vec<String>) -> Vec<String> {
        if self.allows_user_accounts() {
            profile_ids
        } else {
            Vec::new()
        }
    }

    /// Narrow a server-validated Composio scope to the accounts this agent may
    /// use. Never widens: the result is a subset of `scope`.
    pub fn narrow_composio_scope(
        &self,
        scope: &[ComposioConnectionBinding],
    ) -> Vec<ComposioConnectionBinding> {
        scope
            .iter()
            .filter(|binding| self.allows_composio_account(&binding.id))
            .cloned()
            .collect()
    }

    /// Whether [`Self::route_composio`] needs the user's active accounts for
    /// the action's toolkit.
    pub fn needs_user_composio_accounts(&self) -> bool {
        !self.is_unrestricted() && self.allows_user_accounts()
    }

    /// The agent's own Composio entity for one owner. It is distinct from every
    /// user entity, so an action run as it can never reach a user's connected
    /// account, and it is scoped to the owner the call runs for, so users who
    /// share one agent record on a shared node never share its accounts.
    pub fn composio_agent_entity(owner: &str, agent_id: &str) -> String {
        ryu_composio::connect::agent_entity(owner, agent_id)
    }

    /// Split an agent's own Composio entity back into `(owner, agent_id)`.
    /// The entity only selects which Composio account an action runs on; it
    /// is never a user. Usage on it is billed to the owner, so callers that
    /// meet one where a user id belongs map it with this. Agent ids never
    /// contain `:` while user ids may, so the agent id is the last segment.
    pub fn parse_composio_agent_entity(entity: &str) -> Option<(&str, &str)> {
        let (owner, agent_id) = entity.strip_prefix("agent:")?.rsplit_once(':')?;
        (!owner.is_empty() && !agent_id.is_empty()).then_some((owner, agent_id))
    }

    /// Decide how a Composio action runs when no narrower scope was set.
    /// `user_accounts` are the user's active accounts for the action's toolkit
    /// (ignored unless [`Self::needs_user_composio_accounts`]); `own_accounts`
    /// are the active accounts of the agent's own entity for that toolkit
    /// (ignored unless [`Self::needs_own_composio_accounts`]).
    pub fn route_composio(
        &self,
        owner: &str,
        agent_id: &str,
        user_accounts: &[ComposioConnectionBinding],
        own_accounts: &[ComposioConnectionBinding],
    ) -> ComposioRoute {
        if self.is_unrestricted() {
            return ComposioRoute::User {
                connected_account_id: None,
            };
        }
        let agent = || {
            let entity = Self::composio_agent_entity(owner, agent_id);
            if self.allow.is_none() {
                return ComposioRoute::Agent {
                    entity,
                    connected_account_id: None,
                };
            }
            own_accounts
                .iter()
                .find(|binding| self.allows_own_composio_account(&binding.id))
                .map_or(ComposioRoute::Denied, |binding| ComposioRoute::Agent {
                    entity,
                    connected_account_id: Some(binding.id.clone()),
                })
        };
        if !self.allows_user_accounts() {
            return agent();
        }
        let allowed = user_accounts
            .iter()
            .find(|binding| self.allows_composio_account(&binding.id));
        match (allowed, self.mode) {
            // Every user account is allowed: keep Composio's own default pick.
            (Some(_), _) if self.allow.is_none() => ComposioRoute::User {
                connected_account_id: None,
            },
            (Some(binding), _) => ComposioRoute::User {
                connected_account_id: Some(binding.id.clone()),
            },
            (None, AgentIdentityMode::Mixed) => agent(),
            (None, _) => ComposioRoute::Denied,
        }
    }
}

/// Whether a Gateway provider slot uses none of the user's own credentials, so
/// an agent's model provider access never limits it: the keyless local engine,
/// the classify tier, Ryu's own supply (Ryu credits), or a keyless SDK route.
/// The same rule as the Gateway's agent provider check
/// (`provider_needs_no_user_credential` in its inference governance), built
/// from the same shared lists.
pub fn provider_needs_no_user_credential(provider: &str) -> bool {
    ryu_gw_router::slot_uses_no_user_credential(provider)
        || ryu_gw_credentials::sdk_provider_by_id(provider)
            .is_some_and(|sdk| sdk.auth_kind == ryu_gw_credentials::SdkAuthKind::NoAuth)
}

/// The `x-ryu-agent-provider-access` value for a resolved provider list.
pub fn provider_access_header_value(ids: &[String]) -> String {
    if ids.is_empty() {
        "none".to_owned()
    } else {
        ids.join(",")
    }
}

/// The provider access of one agent, read from its current record. A missing
/// record is unrestricted, as everywhere else in Core; a store error fails
/// closed to no user providers at all.
pub async fn provider_access_for_agent(
    store: &crate::agents::AgentStore,
    agent_id: &str,
) -> Option<Vec<String>> {
    match store.get(agent_id).await {
        Ok(Some(record)) => AgentAccountPolicy::from_record(&record).user_provider_access(),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(%error, agent_id, "agent provider access: store lookup failed; allowing no user providers");
            Some(Vec::new())
        }
    }
}

/// What the OS sandbox hides from an agent's engine process because of the
/// agent's account access, whatever the folder's trust. See
/// [`crate::agent_sandbox::account_restricted_masks`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AccountConfinement {
    /// A legacy agent (acts as the user with every account): nothing extra.
    #[default]
    None,
    /// Any limited agent: Core's tokens, keys, databases, state, app data and
    /// logs, so it can neither borrow Core's own credentials nor edit its own
    /// account access on disk.
    CoreState,
    /// A limited agent whose model providers are limited as well: also every
    /// stored sign-in and key for the user's model providers (Ryu's Pi config,
    /// the Gateway's provider config, Codex homes and the user's own harness
    /// logins), except the one the engine itself signs in with.
    CoreStateAndProviders,
}

impl AccountConfinement {
    /// The confinement an agent with `policy` runs under.
    pub fn for_policy(policy: &AgentAccountPolicy) -> Self {
        if policy.is_unrestricted() {
            Self::None
        } else if policy.user_provider_access().is_some() {
            Self::CoreStateAndProviders
        } else {
            Self::CoreState
        }
    }

    pub fn is_confined(self) -> bool {
        self != Self::None
    }

    pub fn hides_providers(self) -> bool {
        self == Self::CoreStateAndProviders
    }

    /// Stable tag for an ACP pool key: a policy change must start a fresh
    /// process, since the sandbox is fixed when the engine spawns.
    pub fn key(self) -> &'static str {
        match self {
            Self::None => "account-unconfined",
            Self::CoreState => "account-core-state",
            Self::CoreStateAndProviders => "account-core-state-providers",
        }
    }
}

/// The account confinement of one agent, read from its current record. A
/// missing record is unrestricted, as everywhere else in Core; a store error
/// fails closed to the strictest confinement.
pub async fn account_confinement_for_agent(
    store: &crate::agents::AgentStore,
    agent_id: &str,
) -> AccountConfinement {
    match store.get(agent_id).await {
        Ok(Some(record)) => {
            AccountConfinement::for_policy(&AgentAccountPolicy::from_record(&record))
        }
        Ok(None) => AccountConfinement::None,
        Err(error) => {
            tracing::warn!(%error, agent_id, "agent account confinement: store lookup failed; confining fully");
            AccountConfinement::CoreStateAndProviders
        }
    }
}

/// Sign-in and key stores of the user's own model-provider harnesses under
/// `home`. Directories hide everything beneath them. `.aws/sso` holds the
/// AWS Builder ID and IAM Identity Center sign-ins Kiro uses.
pub const HOME_PROVIDER_LOGIN_PATHS: &[&str] = &[
    ".codex",
    ".claude",
    ".claude.json",
    ".pi/agent",
    ".gemini",
    ".kiro",
    ".aws/sso",
    ".openclaw",
    ".hermes",
];

/// The Kiro CLI's data folder (its sign-in database) under the OS data dir.
pub const KIRO_CLI_DATA_DIR: &str = "kiro-cli";

/// Kiro's own token file in the AWS SSO cache.
const KIRO_SSO_TOKEN_FILE: &str = "kiro-auth-token.json";

/// The Kiro CLI's sign-in stores in the user's own home: its config home, its
/// data folder, and, in the AWS SSO cache, only Kiro's own token file and the
/// client registration that token names. The rest of that cache holds the
/// user's IAM Identity Center sign-ins for every AWS account, so it stays
/// hidden. Kept visible only for a Kiro CLI launch that signs in from the
/// user's home.
pub fn user_kiro_sign_in_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".kiro"));
        let cache = home.join(".aws").join("sso").join("cache");
        let token = cache.join(KIRO_SSO_TOKEN_FILE);
        if let Some(registration) = kiro_client_registration_file(&token) {
            paths.push(cache.join(registration));
        }
        paths.push(token);
    }
    paths.extend(dirs::data_dir().map(|data| data.join(KIRO_CLI_DATA_DIR)));
    paths
}

/// The `<clientIdHash>.json` client registration Kiro's token file names, when
/// it names one in the plain hex form AWS uses. Anything else names nothing,
/// so a token file cannot point the keep at another cache entry.
fn kiro_client_registration_file(token: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(token).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let hash = parsed.get("clientIdHash")?.as_str()?;
    (!hash.is_empty() && hash.len() <= 128 && hash.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| format!("{hash}.json"))
}

/// Every store outside the data dir's Core folders that holds one of the
/// user's model-provider keys or sign-ins: Ryu's managed Pi config (provider
/// keys, OAuth logins and account sessions), the folder with the Gateway's
/// provider config, both Ryu-managed Codex homes, and the user's own harness
/// logins (including the Kiro CLI's data folder). A limited agent's limited Pi config is a sibling of the managed one,
/// never inside it, so hiding the managed dir leaves it readable.
pub fn user_provider_stores() -> Vec<std::path::PathBuf> {
    let mut stores = vec![
        crate::pi_config::config_dir(),
        crate::paths::config_dir(),
        crate::codex_config::codex_home(),
        crate::codex_config::safety_home(),
        crate::codex_config::user_codex_home(),
    ];
    stores.extend(crate::server::gateway_config_path());
    if let Some(home) = dirs::home_dir() {
        stores.extend(HOME_PROVIDER_LOGIN_PATHS.iter().map(|path| home.join(path)));
    }
    stores.extend(dirs::data_dir().map(|data| data.join(KIRO_CLI_DATA_DIR)));
    stores.sort();
    stores.dedup();
    stores
}

/// Whether a turn may go straight to a provider, bypassing Gateway. A limited
/// agent may not use a provider key that way, because only Gateway enforces
/// which of the user's providers it may use; a keyless endpoint (a local
/// engine) carries no account and stays allowed.
pub fn direct_provider_permitted(
    provider_access: Option<&[String]>,
    api_key: Option<&str>,
) -> bool {
    provider_access.is_none() || api_key.is_none_or(|key| key.trim().is_empty())
}

/// How the engine Core is about to launch for an agent reaches its model
/// provider. Only Gateway can enforce `provider:<id>` keys, so an engine that
/// calls its provider itself is allowed for a limited agent only when its one
/// vendor is in the agent's list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderReach {
    /// Every model call goes through Core's Gateway on a bearer that carries
    /// the agent's provider access, so Gateway enforces it.
    Gateway,
    /// The engine calls one vendor itself with the user's own sign-in or key
    /// (Claude Code, Codex on a ChatGPT sign-in, Gemini CLI, Kiro). The value is
    /// that vendor's Gateway registry id, the same id a `provider:<id>` key uses.
    Vendor(&'static str),
    /// The engine calls a provider Core cannot name itself. `routable` is true
    /// when turning the agent's Gateway routing on would send it through
    /// Gateway instead.
    SelfCalled { routable: bool },
}

/// The user-facing name of a vendor a self-calling engine signs in to.
fn vendor_label(vendor: &str) -> &str {
    match vendor {
        "anthropic" => "Anthropic",
        "openai" => "OpenAI",
        "genai" => "Google Gemini",
        "kiro" => "Kiro",
        other => other,
    }
}

/// Whether an agent with `provider_access` (`None` = unrestricted) may launch
/// an engine that reaches its provider as `reach`. `engine` names the engine in
/// the refusal, which is returned as the user-facing reason. A Vendor engine
/// uses whatever credential it holds for that vendor, so allowing the vendor
/// allows all of the user's access to it through that engine; Gateway does not
/// narrow it further.
pub fn self_called_provider_permitted(
    provider_access: Option<&[String]>,
    reach: ProviderReach,
    engine: &str,
) -> Result<(), String> {
    let Some(allowed) = provider_access else {
        return Ok(());
    };
    match reach {
        ProviderReach::Gateway => Ok(()),
        ProviderReach::Vendor(vendor) if allowed.iter().any(|id| id == vendor) => Ok(()),
        ProviderReach::Vendor(vendor) => {
            let provider = vendor_label(vendor);
            Err(format!(
                "{engine} calls {provider} itself, using your own sign-in or key, and this agent's account access doesn't allow {provider}. Allow {provider} under Model providers in the agent's account access (an agent with only its own identity can't use your sign-ins, so choose Acts as you or Both first), or choose an engine that runs through Ryu's Gateway."
            ))
        }
        ProviderReach::SelfCalled { routable: true } => Err(format!(
            "{engine} calls its model provider itself while its Gateway routing is off, so Ryu can't limit which of your providers it uses. Turn Gateway routing on for this agent, or remove the model provider limit from its account access."
        )),
        ProviderReach::SelfCalled { routable: false } => Err(format!(
            "{engine} calls its model provider itself, so Ryu can't limit which of your providers it uses, and an agent with limited model providers can't run it. Choose an engine that runs through Ryu's Gateway, or remove the model provider limit from its account access."
        )),
    }
}

/// Whether `record` stands in for a remote A2A peer (an `a2a:<peer>` engine).
/// Its turns run on another node, under that node's own accounts, and are
/// sent there with the peer credential the user saved on this node. Its
/// identity mode and account access therefore describe nothing it does, and
/// clients show a note instead of offering the choice.
pub fn is_remote_peer_agent(record: &AgentRecord) -> bool {
    record
        .engine
        .as_deref()
        .is_some_and(|engine| engine.trim().starts_with("a2a:"))
}

/// Whether an agent with the `caller` policy may hand work to `target`: an
/// unrestricted caller may hand work to any agent, and a restricted one only
/// to an agent whose reach into the user's accounts is within its own.
/// Identity Vault profiles are the user's logins too, so a target that acts as
/// the user may only carry profiles in `caller_profiles` (the caller's own
/// bound profiles). A remote A2A peer is never within a restricted caller,
/// whatever its saved identity mode: handing it work sends that work off this
/// node with the user's saved peer credential.
pub fn may_delegate_to(
    caller: &AgentAccountPolicy,
    caller_profiles: &[String],
    target: &AgentRecord,
) -> bool {
    if caller.is_unrestricted() {
        return true;
    }
    if is_remote_peer_agent(target) {
        return false;
    }
    let policy = AgentAccountPolicy::from_record(target);
    policy.is_within(caller)
        && (!policy.allows_user_accounts()
            || target
                .identity_profile_ids
                .iter()
                .all(|profile| caller_profiles.contains(profile)))
}

/// The refusal for work a restricted agent tried to hand to `target_agent_id`.
pub fn delegation_refusal(target_agent_id: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "agent '{target_agent_id}' may use accounts this agent is not allowed to use, so this agent cannot hand work to it"
    )
}

/// Refuse a call that would hand an MCP server or app tool one of the user's
/// saved keys when `policy` does not allow it. `None` is no calling agent (or
/// no record), which is unrestricted as everywhere else in Core.
pub fn require_saved_key_access(
    policy: Option<&AgentAccountPolicy>,
    server_or_plugin: &str,
) -> anyhow::Result<()> {
    match policy {
        Some(policy) if !policy.allows_saved_key(server_or_plugin) => {
            if policy.allows_user_accounts() {
                anyhow::bail!(
                    "'{server_or_plugin}' uses one of your saved keys, and this agent's account access doesn't allow it; allow it under Services using your saved keys in the agent's account access"
                )
            }
            anyhow::bail!(
                "'{server_or_plugin}' uses one of your saved keys, and this agent has its own identity, so it never uses your keys"
            )
        }
        _ => Ok(()),
    }
}

/// Refuse desktop control (Ghost) and Shadow's captures when `policy` does not
/// allow `platform:desktop`. `None` is unrestricted, as above.
pub fn require_desktop_access(policy: Option<&AgentAccountPolicy>) -> anyhow::Result<()> {
    match policy {
        Some(policy) if !policy.allows_desktop() => {
            if policy.allows_user_accounts() {
                anyhow::bail!(
                    "this agent's account access doesn't allow control of your desktop; allow it under Control of your desktop in the agent's account access"
                )
            }
            anyhow::bail!(
                "this agent has its own identity, so it cannot control your desktop or read what Shadow captured from it"
            )
        }
        _ => Ok(()),
    }
}

/// Refuse delegation that would let a restricted agent act through an agent
/// with wider reach into the user's accounts. Every task, routine and handoff
/// runs under its target's own record, so without this an `individual` or
/// allowlisted agent could hand work to the (unrestricted) default agent. A
/// target without a record would run unrestricted, so it is refused too, and
/// so is every target when there is no agent store to check against.
/// `caller_agent_id` names the caller's record, whose Identity Vault profiles
/// bound the target's ([`may_delegate_to`]); without it the caller has none.
pub async fn require_delegation_within_policy(
    agent_store: Option<&crate::agents::AgentStore>,
    caller: Option<&AgentAccountPolicy>,
    caller_agent_id: Option<&str>,
    target_agent_ids: impl IntoIterator<Item = String>,
) -> anyhow::Result<()> {
    let Some(caller) = caller.filter(|policy| !policy.is_unrestricted()) else {
        return Ok(());
    };
    let store = agent_store
        .ok_or_else(|| anyhow::anyhow!("agent account policy cannot be checked: no agent store"))?;
    let caller_profiles = match caller_agent_id {
        Some(id) if caller.allows_user_accounts() => store
            .get(id)
            .await?
            .map(|record| record.identity_profile_ids)
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    for target in target_agent_ids {
        let within = store
            .get(&target)
            .await?
            .is_some_and(|record| may_delegate_to(caller, &caller_profiles, &record));
        if !within {
            return Err(delegation_refusal(&target));
        }
    }
    Ok(())
}

/// The active connected accounts in a `composio_connect::list_connections`
/// response, as server-validated bindings with lowercase toolkits.
pub(crate) fn active_composio_bindings(listed: &Value) -> Vec<ComposioConnectionBinding> {
    listed
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|connection| {
            let id = connection.get("id").and_then(Value::as_str)?.trim();
            let toolkit = connection.get("toolkit").and_then(Value::as_str)?.trim();
            let active = connection
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            (active && !id.is_empty() && !toolkit.is_empty()).then(|| ComposioConnectionBinding {
                id: id.to_owned(),
                toolkit: toolkit.to_ascii_lowercase(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn binding(id: &str, toolkit: &str) -> ComposioConnectionBinding {
        ComposioConnectionBinding {
            id: id.to_owned(),
            toolkit: toolkit.to_owned(),
        }
    }

    fn policy(mode: AgentIdentityMode, keys: Option<&[&str]>) -> AgentAccountPolicy {
        let keys: Option<Vec<String>> =
            keys.map(|keys| keys.iter().map(|key| (*key).to_owned()).collect());
        AgentAccountPolicy::from_parts(mode, keys.as_deref())
    }

    fn agent_record(engine: &str, mode: &str, account_access: Option<&[&str]>) -> AgentRecord {
        serde_json::from_value(json!({
            "id": "target",
            "name": "Target",
            "engine": engine,
            "identity_mode": mode,
            "account_access": account_access,
        }))
        .expect("agent record")
    }

    #[test]
    fn a_restricted_agent_never_hands_work_to_a_remote_peer() {
        use AgentIdentityMode::{Individual, Managed, Mixed};
        let limited = policy(Mixed, Some(&["composio:ca_1"]));
        let own_identity = policy(Individual, None);
        let unrestricted = policy(Managed, None);
        for mode in ["managed", "individual", "mixed"] {
            for access in [None, Some(&[][..])] {
                let peer = agent_record(" a2a:peer-1", mode, access);
                assert!(is_remote_peer_agent(&peer));
                assert!(!may_delegate_to(&limited, &[], &peer), "{mode} {access:?}");
                assert!(
                    !may_delegate_to(&own_identity, &[], &peer),
                    "{mode} {access:?}"
                );
                assert!(
                    may_delegate_to(&unrestricted, &[], &peer),
                    "{mode} {access:?}"
                );
            }
        }
        // The same narrow policy on a local engine stays within any caller.
        let local = agent_record("acp:pi", "individual", Some(&[]));
        assert!(!is_remote_peer_agent(&local));
        assert!(may_delegate_to(&limited, &[], &local));
        assert!(may_delegate_to(&own_identity, &[], &local));
    }

    #[test]
    fn account_confinement_follows_the_policy() {
        use AgentIdentityMode::{Individual, Managed, Mixed};
        let cases: &[(AgentIdentityMode, Option<&[&str]>, AccountConfinement)] = &[
            // A legacy agent runs exactly as before.
            (Managed, None, AccountConfinement::None),
            // Limited, but its model providers are not: Core's data only.
            (Mixed, None, AccountConfinement::CoreState),
            // Any allowlist limits model providers too, even one that names some.
            (
                Managed,
                Some(&[]),
                AccountConfinement::CoreStateAndProviders,
            ),
            (
                Managed,
                Some(&["provider:anthropic", "composio:ca_1"]),
                AccountConfinement::CoreStateAndProviders,
            ),
            (
                Mixed,
                Some(&["composio:ca_1"]),
                AccountConfinement::CoreStateAndProviders,
            ),
            // An agent with only its own identity has none of the user's providers.
            (Individual, None, AccountConfinement::CoreStateAndProviders),
        ];
        for (mode, keys, expected) in cases {
            let confinement = AccountConfinement::for_policy(&policy(*mode, *keys));
            assert_eq!(confinement, *expected, "{mode:?} {keys:?}");
            assert_eq!(
                confinement.is_confined(),
                *expected != AccountConfinement::None
            );
        }
        let keys: HashSet<_> = [
            AccountConfinement::None,
            AccountConfinement::CoreState,
            AccountConfinement::CoreStateAndProviders,
        ]
        .map(AccountConfinement::key)
        .into_iter()
        .collect();
        assert_eq!(keys.len(), 3, "each confinement gets its own ACP pool key");
    }

    #[tokio::test]
    async fn account_confinement_is_read_from_the_current_record() {
        let store = crate::agents::AgentStore::open_in_memory(
            &crate::sidecar::adapters::AcpAgentRegistry::new(),
        )
        .unwrap();
        let id = store
            .create(crate::agents::CreateAgent {
                name: "Limited".into(),
                ..Default::default()
            })
            .await
            .unwrap()
            .id;
        assert_eq!(
            account_confinement_for_agent(&store, &id).await,
            AccountConfinement::None
        );
        store
            .update(
                &id,
                crate::agents::UpdateAgent {
                    identity_mode: Some(AgentIdentityMode::Mixed),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            account_confinement_for_agent(&store, &id).await,
            AccountConfinement::CoreState
        );
        store
            .update(
                &id,
                crate::agents::UpdateAgent {
                    account_access: Some(Some(vec!["provider:openai".into()])),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            account_confinement_for_agent(&store, &id).await,
            AccountConfinement::CoreStateAndProviders
        );
        assert_eq!(
            account_confinement_for_agent(&store, "missing").await,
            AccountConfinement::None
        );
    }

    #[test]
    fn provider_stores_cover_every_user_sign_in_location() {
        let stores = user_provider_stores();
        assert!(stores.contains(&crate::pi_config::config_dir()));
        assert!(stores.contains(&crate::paths::config_dir()));
        assert!(stores.contains(&crate::codex_config::codex_home()));
        assert!(stores.contains(&crate::codex_config::safety_home()));
        assert!(
            !stores.contains(&crate::pi_config::limited_agents_root()),
            "a limited agent's own Pi config stays readable"
        );
        if let Some(home) = dirs::home_dir() {
            for login in HOME_PROVIDER_LOGIN_PATHS {
                assert!(stores.contains(&home.join(login)), "{login}");
            }
            for login in [".kiro", ".aws/sso", ".openclaw", ".hermes"] {
                assert!(HOME_PROVIDER_LOGIN_PATHS.contains(&login), "{login}");
            }
        }
        if let Some(data) = dirs::data_dir() {
            assert!(stores.contains(&data.join(KIRO_CLI_DATA_DIR)));
        }
        // Every Kiro sign-in store is one of the hidden stores, so only a
        // Kiro launch's own keep can leave it visible.
        for kiro in user_kiro_sign_in_paths() {
            assert!(
                stores.iter().any(|store| kiro.starts_with(store)),
                "{}",
                kiro.display()
            );
        }
        // Only Kiro's own entries of the AWS SSO cache are its sign-in; the
        // user's other AWS sign-ins there are not.
        if let Some(home) = dirs::home_dir() {
            let sso = home.join(".aws").join("sso");
            let kiro = user_kiro_sign_in_paths();
            assert!(!kiro.contains(&sso));
            assert!(!kiro.contains(&sso.join("cache")));
            assert!(kiro.contains(&sso.join("cache").join(KIRO_SSO_TOKEN_FILE)));
        }
    }

    #[test]
    fn kiro_keeps_only_the_client_registration_its_token_names() {
        let dir =
            std::env::temp_dir().join(format!("ryu-kiro-token-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let token = dir.join(KIRO_SSO_TOKEN_FILE);
        assert_eq!(kiro_client_registration_file(&token), None);
        std::fs::write(&token, r#"{"clientIdHash":"0a1b2c3d"}"#).unwrap();
        assert_eq!(
            kiro_client_registration_file(&token).as_deref(),
            Some("0a1b2c3d.json")
        );
        for forged in [
            r#"{"clientIdHash":"../credentials"}"#,
            r#"{"clientIdHash":""}"#,
            "{}",
        ] {
            std::fs::write(&token, forged).unwrap();
            assert_eq!(kiro_client_registration_file(&token), None, "{forged}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn managed_provider_calls_follow_the_allowlist() {
        use AgentIdentityMode::{Individual, Managed, Mixed};
        let cases: &[(AgentIdentityMode, Option<&[&str]>, &str, Option<&str>, bool)] = &[
            // Unrestricted: any provider, even an unnamed one.
            (Managed, None, "treg", None, true),
            (Managed, None, "composio", None, true),
            (Managed, None, "other", None, true),
            (Managed, None, "", None, true),
            // An empty allowlist denies Treg.
            (Managed, Some(&[]), "treg", None, false),
            (Managed, Some(&["platform:treg"]), "treg", None, true),
            (Managed, Some(&["platform:treg"]), "composio", None, false),
            (
                Managed,
                Some(&["platform:treg"]),
                "composio",
                Some("ca_1"),
                false,
            ),
            // The identity mode does not govern Treg; only the allowlist does.
            (Individual, None, "treg", None, true),
            (Individual, None, "composio", Some("ca_1"), false),
            (
                Individual,
                Some(&["composio:ca_1"]),
                "composio",
                Some("ca_1"),
                false,
            ),
            (Individual, Some(&["composio:ca_1"]), "treg", None, false),
            (
                Mixed,
                Some(&["composio:ca_1"]),
                "composio",
                Some("ca_1"),
                true,
            ),
            (
                Mixed,
                Some(&["composio:ca_1"]),
                "composio",
                Some("ca_2"),
                false,
            ),
            (
                Mixed,
                Some(&["composio:ca_1"]),
                "composio",
                Some(" "),
                false,
            ),
            (Mixed, None, "composio", Some("ca_9"), true),
            // A restricted agent must name a provider it is allowed.
            (Mixed, None, "", None, false),
            (Mixed, None, "builtin", None, false),
            (Managed, Some(&["platform:treg"]), "builtin", None, false),
            (Mixed, None, "openai", None, false),
            (Managed, Some(&["platform:treg"]), "", None, false),
        ];
        for (mode, keys, provider, account, allowed) in cases {
            assert_eq!(
                policy(*mode, *keys)
                    .authorize_managed_provider_call(provider, *account)
                    .is_ok(),
                *allowed,
                "{mode:?} {keys:?} {provider:?} {account:?}"
            );
        }
    }

    #[test]
    fn user_provider_access_follows_mode_and_provider_keys() {
        use AgentIdentityMode::{Individual, Managed, Mixed};
        let cases: &[(AgentIdentityMode, Option<&[&str]>, Option<&str>)] = &[
            // Unrestricted agents keep every provider.
            (Managed, None, None),
            (Mixed, None, None),
            // An allowlist keeps exactly its provider keys.
            (
                Managed,
                Some(&["provider:openai", "composio:x", "platform:treg"]),
                Some("openai"),
            ),
            (Managed, Some(&[]), Some("none")),
            (
                Mixed,
                Some(&["provider:genai", "provider:anthropic", "provider:genai"]),
                Some("anthropic,genai"),
            ),
            // Its own identity never uses the user's providers.
            (Individual, None, Some("none")),
            (Individual, Some(&["provider:openai"]), Some("none")),
            // Malformed ids grant nothing.
            (
                Managed,
                Some(&[
                    "provider:a,b",
                    "provider:*",
                    "provider:OpenAI",
                    "provider:core",
                ]),
                Some("core"),
            ),
        ];
        for (mode, keys, header) in cases {
            assert_eq!(
                policy(*mode, *keys).provider_access_header().as_deref(),
                *header,
                "{mode:?} {keys:?}"
            );
        }
    }

    #[test]
    fn self_called_providers_need_their_vendor_key() {
        let anthropic = vec!["anthropic".to_owned()];
        let openai = vec!["openai".to_owned()];
        let vendors = ["anthropic", "openai", "genai", "kiro"];
        // Unrestricted agents launch anything.
        for reach in vendors.iter().map(|v| ProviderReach::Vendor(v)).chain([
            ProviderReach::Gateway,
            ProviderReach::SelfCalled { routable: true },
            ProviderReach::SelfCalled { routable: false },
        ]) {
            assert_eq!(self_called_provider_permitted(None, reach, "E"), Ok(()));
        }
        // Gateway-routed engines are enforced by Gateway itself.
        for access in [&[][..], &anthropic[..], &openai[..]] {
            assert_eq!(
                self_called_provider_permitted(Some(access), ProviderReach::Gateway, "E"),
                Ok(())
            );
        }
        // A vendor engine needs exactly its vendor's key.
        assert_eq!(
            self_called_provider_permitted(
                Some(&anthropic),
                ProviderReach::Vendor("anthropic"),
                "Claude Code"
            ),
            Ok(())
        );
        assert_eq!(
            self_called_provider_permitted(Some(&openai), ProviderReach::Vendor("openai"), "Codex"),
            Ok(())
        );
        for (access, vendor, label) in [
            (&[][..], "anthropic", "Anthropic"),
            (&openai[..], "anthropic", "Anthropic"),
            (&anthropic[..], "openai", "OpenAI"),
            (&anthropic[..], "genai", "Google Gemini"),
            (&openai[..], "kiro", "Kiro"),
        ] {
            let reason = self_called_provider_permitted(
                Some(access),
                ProviderReach::Vendor(vendor),
                "Engine",
            )
            .unwrap_err();
            assert!(reason.starts_with("Engine calls"), "{reason}");
            assert!(reason.contains(label), "{reason}");
            assert!(reason.contains("account access"), "{reason}");
        }
        // An engine Core can't name is refused whatever the list holds.
        for access in [&[][..], &anthropic[..], &openai[..]] {
            for routable in [true, false] {
                let reason = self_called_provider_permitted(
                    Some(access),
                    ProviderReach::SelfCalled { routable },
                    "Engine",
                )
                .unwrap_err();
                assert!(reason.contains("account access"), "{reason}");
                assert_eq!(
                    reason.contains("Turn Gateway routing on"),
                    routable,
                    "{reason}"
                );
            }
        }
    }

    #[test]
    fn direct_provider_keys_need_an_unrestricted_agent() {
        let limited = vec!["openai".to_owned()];
        assert!(!direct_provider_permitted(Some(&limited), Some("sk-1")));
        assert!(!direct_provider_permitted(Some(&[]), Some("sk-1")));
        assert!(direct_provider_permitted(Some(&limited), None));
        assert!(direct_provider_permitted(Some(&limited), Some(" ")));
        assert!(direct_provider_permitted(None, Some("sk-1")));
    }

    #[test]
    fn parses_every_key_kind_and_rejects_malformed_entries() {
        assert_eq!(
            AccountKey::parse("composio:ca_1"),
            Some(AccountKey::Composio("ca_1".into()))
        );
        assert_eq!(
            AccountKey::parse(" mcp:default:@ryu/notion:notion "),
            Some(AccountKey::mcp("default", "@ryu/notion", "notion"))
        );
        assert_eq!(
            AccountKey::parse("provider:openai"),
            Some(AccountKey::Provider("openai".into()))
        );
        assert_eq!(
            AccountKey::parse("platform:treg"),
            Some(AccountKey::PlatformTreg)
        );
        assert_eq!(
            AccountKey::parse("agent:acc_1"),
            Some(AccountKey::AgentAccount("acc_1".into()))
        );
        assert_eq!(
            AccountKey::parse("platform:desktop"),
            Some(AccountKey::PlatformDesktop)
        );
        assert_eq!(
            AccountKey::parse("mcp-secret:@ryu/exa"),
            Some(AccountKey::McpSecret("@ryu/exa".into()))
        );
        for key in [
            "platform:desktop",
            "mcp-secret:@ryu/exa",
            "mcp-secret:my-server",
        ] {
            assert_eq!(
                AccountKey::parse(key).map(|parsed| parsed.to_key_string()),
                Some(key.to_owned())
            );
        }
        for malformed in [
            "mcp-secret:",
            "mcp-secret: x",
            "platform:ghost",
            "",
            "composio",
            "composio:",
            "Composio:ca_1",
            "composio: ca_1",
            "mcp:default:notion",
            "mcp::plugin:server",
            "platform:composio",
            "vault:acc_1",
        ] {
            assert_eq!(AccountKey::parse(malformed), None, "{malformed}");
        }
    }

    #[test]
    fn saved_keys_and_desktop_follow_identity_mode_and_allowlist() {
        use AgentIdentityMode::{Individual, Managed, Mixed};
        let legacy = policy(Managed, None);
        assert!(legacy.allows_saved_key("@ryu/exa"));
        assert!(legacy.allows_desktop());
        assert!(require_saved_key_access(Some(&legacy), "@ryu/exa").is_ok());
        assert!(require_desktop_access(Some(&legacy)).is_ok());
        // No calling agent (or no record) stays unrestricted.
        assert!(require_saved_key_access(None, "@ryu/exa").is_ok());
        assert!(require_desktop_access(None).is_ok());

        // Its own identity never reaches the user's keys or desktop, even when
        // an allowlist names them.
        for own in [
            policy(Individual, None),
            policy(
                Individual,
                Some(&["mcp-secret:@ryu/exa", "platform:desktop"]),
            ),
        ] {
            assert!(!own.allows_saved_key("@ryu/exa"));
            assert!(!own.allows_desktop());
            let refusal = require_saved_key_access(Some(&own), "@ryu/exa")
                .unwrap_err()
                .to_string();
            assert!(refusal.contains("its own identity"), "{refusal}");
            assert!(require_desktop_access(Some(&own)).is_err());
        }

        // A limited agent gets exactly what is listed.
        let limited = policy(Managed, Some(&["mcp-secret:@ryu/exa", "platform:treg"]));
        assert!(limited.allows_saved_key("@ryu/exa"));
        assert!(!limited.allows_saved_key("my-server"));
        assert!(!limited.allows_desktop());
        let refusal = require_saved_key_access(Some(&limited), "my-server")
            .unwrap_err()
            .to_string();
        assert!(
            refusal.contains("Services using your saved keys"),
            "{refusal}"
        );
        let refusal = require_desktop_access(Some(&limited))
            .unwrap_err()
            .to_string();
        assert!(refusal.contains("Control of your desktop"), "{refusal}");
        let desktop = policy(Mixed, Some(&["platform:desktop"]));
        assert!(desktop.allows_desktop());
        assert!(!desktop.allows_saved_key("@ryu/exa"));
        // `mixed` with no allowlist acts as the user with every account.
        assert!(policy(Mixed, None).allows_desktop());
        assert!(policy(Mixed, None).allows_saved_key("my-server"));

        // Both are the user's, so a creator limited without them cannot hand
        // them to an agent it creates or delegates to.
        let wider = policy(Managed, Some(&["platform:desktop"]));
        assert!(!wider.is_within(&policy(Managed, Some(&["platform:treg"]))));
        assert!(wider.is_within(&policy(Managed, Some(&["platform:desktop"]))));
    }

    #[test]
    fn legacy_policy_is_unrestricted() {
        let legacy = policy(AgentIdentityMode::Managed, None);
        assert!(legacy.is_unrestricted());
        assert!(legacy.allows_composio_account("anything"));
        assert!(legacy.allows_mcp("default", "@ryu/notion", "notion"));
        assert!(legacy.allows_treg());
        assert!(!legacy.needs_user_composio_accounts());
        assert_eq!(
            legacy.route_composio("local", "a1", &[], &[]),
            ComposioRoute::User {
                connected_account_id: None
            }
        );
        assert_eq!(
            legacy.user_identity_profiles(vec!["p1".into()]),
            vec!["p1".to_owned()]
        );
        // A legacy agent keeps the vault agent accounts it could already
        // create; a managed agent the user limited has none.
        assert!(legacy.allows_agent_account("acc_1"));
        let limited = policy(AgentIdentityMode::Managed, Some(&["agent:acc_1"]));
        assert!(!limited.allows_own_accounts());
        assert!(!limited.allows_agent_account("acc_1"));
    }

    #[test]
    fn delegation_and_creation_never_widen_a_restricted_agent() {
        let legacy = policy(AgentIdentityMode::Managed, None);
        let individual = policy(AgentIdentityMode::Individual, None);
        let managed_two = policy(
            AgentIdentityMode::Managed,
            Some(&["composio:ca_1", "composio:ca_2", "agent:acc_1"]),
        );
        let managed_one = policy(AgentIdentityMode::Managed, Some(&["composio:ca_1"]));
        let mixed_open = policy(AgentIdentityMode::Mixed, None);

        // Anything is within an unrestricted agent; an own-identity target never
        // reaches the user's accounts, so only Treg is compared for it.
        assert!(legacy.is_within(&legacy));
        let individual_without_treg = policy(AgentIdentityMode::Individual, Some(&[]));
        assert!(individual_without_treg.is_within(&managed_one));
        assert!(individual.is_within(&policy(
            AgentIdentityMode::Managed,
            Some(&["platform:treg"])
        )));
        // An own-identity agent with no allowlist may use Treg, so a caller
        // limited without it may not hand work to one.
        assert!(!individual.is_within(&managed_one));
        assert!(!individual.is_within(&policy(AgentIdentityMode::Managed, Some(&[]))));
        // The default (legacy) agent is wider than every restricted caller.
        assert!(!legacy.is_within(&individual));
        assert!(!legacy.is_within(&managed_one));
        assert!(!mixed_open.is_within(&individual));
        assert!(managed_one.is_within(&managed_two));
        assert!(!managed_two.is_within(&managed_one));
        assert!(managed_two.is_within(&mixed_open));

        // A restricted creator's allowlist carries over, without its own vault
        // accounts, and a wider mode is refused.
        assert_eq!(
            managed_two.for_created_agent(None),
            Ok((
                AgentIdentityMode::Managed,
                Some(vec!["composio:ca_1".to_owned(), "composio:ca_2".to_owned()])
            ))
        );
        assert_eq!(
            individual.for_created_agent(None),
            Ok((AgentIdentityMode::Individual, None))
        );
        assert!(individual
            .for_created_agent(Some(AgentIdentityMode::Managed))
            .is_err());
        assert_eq!(
            legacy.for_created_agent(Some(AgentIdentityMode::Mixed)),
            Ok((AgentIdentityMode::Mixed, None))
        );
    }

    #[test]
    fn individual_agent_never_reaches_user_accounts() {
        let individual = policy(
            AgentIdentityMode::Individual,
            Some(&[
                "composio:ca_1",
                "mcp:default:@ryu/notion:notion",
                "agent:acc_1",
            ]),
        );
        assert!(!individual.allows_composio_account("ca_1"));
        assert!(!individual.allows_mcp("default", "@ryu/notion", "notion"));
        assert!(individual.allows_agent_account("acc_1"));
        assert!(!individual.allows_agent_account("acc_2"));
        assert!(individual
            .user_identity_profiles(vec!["p1".into()])
            .is_empty());
        assert!(individual
            .narrow_composio_scope(&[binding("ca_1", "gmail")])
            .is_empty());
        // Its allowlist names none of its own Composio accounts, so it has
        // none to run on; the user's account never stands in.
        assert_eq!(
            individual.route_composio("local", "a1", &[binding("ca_1", "gmail")], &[]),
            ComposioRoute::Denied
        );
        // An unrestricted individual agent still never touches user accounts.
        let open = policy(AgentIdentityMode::Individual, None);
        assert!(!open.allows_composio_account("ca_1"));
        assert!(open.allows_agent_account("acc_9"));
    }

    #[test]
    fn managed_allowlist_pins_only_an_allowed_account() {
        let managed = policy(AgentIdentityMode::Managed, Some(&["composio:ca_2"]));
        assert!(managed.needs_user_composio_accounts());
        let accounts = [binding("ca_1", "gmail"), binding("ca_2", "gmail")];
        assert_eq!(
            managed.route_composio("local", "a1", &accounts, &[]),
            ComposioRoute::User {
                connected_account_id: Some("ca_2".into())
            }
        );
        assert_eq!(
            managed.route_composio("local", "a1", &accounts[..1], &[]),
            ComposioRoute::Denied
        );
        assert_eq!(
            managed.narrow_composio_scope(&accounts),
            vec![binding("ca_2", "gmail")]
        );
        // An empty allowlist allows nothing, Treg included.
        let none = policy(AgentIdentityMode::Managed, Some(&[]));
        assert_eq!(
            none.route_composio("local", "a1", &accounts, &[]),
            ComposioRoute::Denied
        );
        assert!(!none.allows_treg());
        assert!(!none.allows_mcp("default", "@ryu/notion", "notion"));
    }

    #[test]
    fn mixed_agent_falls_back_to_its_own_allowed_account() {
        let mixed = policy(
            AgentIdentityMode::Mixed,
            Some(&["composio:ca_2", "platform:treg", "bogus"]),
        );
        let accounts = [binding("ca_1", "gmail"), binding("ca_2", "gmail")];
        assert_eq!(
            mixed.route_composio("local", "a1", &accounts, &[]),
            ComposioRoute::User {
                connected_account_id: Some("ca_2".into())
            }
        );
        // No allowed user account and no allowed own account: refused.
        assert_eq!(
            mixed.route_composio("local", "a1", &accounts[..1], &[]),
            ComposioRoute::Denied
        );
        assert!(mixed.allows_treg());
        assert!(!mixed.allows_agent_account("acc_1"));

        let open = policy(AgentIdentityMode::Mixed, None);
        assert_eq!(
            open.route_composio("local", "a1", &accounts, &[]),
            ComposioRoute::User {
                connected_account_id: None
            }
        );
        assert_eq!(
            open.route_composio("local", "a1", &[], &[]),
            ComposioRoute::Agent {
                entity: "agent:local:a1".into(),
                connected_account_id: None,
            }
        );
    }

    #[test]
    fn active_bindings_skip_inactive_and_blank_rows() {
        let listed = json!({ "data": [
            { "id": "ca_1", "toolkit": "GMAIL", "active": true },
            { "id": "ca_2", "toolkit": "gmail", "active": false },
            { "id": " ", "toolkit": "gmail", "active": true },
            { "id": "ca_3", "toolkit": "", "active": true },
        ]});
        assert_eq!(
            active_composio_bindings(&listed),
            vec![binding("ca_1", "gmail")]
        );
    }

    #[test]
    fn parses_agent_composio_keys() {
        assert_eq!(
            AccountKey::parse("agent-composio:ca_own"),
            Some(AccountKey::AgentComposio("ca_own".into()))
        );
        assert_eq!(
            AccountKey::AgentComposio("ca_own".into()).to_key_string(),
            "agent-composio:ca_own"
        );
        // Distinct from a vault agent account and from the user's accounts.
        assert_ne!(
            AccountKey::parse("agent-composio:ca_own"),
            AccountKey::parse("agent:ca_own")
        );
        for malformed in ["agent-composio:", "agent-composio: x", "Agent-Composio:x"] {
            assert_eq!(AccountKey::parse(malformed), None, "{malformed}");
        }
    }

    #[test]
    fn individual_routes_to_an_allowed_own_account() {
        let own = [binding("own_1", "gmail"), binding("own_2", "gmail")];
        let limited = policy(
            AgentIdentityMode::Individual,
            Some(&["agent-composio:own_2"]),
        );
        assert!(limited.needs_own_composio_accounts());
        assert!(!limited.needs_user_composio_accounts());
        assert!(limited.allows_own_composio_account("own_2"));
        assert!(!limited.allows_own_composio_account("own_1"));
        // An own-account key never names one of the user's accounts.
        assert!(!limited.allows_composio_account("own_2"));
        assert_eq!(
            limited.route_composio("local", "a1", &[], &own),
            ComposioRoute::Agent {
                entity: "agent:local:a1".into(),
                connected_account_id: Some("own_2".into()),
            }
        );
        assert_eq!(
            limited.route_composio("local", "a1", &[], &own[..1]),
            ComposioRoute::Denied
        );
        // Without an allowlist the entity's default account runs, and nothing
        // has to be listed.
        let open = policy(AgentIdentityMode::Individual, None);
        assert!(!open.needs_own_composio_accounts());
        assert!(open.allows_own_composio_account("own_1"));
        assert_eq!(
            open.route_composio("local", "a1", &[], &own),
            ComposioRoute::Agent {
                entity: "agent:local:a1".into(),
                connected_account_id: None,
            }
        );
        // An allowlist naming no own account needs no listing and is refused.
        let none = policy(AgentIdentityMode::Individual, Some(&["platform:treg"]));
        assert!(!none.needs_own_composio_accounts());
        assert_eq!(
            none.route_composio("local", "a1", &[], &own),
            ComposioRoute::Denied
        );
    }

    #[test]
    fn mixed_prefers_an_allowed_user_account_then_an_allowed_own_one() {
        let user = [binding("ca_1", "gmail")];
        let own = [binding("own_1", "gmail")];
        let mixed = policy(
            AgentIdentityMode::Mixed,
            Some(&["composio:ca_1", "agent-composio:own_1"]),
        );
        assert!(mixed.needs_user_composio_accounts());
        assert!(mixed.needs_own_composio_accounts());
        assert_eq!(
            mixed.route_composio("local", "a1", &user, &own),
            ComposioRoute::User {
                connected_account_id: Some("ca_1".into())
            }
        );
        assert_eq!(
            mixed.route_composio("local", "a1", &[], &own),
            ComposioRoute::Agent {
                entity: "agent:local:a1".into(),
                connected_account_id: Some("own_1".into()),
            }
        );
    }

    #[test]
    fn own_composio_triggers_follow_mode_and_allowlist() {
        let open = policy(AgentIdentityMode::Individual, None);
        assert!(open.allows_own_composio_trigger("own_1"));
        let mixed = policy(AgentIdentityMode::Mixed, Some(&["agent-composio:own_1"]));
        assert!(mixed.allows_own_composio_trigger("own_1"));
        assert!(!mixed.allows_own_composio_trigger("own_2"));
        // A user-account key never covers an own account's events.
        let user_only = policy(AgentIdentityMode::Mixed, Some(&["composio:own_1"]));
        assert!(!user_only.allows_own_composio_trigger("own_1"));
        // An agent that acts as the user never receives own-entity events,
        // with or without an allowlist.
        for access in [None, Some(&["agent-composio:own_1"][..])] {
            let managed = policy(AgentIdentityMode::Managed, access);
            assert!(!managed.allows_own_composio_trigger("own_1"), "{access:?}");
        }
    }

    #[test]
    fn own_composio_entities_name_exactly_one_agent() {
        let entity = AgentAccountPolicy::composio_agent_entity("u1", "a1");
        assert!(AgentAccountPolicy::is_own_composio_entity(&entity, "a1"));
        for (entity, agent) in [
            ("agent:u1:a2", "a1"),
            ("agent::a1", "a1"),
            ("agent:u1:xa1", "a1"),
            ("agent:a1", "a1"),
            ("agent:u1:", ""),
            ("default", "a1"),
            ("u1", "a1"),
            ("", "a1"),
        ] {
            assert!(
                !AgentAccountPolicy::is_own_composio_entity(entity, agent),
                "{entity} / {agent}"
            );
        }
    }

    #[test]
    fn composio_agent_entities_parse_back_to_owner_and_agent() {
        for (owner, agent) in [("u1", "a1"), ("org:u1", "agent_abc")] {
            let entity = AgentAccountPolicy::composio_agent_entity(owner, agent);
            assert_eq!(
                AgentAccountPolicy::parse_composio_agent_entity(&entity),
                Some((owner, agent))
            );
        }
        for entity in [
            "agent:",
            "agent:u1",
            "agent:u1:",
            "agent::a1",
            "u1",
            "",
            "agents:u1:a1",
        ] {
            assert_eq!(
                AgentAccountPolicy::parse_composio_agent_entity(entity),
                None,
                "{entity}"
            );
        }
    }

    #[test]
    fn managed_agents_never_use_own_composio_accounts() {
        let own = [binding("own_1", "gmail")];
        let limited = policy(AgentIdentityMode::Managed, Some(&["agent-composio:own_1"]));
        assert!(!limited.allows_own_composio_account("own_1"));
        assert!(!limited.needs_own_composio_accounts());
        assert_eq!(
            limited.route_composio("local", "a1", &[], &own),
            ComposioRoute::Denied
        );
        // A legacy agent acts as the user, whatever its own entity holds.
        let legacy = policy(AgentIdentityMode::Managed, None);
        assert_eq!(
            legacy.route_composio("local", "a1", &[], &own),
            ComposioRoute::User {
                connected_account_id: None
            }
        );
    }

    #[test]
    fn own_composio_keys_stay_with_their_agent() {
        let narrow = policy(AgentIdentityMode::Mixed, Some(&["composio:ca_1"]));
        let with_own = policy(
            AgentIdentityMode::Mixed,
            Some(&["composio:ca_1", "agent-composio:own_1"]),
        );
        // Own accounts are not the user's, so they do not widen user reach.
        assert!(with_own.is_within(&narrow));
        // And they never carry over to an agent this one creates.
        assert_eq!(
            with_own.for_created_agent(None),
            Ok((
                AgentIdentityMode::Mixed,
                Some(vec!["composio:ca_1".to_owned()])
            ))
        );
    }
}

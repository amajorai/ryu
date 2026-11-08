//! Session Box credential fills: `browser.fill_credential` and
//! `browser.list_credentials` on a conversation's Box (design
//! `docs/vault-env-session-parity/box-fill-verb/` 1.2).
//!
//! The steps run in this order, and no vault value is read before step 8:
//!
//! 1. establish the calling agent, or refuse ([`caller_agent`]);
//! 2. rate limits and echo blocks ([`fill_ledger::check`]);
//! 3. the Box service's `browser-fill-v2` feature ([`fill_ledger::probe`]);
//! 4. authorize from metadata ([`box_fill::authorize`]);
//! 5. prepare on the Box (no secret);
//! 6. check the page in Core: `https` on exactly the account's host or its
//!    `www.` variant, else cancel;
//! 7. pin an attached set to this Box ([`Registry::claim_box`]);
//! 8. release the value, audited as an item reveal;
//! 9. commit: a password as a placeholder bound to the login URLs (45 s), a
//!    username, email or code as text; on error cancel;
//! 10. audit the outcome after the TTL; 11. a fill-set revoke cancels live
//!     fills ([`revoke_set`]).
//!
//! `route` cannot receive the dispatch's `agent_id` without editing
//! `mcp/mod.rs`, so the agent comes from the conversation, and any doubt
//! refuses: no global state, a sub-agent scope, more than one agent
//! participant, or an active agent that does not match the participant.

use super::fill_ledger::{self, LiveFill, UNSAFE_BOX_REFUSAL};
use super::*;
use crate::agent_access::AgentAccountPolicy;
use crate::plugin_secrets::PluginSecretStore;
use crate::server::vault_agent_accounts_api::box_fill::{self, FillSource};
use crate::server::ServerState;
use crate::vault::agent_accounts::fill_sets::{self, Registry};
use crate::vault::agent_accounts::fill_target::box_page_matches;
use crate::vault::agent_accounts::FillField;
use ryu_sandbox::box_session::{
    BrowserFillError, BrowserFillField, BrowserFillTarget, BrowserFillValue, BROWSER_FILL_ECHOED,
    DEFAULT_FILL_TTL_SECONDS,
};
use ryu_sandbox::WorkspaceId;

const NO_STATE_REFUSAL: &str = "Credential fills are not available in this Core.";
const NO_CONVERSATION_REFUSAL: &str = "Credential fills need a conversation.";
const SUBAGENT_REFUSAL: &str = "Credential fills are not available to a sub-agent or thread worker; ask the user to start a single-agent session Box.";
const MULTI_AGENT_REFUSAL: &str = "Credential fills are not available in a conversation with more than one agent; ask the user to start a single-agent session Box.";
const UNSETTLED_REFUSAL: &str = "The active agent of this conversation is not settled, so credential fills are refused; ask the user to start a single-agent session Box.";
const ECHO_REFUSAL: &str = "This site echoed a filled value; fills for it are blocked in this Box.";

/// The arguments of one `browser.fill_credential` call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FillArgs {
    pub account: String,
    pub field: FillField,
    pub element_ref: String,
    pub tab_id: Option<String>,
    pub submit: bool,
}

impl FillArgs {
    /// From schema-checked arguments.
    pub(super) fn parse(arguments: &Map<String, Value>) -> Result<Self> {
        let text = |name: &str| {
            arguments
                .get(name)
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let field = serde_json::from_value(arguments.get("field").cloned().unwrap_or_default())
            .map_err(|_| anyhow!("browser.fill_credential: 'field' is not a fill field"))?;
        Ok(Self {
            account: text("account").unwrap_or_default(),
            field,
            element_ref: text("ref").unwrap_or_default(),
            tab_id: text("tab_id"),
            submit: arguments.get("submit").and_then(Value::as_bool) == Some(true),
        })
    }
}

/// Who a fill is for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Caller {
    Agent(String),
    /// No agent and no participant: own accounts in the unassigned folder.
    Unassigned,
}

impl Caller {
    pub(super) fn agent_id(&self) -> Option<&str> {
        match self {
            Self::Agent(agent) => Some(agent),
            Self::Unassigned => None,
        }
    }
}

/// Step 1: the agent a fill in `conversation_id` is for, or a refusal.
pub(super) async fn caller_agent(
    store: Option<&ConversationStore>,
    conversation_id: &str,
) -> Result<Caller> {
    if current_subagent_scope().is_some() {
        bail!("{SUBAGENT_REFUSAL}");
    }
    let store = store.ok_or_else(|| anyhow!(NO_CONVERSATION_REFUSAL))?;
    let mut agents = store
        .get_participants(conversation_id)
        .await
        .map_err(|_| anyhow!(UNSETTLED_REFUSAL))?;
    agents.retain(|agent| !agent.trim().is_empty());
    agents.sort();
    agents.dedup();
    if agents.len() > 1 {
        bail!("{MULTI_AGENT_REFUSAL}");
    }
    let active = store
        .get_summary(conversation_id)
        .await
        .map_err(|_| anyhow!(UNSETTLED_REFUSAL))?
        .and_then(|summary| summary.agent_id)
        .filter(|agent| !agent.trim().is_empty());
    match (active, agents.first()) {
        (Some(active), Some(participant)) if *participant != active => bail!("{UNSETTLED_REFUSAL}"),
        (Some(active), _) => Ok(Caller::Agent(active)),
        (None, None) => Ok(Caller::Unassigned),
        (None, Some(_)) => bail!("{UNSETTLED_REFUSAL}"),
    }
}

/// What a fill runs against.
pub(super) struct FillEnv<'a> {
    pub vault: &'static PluginSecretStore,
    pub registry: &'a Registry,
    pub policy: Option<AgentAccountPolicy>,
    pub client: &'a BoxSessionClient,
    /// Spawn the outcome audit after the TTL (off in tests, which call
    /// [`fill_ledger::audit_outcome`] themselves).
    pub audit_later: bool,
}

/// The environment of a fill for `caller`, from the global state.
async fn environment<'a>(
    state: Option<ServerState>,
    caller: &Caller,
    client: &'a BoxSessionClient,
) -> Result<FillEnv<'a>> {
    let state = state.ok_or_else(|| anyhow!(NO_STATE_REFUSAL))?;
    let policy = box_fill::policy_for(&state.agent_store, caller.agent_id())
        .await
        .map_err(|_| anyhow!("The agent's account policy could not be read; try again"))?;
    let vault = crate::server::vault_api::store()
        .map_err(|_| anyhow!("The vault is not available on this node"))?;
    Ok(FillEnv {
        vault,
        registry: fill_sets::registry(),
        policy,
        client,
        audit_later: true,
    })
}

async fn client() -> Result<BoxSessionClient> {
    session_box::box_client()
        .await
        .map_err(|error| anyhow!("Ryu Box is not configured on this node: {error}"))
}

/// `browser.fill_credential` on the conversation's Box.
pub(super) async fn run(
    store: Option<&ConversationStore>,
    conversation_id: &str,
    target: &BoxTarget,
    args: FillArgs,
) -> Result<Value> {
    run_in(
        crate::learning::global_state(),
        store,
        conversation_id,
        target,
        args,
    )
    .await
}

/// [`run`] with the global state passed in: `None` refuses, never "no policy".
pub(super) async fn run_in(
    state: Option<ServerState>,
    store: Option<&ConversationStore>,
    conversation_id: &str,
    target: &BoxTarget,
    args: FillArgs,
) -> Result<Value> {
    if state.is_none() {
        bail!("{NO_STATE_REFUSAL}");
    }
    let caller = caller_agent(store, conversation_id).await?;
    let client = client().await?;
    let env = environment(state, &caller, &client).await?;
    execute(&env, &target.box_id, &caller, &args).await
}

/// `browser.list_credentials` on the conversation's Box: metadata only.
pub(super) async fn list(
    store: Option<&ConversationStore>,
    conversation_id: &str,
    _target: &BoxTarget,
) -> Result<Value> {
    let state = crate::learning::global_state().ok_or_else(|| anyhow!(NO_STATE_REFUSAL))?;
    let caller = caller_agent(store, conversation_id).await?;
    let policy = box_fill::policy_for(&state.agent_store, caller.agent_id())
        .await
        .map_err(|_| anyhow!("The agent's account policy could not be read; try again"))?;
    let vault = crate::server::vault_api::store()
        .map_err(|_| anyhow!("The vault is not available on this node"))?;
    list_for(vault, fill_sets::registry(), policy.as_ref(), &caller).await
}

/// The accounts and attached items `caller` may fill, as metadata.
pub(super) async fn list_for(
    vault: &PluginSecretStore,
    registry: &Registry,
    policy: Option<&AgentAccountPolicy>,
    caller: &Caller,
) -> Result<Value> {
    let accounts = crate::vault::agent_accounts::list(vault, caller.agent_id(), None).await?;
    let accounts: Vec<Value> = accounts
        .into_iter()
        .filter(|account| box_fill::own_account_refusal(policy, &account.id).is_none())
        .map(|account| {
            json!({
                "id": account.id,
                "site": account.site,
                "username": account.username,
                "email": account.email,
                "has_password": account.has_password,
                "has_totp": account.has_totp,
                "submit_urls": account.submit_urls,
            })
        })
        .collect();
    let users_allowed = policy.is_none_or(AgentAccountPolicy::allows_user_accounts);
    let attached: Vec<Value> = match caller.agent_id() {
        Some(agent) if users_allowed => registry
            .list(Some(agent), crate::vault::now_millis())
            .into_iter()
            .flat_map(|set| set.items)
            .map(|item| {
                json!({
                    "handle": item.handle,
                    "site": item.site,
                    "fields": item.fields,
                    "login_url_bound": item.login_url_bound,
                })
            })
            .collect(),
        _ => Vec::new(),
    };
    Ok(json!({
        "provider": PROVIDER_ID,
        "target": "remote-desktop",
        "verb": "list_credentials",
        "result": { "accounts": accounts, "attached": attached },
    }))
}

fn wire_field(field: FillField) -> BrowserFillField {
    match field {
        FillField::Username => BrowserFillField::Username,
        FillField::Email => BrowserFillField::Email,
        FillField::Password => BrowserFillField::Password,
        FillField::Totp => BrowserFillField::Totp,
    }
}

/// A refused prepare or commit as a model-facing error (never a value).
fn fill_error(failure: &BrowserFillError) -> anyhow::Error {
    match failure.code() {
        Some(BROWSER_FILL_ECHOED) => anyhow!(ECHO_REFUSAL),
        _ if failure.box_cannot_fill() => anyhow!(UNSAFE_BOX_REFUSAL),
        _ => box_error("credential fill", &failure.error),
    }
}

/// Best-effort cancel of a prepared fill.
async fn cancel(client: &BoxSessionClient, box_id: &WorkspaceId, fill_id: &str) {
    if client.browser_fill_cancel(box_id, fill_id).await.is_err() {
        tracing::warn!(box_id = %box_id.0, fill_id, "A Box credential fill could not be cancelled");
    }
}

/// Steps 2 to 10 for one fill.
pub(super) async fn execute(
    env: &FillEnv<'_>,
    box_id: &WorkspaceId,
    caller: &Caller,
    args: &FillArgs,
) -> Result<Value> {
    let box_key = box_id.0.as_str();
    let password = args.field == FillField::Password;
    fill_ledger::check(box_key, &args.account, password)?;
    fill_ledger::probe(env.client).await?;
    let now = crate::vault::now_millis();
    let grant = box_fill::authorize(
        env.vault,
        env.registry,
        env.policy.as_ref(),
        caller.agent_id(),
        box_key,
        &args.account,
        args.field,
        now,
    )
    .await?;
    let target = BrowserFillTarget {
        element_ref: args.element_ref.clone(),
        tab_id: args.tab_id.clone(),
        field: wire_field(args.field),
        page_hosts: grant.page_hosts.clone(),
        bind_hosts: grant.bind_hosts.clone(),
        submit_urls: grant.submit_urls.clone(),
    };
    let prepared = match env.client.browser_fill_prepare(box_id, &target).await {
        Ok(prepared) => prepared,
        Err(failure) => {
            if let Some(echoed) = &failure.echoed {
                fill_ledger::note_echo(env.vault, box_key, echoed, &args.account).await;
            }
            return Err(fill_error(&failure));
        }
    };
    let fill_id = prepared.fill_id.as_str();
    if !box_page_matches(&prepared.page_url, &grant.page_hosts) {
        cancel(env.client, box_id, fill_id).await;
        bail!(
            "The Box page is not an https page of {}; the fill was cancelled",
            grant.host
        );
    }
    if let (FillSource::Attached { set_id, item }, Some(agent)) = (&grant.source, caller.agent_id())
    {
        if let Err(error) = env.registry.claim_box(agent, box_key, set_id, item, now) {
            cancel(env.client, box_id, fill_id).await;
            return Err(error);
        }
    }
    fill_ledger::record(box_key, &args.account, password);
    let value =
        match box_fill::release(env.vault, &grant, caller.agent_id(), &prepared.page_url).await {
            Ok(value) => value,
            Err(error) => {
                cancel(env.client, box_id, fill_id).await;
                return Err(error);
            }
        };
    tracing::info!(
        box_id = box_key,
        account = args.account,
        field = args.field.as_str(),
        host = grant.host,
        fill_id,
        "Box credential fill released"
    );
    let commit = if password {
        BrowserFillValue::Placeholder {
            value,
            submit_urls: grant.submit_urls.clone(),
            unbound: grant.unbound,
            ttl_seconds: DEFAULT_FILL_TTL_SECONDS,
            submit: args.submit,
        }
    } else {
        BrowserFillValue::Text {
            value,
            submit: args.submit,
        }
    };
    let committed = match env
        .client
        .browser_fill_commit(box_id, fill_id, &commit)
        .await
    {
        Ok(committed) => committed,
        Err(failure) => {
            drop(commit);
            cancel(env.client, box_id, fill_id).await;
            if let Some(echoed) = &failure.echoed {
                fill_ledger::note_echo(env.vault, box_key, echoed, &args.account).await;
            }
            return Err(fill_error(&failure));
        }
    };
    drop(commit);
    if password {
        let live = LiveFill {
            box_id: box_key.to_owned(),
            fill_id: fill_id.to_owned(),
            set_id: grant.set_id().map(str::to_owned),
            account: args.account.clone(),
            agent_id: caller.agent_id().map(str::to_owned),
            field: args.field.as_str(),
            host: grant.host.clone(),
        };
        fill_ledger::track(live.clone());
        if env.audit_later {
            spawn_outcome_audit(env.vault, live);
        }
    }
    Ok(json!({
        "provider": PROVIDER_ID,
        "target": "remote-desktop",
        "verb": "fill_credential",
        "result": {
            "ok": true,
            "tab": committed.tab,
            "account": args.account,
            "field": args.field,
            "filled": committed.filled,
            "protected": committed.protected,
        },
    }))
}

/// Step 10: read the outcome once the placeholder's TTL (plus 5 s) is over.
fn spawn_outcome_audit(vault: &'static PluginSecretStore, live: LiveFill) {
    tokio::spawn(async move {
        let wait = u64::from(DEFAULT_FILL_TTL_SECONDS) + 5;
        tokio::time::sleep(Duration::from_secs(wait)).await;
        if let Ok(client) = client().await {
            fill_ledger::audit_outcome(&client, vault, &live).await;
        }
    });
}

/// What a fill-set revoke did to that set's live Box fills.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RevokedFills {
    pub cancelled: usize,
    pub pending: usize,
}

/// Step 11: cancel every live Box fill of fill set `set_id`, in parallel and
/// within two seconds, before the revoke answers. A fill left pending still
/// expires on the sidecar within 60 s.
pub(crate) async fn revoke_set(set_id: &str) -> RevokedFills {
    let fills = fill_ledger::live_for_set(set_id);
    if fills.is_empty() {
        return RevokedFills::default();
    }
    let Ok(client) = client().await else {
        return RevokedFills {
            cancelled: 0,
            pending: fills.len(),
        };
    };
    revoke_with(&client, set_id).await
}

/// [`revoke_set`] with a given client.
pub(super) async fn revoke_with(client: &BoxSessionClient, set_id: &str) -> RevokedFills {
    let fills = fill_ledger::live_for_set(set_id);
    let (cancelled, pending) = fill_ledger::cancel_all(client, &fills).await;
    RevokedFills { cancelled, pending }
}

#[cfg(test)]
#[path = "fill_tests.rs"]
mod tests;

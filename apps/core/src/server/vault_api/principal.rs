//! The request principal ([`Ctx`]) and control-plane forwarding.

use super::*;

/// Policy-binding subjects of a verified caller.
pub(super) fn caller_subjects(caller: Option<&VerifiedCaller>) -> Vec<String> {
    let mut subjects = Vec::new();
    if let Some(caller) = caller {
        subjects.push(format!("user:{}", caller.user_id));
        subjects.push(format!("role:{}", role_label(caller.role)));
        subjects.extend(caller.teams.iter().map(|team| format!("team:{}", team.id)));
    }
    subjects
}

/// Everything a vault handler needs to authorize one request.
pub(crate) struct Ctx {
    pub store: &'static PluginSecretStore,
    pub node: Option<RegisteredNode>,
    pub node_id: String,
    pub caller: Option<VerifiedCaller>,
    /// Configuration manager (or the unbound local operator).
    pub manager: bool,
    pub policies: Vec<Policy>,
    pub jwt: Option<String>,
}

impl Ctx {
    pub(crate) async fn load(
        state: &ServerState,
        caller: Option<VerifiedCaller>,
        headers: &HeaderMap,
    ) -> Result<Self, Response> {
        let store = store()?;
        let node = current_node();
        let node_id = current_node_id(node.as_ref());
        let manager =
            node.is_none() || can_manage_shared(state, node.as_ref(), caller.as_ref()).await;
        let subjects = caller_subjects(caller.as_ref());
        let policies = {
            let conn = store.conn.lock().await;
            crate::vault::policy::policies_for(&conn, &subjects).map_err(vault_error)?
        };
        Ok(Self {
            store,
            node,
            node_id,
            caller,
            manager,
            policies,
            jwt: user_jwt(headers, crate::server::request_bearer_is_user_jwt()),
        })
    }

    pub(crate) fn actor(&self) -> AuditActor {
        match &self.caller {
            Some(caller) => AuditActor::new("user", Some(&caller.user_id)),
            None => AuditActor::new("operator", None),
        }
    }

    /// Baseline capabilities for a scope, before policies.
    pub(super) fn baseline(&self, scope: SecretScope, scope_id: &str) -> CapabilitySet {
        let node = self.node.as_ref();
        let caller = self.caller.as_ref();
        if !scope_visible(scope, scope_id, node, caller, &self.node_id) {
            return CapabilitySet::new();
        }
        if node.is_none() {
            return Capability::ALL.into_iter().collect();
        }
        let mut caps: CapabilitySet = [Capability::List, Capability::Use].into_iter().collect();
        if scope == SecretScope::User {
            caps.extend([Capability::Read, Capability::Write, Capability::Delete]);
        }
        if self.manager {
            caps.extend(Capability::ALL);
        }
        caps
    }

    /// Policy-binding subjects of this caller (empty for the local operator).
    pub(crate) fn subjects(&self) -> Vec<String> {
        caller_subjects(self.caller.as_ref())
    }

    /// What a change request records about its requester, so each approval
    /// can re-check the requester against the policy bindings in force then.
    pub(super) fn requester_authority(&self, coords: &SecretCoords) -> RequesterAuthority {
        RequesterAuthority {
            subjects: self.subjects(),
            baseline: self.baseline(coords.scope, &coords.scope_id),
        }
    }

    /// Identity values policy templates expand against.
    pub(crate) fn template_context(&self) -> TemplateContext {
        TemplateContext::from_subjects(&self.subjects())
    }

    /// Effective capabilities on one value.
    ///
    /// A value outside the caller's scope boundary (another user's personal
    /// value, a team the caller is not in, another org or node) yields no
    /// capabilities: `ENV/folder/NAME` policy keys carry no scope or owner,
    /// so a policy must never widen visibility past [`scope_visible`]. Every
    /// row-iterating caller (listing, `to_wire`, `scan`, audit events) and
    /// every per-item check therefore agrees with [`resolve_target`].
    pub(crate) fn caps(&self, coords: &SecretCoords) -> CapabilitySet {
        if !scope_visible(
            coords.scope,
            &coords.scope_id,
            self.node.as_ref(),
            self.caller.as_ref(),
            &self.node_id,
        ) {
            return CapabilitySet::new();
        }
        self.policy_caps(coords)
    }

    /// Capabilities on a submitted change request's target for its
    /// approvers. Approval is the one flow that acts on a value outside the
    /// approver's own scope (an admin approving a member's personal write in
    /// a protected environment), so the scope gate of [`Self::caps`] is not
    /// applied: the baseline is still empty there and only an explicit
    /// policy grant of `approve` counts.
    pub(super) fn approval_caps(&self, coords: &SecretCoords) -> CapabilitySet {
        self.policy_caps(coords)
    }

    pub(super) fn policy_caps(&self, coords: &SecretCoords) -> CapabilitySet {
        let baseline = self.baseline(coords.scope, &coords.scope_id);
        crate::vault::policy::evaluate_with(
            &baseline,
            &self.policies,
            &coords.policy_key(),
            &self.template_context(),
        )
    }

    /// The control group gating a `read` of `coords`, if any. The unbound
    /// local operator (no verified caller) is the root equivalent and is never
    /// gated.
    pub(crate) fn read_control_group(&self, coords: &SecretCoords) -> Option<ControlGroupSpec> {
        self.sys_read_control_group(&coords.policy_key())
    }

    /// [`Self::read_control_group`] for a non-secret policy key such as
    /// `sys/items/<env>/<folder>/<key>`.
    pub(crate) fn sys_read_control_group(&self, key: &str) -> Option<ControlGroupSpec> {
        self.caller.as_ref()?;
        crate::vault::policy_ext::control_group_for(
            &self.policies,
            key,
            Capability::Read,
            &self.template_context(),
        )
    }

    /// Whether `read` releases the value directly (no control group pending).
    pub(crate) fn can_read_directly(&self, coords: &SecretCoords) -> bool {
        self.caps(coords).contains(&Capability::Read) && self.read_control_group(coords).is_none()
    }

    /// The first parameter-constraint violation a write of `value` to
    /// `coords` would commit, if any. A JSON-object value contributes its
    /// top-level keys; any other value is the single parameter `value`.
    pub(crate) fn write_parameters_violation(
        &self,
        coords: &SecretCoords,
        value: &str,
    ) -> Option<String> {
        let parameters: BTreeMap<String, Value> = match serde_json::from_str::<Value>(value) {
            Ok(Value::Object(map)) => map.into_iter().collect(),
            _ => BTreeMap::from([("value".to_owned(), Value::String(value.to_owned()))]),
        };
        crate::vault::policy_ext::check_parameters(
            &self.policies,
            &coords.policy_key(),
            Capability::Write,
            &self.template_context(),
            &parameters,
        )
        .err()
    }

    /// Whether any rule granting `write` on `coords` carries parameter
    /// constraints (so a value-less write path must load and check the value).
    pub(crate) fn write_parameters_constrained(&self, coords: &SecretCoords) -> bool {
        crate::vault::policy_ext::has_parameter_constraints(
            &self.policies,
            &coords.policy_key(),
            Capability::Write,
            &self.template_context(),
        )
    }

    /// Check a write's parameters against the rules' parameter constraints.
    pub(crate) fn require_write_parameters(
        &self,
        coords: &SecretCoords,
        value: Option<&str>,
    ) -> Result<(), Response> {
        let Some(value) = value else {
            return Ok(());
        };
        match self.write_parameters_violation(coords, value) {
            None => Ok(()),
            Some(message) => Err(json_error(
                StatusCode::FORBIDDEN,
                format!("vault_denied: {message} on `{}`", coords.policy_key()),
            )),
        }
    }

    /// Refuse a read that a control group gates on a path that cannot open
    /// a control-group request (it would release the value without approval).
    pub(crate) fn require_ungated_read(&self, key: &str) -> Result<(), Response> {
        if self.sys_read_control_group(key).is_some() {
            return Err(control_group_required(key));
        }
        Ok(())
    }

    pub(crate) fn require(
        &self,
        coords: &SecretCoords,
        capability: Capability,
    ) -> Result<(), Response> {
        if self.caps(coords).contains(&capability) {
            Ok(())
        } else {
            Err(denied(capability, &coords.policy_key()))
        }
    }

    /// Capabilities on a non-secret key such as `sys/transit/payments`.
    pub(crate) fn sys_caps(&self, key: &str) -> CapabilitySet {
        let baseline: CapabilitySet = if self.manager {
            Capability::ALL.into_iter().collect()
        } else {
            CapabilitySet::new()
        };
        crate::vault::policy::evaluate_with(
            &baseline,
            &self.policies,
            key,
            &self.template_context(),
        )
    }

    pub(crate) fn require_sys(&self, key: &str, capability: Capability) -> Result<(), Response> {
        if self.sys_caps(key).contains(&capability) {
            Ok(())
        } else {
            Err(denied(capability, key))
        }
    }

    /// The runtime context the resolver would use for this caller.
    pub(super) fn resolution_context(
        &self,
        environment: Option<String>,
    ) -> SecretResolutionContext {
        let user_id = match (&self.caller, &self.node) {
            (Some(caller), _) => Some(caller.user_id.clone()),
            (None, None) => Some(LOCAL_SCOPE_ID.to_owned()),
            (None, Some(_)) => None,
        };
        SecretResolutionContext {
            user_id,
            org_id: self.node.as_ref().map(|node| node.org.id.clone()),
            team_id: self.node.as_ref().and_then(|node| node.team_id.clone()),
            project_id: None,
            team_authority: self
                .caller
                .as_ref()
                .and_then(crate::plugin_secrets::VerifiedTeamSecretScope::from_verified_caller),
            node_id: self.node_id.clone(),
            mcp_ids: Vec::new(),
            environment,
            conversation_id: None,
            roles: self
                .caller
                .iter()
                .map(|caller| caller.role.label().to_owned())
                .collect(),
            principal_unverified: false,
            minted_subjects: Vec::new(),
        }
    }

    /// Whether team/org values for this request live in the control plane.
    pub(crate) fn shared_remote(&self, scope: SecretScope) -> bool {
        matches!(scope, SecretScope::Team | SecretScope::Org) && crate::vault::shared::is_enabled()
    }

    /// The team/org id for a shared request, defaulting to this node's own.
    pub(super) fn shared_scope_id(&self, coords: &CoordsBody) -> String {
        coords
            .scope_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .or_else(|| {
                let node = self.node.as_ref()?;
                match coords.scope {
                    SecretScope::Team => node.team_id.clone(),
                    SecretScope::Org => Some(node.org.id.clone()),
                    SecretScope::User | SecretScope::Node | SecretScope::Project => None,
                }
            })
            .unwrap_or_default()
    }

    /// Whether this node may vouch for a shared plaintext read (reveal or
    /// export), so the control plane does not ask for a step-up. The gateway
    /// key goes with every proxied request; the vouch
    /// (`x-ryu-node-vouch: 1`) only with these. See [`node_key_may_vouch`].
    pub(crate) async fn node_vouches(&self) -> bool {
        let Some(jwt) = self.jwt.as_deref() else {
            return false;
        };
        let local_owner = crate::server::request_is_from_local_owner();
        // Cheap checks first: the JWT is only verified when the rest holds.
        if !node_key_may_vouch(
            self.node.as_ref(),
            self.caller.as_ref(),
            self.caller.as_ref(),
            local_owner,
        ) {
            return false;
        }
        let forwarded = crate::server::verified_caller_from_token(jwt).await;
        node_key_may_vouch(
            self.node.as_ref(),
            self.caller.as_ref(),
            forwarded.as_ref(),
            local_owner,
        )
    }
}

/// Load the request's [`Ctx`] or return its error response from the handler.
macro_rules! ctx {
    ($state:expr, $caller:expr, $headers:expr) => {
        match Ctx::load(&$state, $caller, &$headers).await {
            Ok(ctx) => ctx,
            Err(response) => return response,
        }
    };
}
pub(crate) use ctx;

/// Unwrap `Ok(value)` or return the `Err(response)` from the handler.
macro_rules! try_response {
    ($expr:expr) => {
        match $expr {
            Ok(value) => value,
            Err(response) => return response,
        }
    };
}
pub(crate) use try_response;

#[cfg(test)]
impl Ctx {
    /// A Member caller `user_id` on the org-1 ("Acme") org node `node-1`, not a
    /// manager, holding `policies`.
    pub(crate) fn test_member(
        store: &'static PluginSecretStore,
        user_id: &str,
        policies: Vec<Policy>,
    ) -> Self {
        use crate::sidecar::control_plane::RegisteredOrg;
        Self {
            store,
            node: Some(RegisteredNode {
                org: RegisteredOrg {
                    id: "org-1".to_owned(),
                    name: "Acme".to_owned(),
                    slug: None,
                },
                node_id: "node-1".to_owned(),
                scope: NodeScope::Org,
                team_id: None,
                owner_user_id: None,
            }),
            node_id: "node-1".to_owned(),
            caller: Some(VerifiedCaller {
                user_id: user_id.to_owned(),
                email: None,
                email_verified: false,
                org_id: Some("org-1".to_owned()),
                role: OrgRole::Member,
                teams: Vec::new(),
            }),
            manager: false,
            policies,
            jwt: None,
        }
    }
}

/// Whether the node key may vouch for a shared plaintext read. All of these
/// must hold, or the control plane asks the session for a step-up instead:
///
/// - the node is an org or team node (a personal key never vouches: it
///   cannot resolve shared values at run time, so it would add reach);
/// - the request comes from this machine (a trusted local peer, so not a
///   remote holder of a token, and not while a forwarding tunnel makes
///   remote streams look local) AND was admitted with this node's owner token
///   (`local_owner`, from [`crate::server::request_is_from_local_owner`]). A user JWT,
///   paired token or delegation as the bearer is not enough: a script on a
///   CORS-allowed web origin can mint a user JWT from the session cookie and
///   send it to this machine's loopback port, but it cannot read the owner
///   token from the data directory;
/// - the JWT forwarded to the control plane verifies to the same user (and
///   org) as the request's verified caller, so a second JWT riding in a
///   header cannot borrow this node's key.
///
/// Every other request is forwarded without the vouch, and the control plane
/// asks for the `org.credentials` step-up (`ryu secrets confirm` in the CLI,
/// the confirmation prompt in Desktop and the web console).
pub(super) fn node_key_may_vouch(
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
    forwarded: Option<&VerifiedCaller>,
    local_owner: bool,
) -> bool {
    let (Some(node), Some(caller), Some(forwarded)) = (node, caller, forwarded) else {
        return false;
    };
    local_owner
        && matches!(node.scope, NodeScope::Org | NodeScope::Team)
        && caller.org_id.as_deref() == Some(node.org.id.as_str())
        && forwarded.user_id == caller.user_id
        && forwarded.org_id == caller.org_id
}

pub(super) async fn proxy(
    ctx: &Ctx,
    method: reqwest::Method,
    subpath: &str,
    query: &[(String, String)],
    body: Option<Value>,
) -> Response {
    proxy_with_proof(ctx, method, subpath, query, body, false).await
}

/// [`proxy`], optionally with this node's vouch for a plaintext
/// read (decided by [`Ctx::node_vouches`]).
pub(super) async fn proxy_with_proof(
    ctx: &Ctx,
    method: reqwest::Method,
    subpath: &str,
    query: &[(String, String)],
    body: Option<Value>,
    node_proof: bool,
) -> Response {
    let Some(jwt) = ctx.jwt.as_deref() else {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "vault_user_required: shared values need a signed-in user".to_owned(),
        );
    };
    match crate::vault::shared::proxy(method, subpath, query, jwt, body, node_proof).await {
        // The control plane may send epoch millis; normalize like local answers.
        Ok(value) => no_store_response(Json(rfc3339_fields(value)).into_response()),
        Err(crate::vault::shared::ProxyError::Status(status, value)) => {
            let status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
            no_store_response((status, Json(value)).into_response())
        }
        Err(crate::vault::shared::ProxyError::Unavailable) => json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "vault_shared_unavailable: this node is not connected to the control plane".to_owned(),
        ),
        Err(crate::vault::shared::ProxyError::Transport(error)) => json_error(
            StatusCode::BAD_GATEWAY,
            format!("vault_shared_unreachable: {error}"),
        ),
    }
}

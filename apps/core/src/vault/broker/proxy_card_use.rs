//! Card placeholder substitution, merchant checks, and card principals.

use super::*;

impl Broker {
    /// Whether `host` is a merchant host of a card this session may use.
    pub(super) async fn usable_merchant(
        &self,
        session: &BrokerSession,
        bindings: &[CardBinding],
        host: &str,
    ) -> Result<bool, Refusal> {
        let candidates: Vec<&CardBinding> =
            bindings.iter().filter(|card| card.allows(host)).collect();
        if candidates.is_empty() {
            return Ok(false);
        }
        let (authority, _) = self.card_principal(session).await?;
        Ok(candidates
            .iter()
            .any(|card| authority.may_use(&card.coords.policy_key())))
    }

    /// Substitute `__CARD_<KEY>_<FIELD>__` placeholders in headers and the
    /// body. Only an HTTPS request to a host on the card's merchant
    /// allowlist, from a session whose minter may `use` the card, is
    /// eligible; anything else leaves the placeholders untouched and records
    /// a blocked use. An eligible use needs a live approval grant: without
    /// one the request is not forwarded and the agent gets a
    /// `428 card_approval_required` naming the pending approval request.
    /// Returns the use when values were substituted.
    pub(super) async fn substitute_card(
        &self,
        session: &BrokerSession,
        target: &Target,
        bindings: &[CardBinding],
        outgoing: &mut Outgoing,
    ) -> Result<Option<CardSpend>, Refusal> {
        let body_kind = substitute::body_kind(
            header_str(&outgoing.headers, hyper::header::CONTENT_TYPE.as_str()),
            header_str(&outgoing.headers, hyper::header::CONTENT_ENCODING.as_str()),
        );
        let mut found = Vec::new();
        for value in outgoing.headers.values() {
            if let Ok(text) = value.to_str() {
                cards::find_placeholders(text, &mut found);
            }
        }
        if body_kind != substitute::BodyKind::Opaque
            && outgoing.body.len() <= substitute::MAX_BODY_SUBSTITUTION_BYTES
        {
            if let Ok(text) = std::str::from_utf8(&outgoing.body) {
                cards::find_placeholders(text, &mut found);
            }
        }
        found.retain(|placeholder| {
            bindings
                .iter()
                .any(|binding| binding.coords.key == placeholder.key)
        });
        let Some(first) = found.first() else {
            return Ok(None);
        };
        if found.iter().any(|placeholder| placeholder.key != first.key) {
            return Err(Refusal::new(
                StatusCode::BAD_REQUEST,
                "one_card_per_request",
                "a brokered request may use placeholders of one card only",
            ));
        }
        let matching: Vec<&CardBinding> = bindings
            .iter()
            .filter(|binding| binding.coords.key == first.key)
            .collect();
        let [binding] = matching.as_slice() else {
            return Err(Refusal::new(
                StatusCode::CONFLICT,
                "ambiguous_card",
                &format!(
                    "more than one card item named `{}` exists in this environment",
                    first.key
                ),
            ));
        };
        let (authority, agent) = self.card_principal(session).await?;
        let request = CardUseRequest {
            coords: binding.coords.clone(),
            channel: CardChannel::Broker,
            merchant_host: target.host.clone(),
            requester: format!("broker_session:{}", session.id),
            agent,
            actor: session.actor(),
        };
        let denied = !authority.may_use(&binding.coords.policy_key());
        let blocked = if binding.merchants.is_empty() {
            Some("no_merchants")
        } else if !binding.allows(&target.host) {
            Some("merchant_not_allowed")
        } else if target.scheme != "https" {
            Some("insecure_scheme")
        } else if denied {
            Some("denied")
        } else {
            None
        };
        if let Some(reason) = blocked {
            if let Err(error) = self.store.card_use_blocked(&request, reason).await {
                tracing::warn!("recording a blocked card use failed: {error:#}");
            }
            return Ok(None);
        }
        let (values, approval_id) = match self.store.card_use(&request, None).await {
            Ok(CardUseOutcome::Granted {
                values,
                approval_id,
                ..
            }) => (values, approval_id),
            Ok(CardUseOutcome::Blocked(_)) => return Ok(None),
            Ok(CardUseOutcome::Pending(approval)) => {
                return Err(Refusal {
                    response: json_response(
                        StatusCode::PRECONDITION_REQUIRED,
                        "card_approval_required",
                        json!({
                            "error": "card_approval_required",
                            "message": format!(
                                "using card `{}` at `{}` needs a human approval; the request was not forwarded",
                                binding.coords.key, target.host
                            ),
                            "approvalId": approval.id,
                            "approvePath": approval.approve_path(),
                            "statusPath": approval.agent_status_path(),
                            "card": {
                                "key": binding.coords.key,
                                "brand": approval.brand,
                                "last4": approval.last4,
                            },
                            "merchant": target.host,
                        }),
                    ),
                    outcome: "card_approval_required",
                })
            }
            Err(error) => return Err(card_refusal(&error)),
        };
        let spend = CardSpend {
            request,
            approval_id,
        };
        // Every placeholder must resolve: a field the card does not store
        // (an optional security code, say) would otherwise be forwarded as
        // the literal placeholder while the approval is spent. Return the
        // use and refuse instead of sending.
        let mut pairs: Vec<(String, String)> = Vec::with_capacity(found.len());
        for placeholder in &found {
            let Some(value) = values.get(placeholder.field) else {
                let refusal = Refusal::new(
                    StatusCode::CONFLICT,
                    "card_field_missing",
                    &format!(
                        "card `{}` has no `{}` value; the request was not forwarded",
                        binding.coords.key, placeholder.field
                    ),
                );
                return Err(self.refund_on_refusal(&spend, refusal).await);
            };
            pairs.push((placeholder.token.clone(), value.clone()));
        }
        if let Err(refusal) = substitute_headers(&mut outgoing.headers, &pairs) {
            return Err(self.refund_on_refusal(&spend, refusal).await);
        }
        if let Some(body) = substitute::substitute_body(&outgoing.body, body_kind, &pairs) {
            outgoing.body = Bytes::from(body);
        }
        Ok(Some(spend))
    }

    /// Return a card use whose substitution failed before sending, then
    /// pass the refusal on.
    pub(super) async fn refund_on_refusal(&self, spend: &CardSpend, refusal: Refusal) -> Refusal {
        if let Err(error) = self
            .store
            .card_use_refund(&spend.request, &spend.approval_id, refusal.outcome)
            .await
        {
            tracing::warn!("returning a card use failed: {error:#}");
        }
        refusal
    }

    /// Who may use cards through `session`, and the agent subject a card
    /// grant can bind to: the minting machine identity, or whoever minted
    /// the session.
    pub(super) async fn card_principal(
        &self,
        session: &BrokerSession,
    ) -> Result<(CardAuthority, String), Refusal> {
        let Some(accessor) = &session.minted_token else {
            let authority = match &session.minter_scope {
                Some(scope) => {
                    let conn = self.store.conn.lock().await;
                    let policies = crate::vault::policy::policies_for(&conn, &scope.subjects)
                        .map_err(|error| {
                            tracing::warn!("broker minter policy lookup failed: {error:#}");
                            Refusal::new(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                "broker_internal",
                                "policy lookup failed",
                            )
                        })?;
                    CardAuthority::Human {
                        policies,
                        scope: scope.clone(),
                    }
                }
                None => CardAuthority::Nobody,
            };
            return Ok((authority, session.minted_by.clone()));
        };
        let policies = self.minting_machine_policies(session).await?;
        let conn = self.store.conn.lock().await;
        let subject = crate::vault::machine::principal_by_accessor_locked(&conn, accessor)
            .ok()
            .flatten()
            .map_or_else(
                || session.minted_by.clone(),
                |principal| principal.subject(),
            );
        let authority = policies.map_or(CardAuthority::Nobody, |policies| CardAuthority::Machine {
            policies,
            subject: subject.clone(),
        });
        Ok((authority, subject))
    }
}

/// A refusal for a card use that failed. Messages name the card and state,
/// never a value.
fn card_refusal(error: &anyhow::Error) -> Refusal {
    match error.downcast_ref::<VaultError>() {
        Some(VaultError::AuditUnavailable) => Refusal::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "audit_unavailable",
            "no audit device accepted the card use; nothing was released",
        ),
        Some(VaultError::Sealed) => Refusal::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "vault_sealed",
            "the vault is sealed",
        ),
        Some(VaultError::Conflict(message) | VaultError::Invalid(message)) => {
            Refusal::new(StatusCode::CONFLICT, "card_unusable", message)
        }
        _ => {
            tracing::warn!("broker card use failed: {error:#}");
            Refusal::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "broker_internal",
                "card use failed",
            )
        }
    }
}

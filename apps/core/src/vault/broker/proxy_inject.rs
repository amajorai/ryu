//! Service credential injection: placeholder substitution and service auth.

use super::resolver::Resolver;
use super::*;

impl Broker {
    // ── Credential injection ──────────────────────────────────────────────

    pub(super) async fn inject(
        &self,
        session: &BrokerSession,
        service: &BrokerService,
        outgoing: &mut Outgoing,
    ) -> Result<(), Refusal> {
        let machine_policies = self.minting_machine_policies(session).await?;
        // A human minter's role and team subjects, captured at mint, so their
        // `role:`/`team:` deny rules hold here as they do in management.
        let minter_subjects = session
            .minter_scope
            .as_ref()
            .map(|scope| scope.subjects.clone());
        let roles = minter_subjects
            .iter()
            .flatten()
            .filter_map(|subject| subject.strip_prefix("role:"))
            .map(str::to_owned)
            .collect();
        let context = SecretResolutionContext {
            user_id: session.user_id().map(str::to_owned),
            environment: Some(session.environment.clone()),
            conversation_id: Some(format!("broker:{}", session.id)),
            roles,
            minted_subjects: session
                .minter_scope
                .as_ref()
                .map(|scope| scope.subjects.clone())
                .unwrap_or_default(),
            ..SecretResolutionContext::node_only(super::super::local_node_id(), Vec::new())
        };
        let mut resolver = Resolver {
            store: self.store,
            context,
            environment: session.environment.clone(),
            machine_policies,
            minter_subjects,
            cache: HashMap::new(),
            subject: session.minted_by.clone(),
            session_id: session.id.clone(),
        };
        self.substitute(service, outgoing, &mut resolver).await?;
        self.apply_auth(&service.input.auth, outgoing, &mut resolver)
            .await
    }

    /// For a machine-minted session, the minting token's current policies
    /// (`None` for sessions a human or the operator minted, whose user
    /// subject the resolver applies itself). A token revoked since minting
    /// ends the session.
    pub(super) async fn minting_machine_policies(
        &self,
        session: &BrokerSession,
    ) -> Result<Option<Vec<Policy>>, Refusal> {
        let Some(accessor) = &session.minted_token else {
            return Ok(None);
        };
        let conn = self.store.conn.lock().await;
        let policies = crate::vault::machine::principal_by_accessor_locked(&conn, accessor)
            .and_then(|principal| {
                principal
                    .map(|principal| {
                        crate::vault::machine::principal_policies_locked(&conn, &principal)
                    })
                    .transpose()
            });
        match policies {
            Ok(Some(policies)) => Ok(Some(policies)),
            Ok(None) => Err(Refusal {
                response: proxy_auth_required(),
                outcome: "proxy_auth_required",
            }),
            Err(error) => {
                tracing::warn!("broker machine policy lookup failed: {error:#}");
                Err(Refusal::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "broker_internal",
                    "policy lookup failed",
                ))
            }
        }
    }

    pub(super) async fn substitute(
        &self,
        service: &BrokerService,
        outgoing: &mut Outgoing,
        resolver: &mut Resolver,
    ) -> Result<(), Refusal> {
        let body_kind = substitute::body_kind(
            header_str(&outgoing.headers, hyper::header::CONTENT_TYPE.as_str()),
            header_str(&outgoing.headers, hyper::header::CONTENT_ENCODING.as_str()),
        );
        let mut by_surface: HashMap<Surface, Vec<(String, String)>> = HashMap::new();
        for substitution in &service.input.substitutions {
            let placeholder = substitution.placeholder.as_str();
            let present = substitution.surfaces.iter().any(|surface| match surface {
                Surface::Path => outgoing.path.contains(placeholder),
                Surface::Query => outgoing
                    .query
                    .as_deref()
                    .is_some_and(|query| query.contains(placeholder)),
                Surface::Header => outgoing
                    .headers
                    .values()
                    .any(|value| contains_bytes(value.as_bytes(), placeholder.as_bytes())),
                Surface::Body => {
                    body_kind != substitute::BodyKind::Opaque
                        && contains_bytes(&outgoing.body, placeholder.as_bytes())
                }
            });
            if !present {
                continue;
            }
            let value = resolver.resolve(&substitution.reference).await?;
            for surface in &substitution.surfaces {
                by_surface
                    .entry(*surface)
                    .or_default()
                    .push((substitution.placeholder.clone(), value.clone()));
            }
        }
        if let Some(pairs) = by_surface.get(&Surface::Path) {
            if let Some(path) =
                substitute::replace_all(&outgoing.path, pairs, substitute::encode_url)
            {
                outgoing.path = path;
            }
        }
        if let Some(pairs) = by_surface.get(&Surface::Query) {
            if let Some(query) = outgoing
                .query
                .as_deref()
                .and_then(|query| substitute::replace_all(query, pairs, substitute::encode_url))
            {
                outgoing.query = Some(query);
            }
        }
        if let Some(pairs) = by_surface.get(&Surface::Header) {
            substitute_headers(&mut outgoing.headers, pairs)?;
        }
        if let Some(pairs) = by_surface.get(&Surface::Body) {
            if let Some(body) = substitute::substitute_body(&outgoing.body, body_kind, pairs) {
                outgoing.body = Bytes::from(body);
            }
        }
        Ok(())
    }

    pub(super) async fn apply_auth(
        &self,
        auth: &ServiceAuth,
        outgoing: &mut Outgoing,
        resolver: &mut Resolver,
    ) -> Result<(), Refusal> {
        let headers: Vec<(String, String)> = match auth {
            ServiceAuth::Passthrough => Vec::new(),
            ServiceAuth::Bearer { token } => vec![(
                "authorization".to_owned(),
                format!("Bearer {}", resolver.resolve(token).await?),
            )],
            ServiceAuth::Basic { username, password } => {
                use base64::Engine as _;
                let username = if substitute::is_credential_ref(username) {
                    resolver.resolve(username).await?
                } else {
                    username.clone()
                };
                let password = resolver.resolve(password).await?;
                let encoded = base64::engine::general_purpose::STANDARD
                    .encode(format!("{username}:{password}"));
                vec![("authorization".to_owned(), format!("Basic {encoded}"))]
            }
            ServiceAuth::ApiKey {
                header,
                value,
                prefix,
            } => vec![(
                header.to_ascii_lowercase(),
                format!("{prefix}{}", resolver.resolve(value).await?),
            )],
            ServiceAuth::Custom { headers } => {
                let mut rendered = Vec::with_capacity(headers.len());
                for (name, template) in headers {
                    let mut value = String::new();
                    let segments = substitute::parse_template(template).map_err(|_| {
                        Refusal::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "invalid_service",
                            "the service header template is invalid",
                        )
                    })?;
                    for segment in segments {
                        match segment {
                            substitute::Segment::Literal(text) => value.push_str(&text),
                            substitute::Segment::Ref(reference) => {
                                value.push_str(&resolver.resolve(&reference).await?);
                            }
                        }
                    }
                    rendered.push((name.to_ascii_lowercase(), value));
                }
                rendered
            }
        };
        for (name, value) in headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
                Refusal::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "invalid_service",
                    "invalid header name",
                )
            })?;
            outgoing.headers.insert(name, sensitive_value(&value)?);
        }
        Ok(())
    }
}

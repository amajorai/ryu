//! Credential injection: placeholder substitution and service auth headers.
//! test-exempt: moved out of proxy.rs; proxy_tests.rs drives every substitution surface and auth type end to end.

use super::*;

impl Broker {
    /// Substitute placeholders and add the service's auth. `oauth_action` is
    /// the connection action an OAuth token is fetched for.
    pub(super) async fn inject(
        &self,
        session: &BrokerSession,
        service: &BrokerService,
        outgoing: &mut Outgoing,
        oauth_action: ConnectionAction,
    ) -> Result<(), Refusal> {
        let mut resolver = self.resolver(session).await?;
        let headers_only = super::super::box_relay::is_box_session(session);
        self.substitute(service, outgoing, &mut resolver, headers_only)
            .await?;
        match &service.input.auth {
            ServiceAuth::OAuth(binding) => {
                self.apply_oauth(
                    session,
                    service.name(),
                    binding,
                    outgoing,
                    oauth_action,
                    false,
                )
                .await
            }
            auth => self.apply_auth(auth, outgoing, &mut resolver).await,
        }
    }

    /// A credential resolver bound to the session's minter and policies.
    pub(super) async fn resolver(&self, session: &BrokerSession) -> Result<Resolver, Refusal> {
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
        Ok(Resolver {
            store: self.store,
            context,
            environment: session.environment.clone(),
            machine_policies,
            minter_subjects,
            cache: HashMap::new(),
            subject: session.minted_by.clone(),
            session_id: session.id.clone(),
        })
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

    /// Substitute the service's placeholders. `headers_only` (a Box's relayed
    /// session) skips path, query and body: hosts store and echo those, so
    /// an untrusted Box could read a value back.
    pub(super) async fn substitute(
        &self,
        service: &BrokerService,
        outgoing: &mut Outgoing,
        resolver: &mut Resolver,
        headers_only: bool,
    ) -> Result<(), Refusal> {
        let body_kind = substitute::body_kind(
            header_str(&outgoing.headers, hyper::header::CONTENT_TYPE.as_str()),
            header_str(&outgoing.headers, hyper::header::CONTENT_ENCODING.as_str()),
        );
        let mut by_surface: HashMap<Surface, Vec<(String, String)>> = HashMap::new();
        for substitution in &service.input.substitutions {
            let surfaces: Vec<Surface> = substitution
                .surfaces
                .iter()
                .copied()
                .filter(|surface| !headers_only || *surface == Surface::Header)
                .collect();
            let placeholder = substitution.placeholder.as_str();
            let present = surfaces.iter().any(|surface| match surface {
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
                // Substituted per message once a WebSocket is relayed.
                Surface::WebSocket => false,
            });
            if !present {
                continue;
            }
            let value = resolver.resolve(&substitution.reference).await?;
            for surface in &surfaces {
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
            // OAuth rules are applied by `apply_oauth`.
            ServiceAuth::Passthrough | ServiceAuth::OAuth(_) => Vec::new(),
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

pub(super) fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

pub(super) fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// A header value marked sensitive; a credential containing CR, LF, or NUL
/// fails closed instead of splitting the request.
pub(super) fn sensitive_value(value: &str) -> Result<HeaderValue, Refusal> {
    if !substitute::is_safe_header_value(value) {
        return Err(Refusal::new(
            StatusCode::BAD_GATEWAY,
            "credential_invalid",
            "a credential is not a valid header value",
        ));
    }
    let mut header = HeaderValue::from_bytes(value.as_bytes()).map_err(|_| {
        Refusal::new(
            StatusCode::BAD_GATEWAY,
            "credential_invalid",
            "a credential is not a valid header value",
        )
    })?;
    header.set_sensitive(true);
    Ok(header)
}

pub(super) fn substitute_headers(
    headers: &mut HeaderMap,
    pairs: &[(String, String)],
) -> Result<(), Refusal> {
    let mut rewritten = Vec::new();
    for (name, value) in headers.iter() {
        let Ok(text) = value.to_str() else {
            continue;
        };
        if let Some(replaced) = substitute::replace_all(text, pairs, str::to_owned) {
            rewritten.push((name.clone(), sensitive_value(&replaced)?));
        }
    }
    for (name, value) in rewritten {
        headers.insert(name, value);
    }
    Ok(())
}

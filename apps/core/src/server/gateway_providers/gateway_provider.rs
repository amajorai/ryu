//! The BYOK provider-key vault: `gateway_set_provider` through `gateway_set_provider`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    put,
    path = "/api/gateway/providers",
    tag = "Gateway",
    summary = "Set a BYOK provider key (proxied)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_set_provider(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<SetProviderBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: gateway.configure" })),
        );
    }

    let requested_provider = body.provider.trim().to_ascii_lowercase();
    let provider = ryu_gw_credentials::sdk_provider_by_id(&requested_provider)
        .map(|descriptor| descriptor.account_scope.to_owned())
        .unwrap_or(requested_provider);
    let sdk_descriptor = sdk_accounts::descriptor(&provider);
    let compatible_url = ryu_gw_credentials::direct_compatible_provider_url(&provider);
    if !matches!(
        provider.as_str(),
        "openai"
            | "anthropic"
            | "openrouter"
            | "gemini"
            | "cohere"
            | "deepgram"
            | "assemblyai"
            | "elevenlabs"
            | "inworld"
            | "modal"
            | "replicate"
            | "fal"
            | "recraft"
            | "stability"
            | "bfl"
            | "minimax"
            | "runway"
            | "topaz"
    ) && compatible_url.is_none()
        && sdk_descriptor.is_none()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "unknown direct provider" })),
        );
    }
    if sdk_descriptor.is_none() && (body.sdk_context.is_some() || body.allow_environment.is_some())
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success":false,"error":"SDK context controls require an SDK connection"})),
        );
    }
    if body.account_action.as_deref() == Some("replace")
        && sdk_descriptor.is_none()
        && body.account_id.is_none()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success":false,"error":"targeted replacement requires accountId"})),
        );
    }
    if let Some(ref key) = body.api_key {
        if key.trim().is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    json!({ "success": false, "error": "api_key must not be empty (use null to clear)" }),
                ),
            );
        }
    }
    if body.account_id.is_some()
        && !matches!(
            body.account_action.as_deref(),
            Some("configure" | "remove" | "replace")
        )
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({"success":false,"error":"accountId requires configure, remove or replace action"}),
            ),
        );
    }
    let provider_action = if body.account_action.is_some() {
        body.account_action.as_deref().unwrap_or("account")
    } else if body.api_key.is_some()
        || body.sdk_context.is_some()
        || body.allow_environment.is_some()
    {
        "set"
    } else {
        "clear"
    };

    if provider_action == "configure" {
        let patch = match gateway_account_policy_patch(&provider, &body) {
            Ok(patch) => patch,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"success":false,"error":error})),
                );
            }
        };
        return match crate::sidecar::gateway::push_config_with_actor(
            &state.client,
            &patch,
            caller.as_ref().map(|value| value.user_id.as_str()),
            caller.as_ref().and_then(|value| value.email.as_deref()),
        )
        .await
        {
            Err(error) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({"success":false,"error":error.to_string()})),
            ),
            Ok((status, response)) if !status.is_success() => (
                StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
                Json(response),
            ),
            Ok((_, response)) => {
                let Some(revision) = response
                    .get("configRevision")
                    .and_then(serde_json::Value::as_str)
                    .and_then(ryu_gw_credentials::ConfigRevision::parse)
                else {
                    return (
                        StatusCode::BAD_GATEWAY,
                        Json(
                            json!({"success":false,"error":"Gateway did not confirm account persistence"}),
                        ),
                    );
                };
                let application = response
                    .get("providerApplication")
                    .cloned()
                    .and_then(|value| {
                        serde_json::from_value::<ryu_gw_credentials::ProviderApplyOutcome>(value)
                            .ok()
                    })
                    .filter(|outcome| outcome.validates_request(&revision))
                    .unwrap_or_else(|| ryu_gw_credentials::ProviderApplyOutcome::Failed {
                        requested_revision: revision.clone(),
                        active_revision: None,
                        code: ryu_gw_credentials::ProviderApplyErrorCode::UnexpectedResponse,
                    });
                let accounts_applied = matches!(
                    application,
                    ryu_gw_credentials::ProviderApplyOutcome::Applied { .. }
                        | ryu_gw_credentials::ProviderApplyOutcome::AlreadyApplied { .. }
                );
                let summary = format!("provider={provider}; action=configure");
                record_gateway_control(
                    &state,
                    "gateway.provider.update",
                    "gateway_provider",
                    Some(&summary),
                    &caller,
                )
                .await;
                (
                    StatusCode::OK,
                    Json(
                        json!({"success":true,"persisted":response.get("persisted").and_then(serde_json::Value::as_bool).unwrap_or(false),"configRevision":revision,"provider":provider,"accountsApplied":accounts_applied,"gateway_application":application,"gateway_restarted":false}),
                    ),
                )
            }
        };
    }

    // Load, patch the providers table, write back atomically.
    let path = match gateway_config_path() {
        Some(p) => p,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": "cannot determine gateway config path" })),
            );
        }
    };

    let mut transaction = match tokio::task::spawn_blocking(move || {
        ryu_gw_credentials::ConfigFileTransaction::acquire(&path)
    })
    .await
    {
        Ok(Ok(transaction)) => transaction,
        Ok(Err(error)) => return gateway_config_transaction_error(error),
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    json!({"success":false,"error":"Gateway configuration transaction could not start"}),
                ),
            );
        }
    };
    let revision = transaction.snapshot().revision().clone();
    if body
        .expected_revision
        .as_ref()
        .is_some_and(|expected| expected != &revision)
    {
        return gateway_config_transaction_error(ryu_gw_credentials::ConfigCommitError::Conflict {
            current_revision: revision,
        });
    }
    let load_result = gateway_config_document(&transaction);

    let mut root = match load_result {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    json!({ "success": false, "error": format!("failed to read gateway config: {e}") }),
                ),
            );
        }
    };

    let providers_table = root
        .as_table_mut()
        .expect("root is a table")
        .entry("providers")
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
        .as_table_mut()
        .expect("providers is a table");

    if provider == "modal"
        && body.api_key.is_some()
        && !providers_table
            .get("modal")
            .and_then(toml::Value::as_table)
            .and_then(|config| config.get("base_url"))
            .and_then(toml::Value::as_str)
            .is_some_and(|url| !url.trim().is_empty())
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({"success":false,"error":"Configure the Modal deployment base_url before editing its keys"}),
            ),
        );
    }

    let original_keys = match gateway_account_keys(providers_table, &provider) {
        Ok(keys) => keys,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"success":false,"error":error})),
            );
        }
    };
    let original_ids: Vec<_> = original_keys
        .iter()
        .map(|key| ryu_gw_credentials::provider_account_id(&provider, key))
        .collect();
    let account_index = if let Some(id) = body.account_id.as_deref() {
        match original_keys
            .iter()
            .position(|key| ryu_gw_credentials::provider_account_id(&provider, key) == id)
        {
            Some(index)
                if body
                    .account_index
                    .is_none_or(|requested| requested == index) =>
            {
                Some(index)
            }
            Some(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"success":false,"error":"account_index does not match accountId"})),
                );
            }
            _ => {
                return (
                    StatusCode::CONFLICT,
                    Json(
                        json!({"success":false,"error":"account no longer exists; refresh the account list"}),
                    ),
                );
            }
        }
    } else {
        body.account_index
    };
    if body.account_policy.is_some() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success":false,"error":"accountPolicy requires configure action"})),
        );
    } else if sdk_descriptor.is_some() {
        if let Err(error) = sdk_accounts::mutate(
            providers_table,
            &provider,
            provider_action,
            body.api_key.as_deref(),
            account_index,
            body.sdk_context.as_ref(),
            body.allow_environment,
        ) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": error })),
            );
        }
    } else if let Some(action) = body.account_action.as_deref() {
        if let Err(error) = patch_gateway_provider_accounts(
            providers_table,
            &provider,
            compatible_url,
            action,
            body.api_key.as_deref(),
            account_index,
        ) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": error })),
            );
        }
    } else if let Some(base_url) = compatible_url {
        let compatible = providers_table
            .entry("compatible".to_owned())
            .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
            .as_table_mut()
            .expect("compatible providers table");
        match body.api_key.as_deref() {
            None => {
                compatible.remove(&provider);
            }
            Some(key) => {
                let entry = compatible
                    .entry(provider.clone())
                    .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
                    .as_table_mut()
                    .expect("direct provider table");
                entry.insert("api_key".to_owned(), toml::Value::String(key.to_owned()));
                entry.insert(
                    "base_url".to_owned(),
                    toml::Value::String(base_url.to_owned()),
                );
            }
        }
    } else {
        match body.api_key.as_deref() {
            None => {
                clear_gateway_provider_keys(providers_table, &provider);
            }
            Some(key) => {
                let entry = providers_table
                    .entry(provider.clone())
                    .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
                if let Some(t) = entry.as_table_mut() {
                    t.insert("api_key".to_string(), toml::Value::String(key.to_owned()));
                }
            }
        }
    }

    if sdk_descriptor.is_none() {
        // Authored native replacement/clear owns its source choice, suppressing
        // stale spawn-pref imports without copying imported material into files.
        let imports = providers_table
            .entry("environmentImports".to_owned())
            .or_insert_with(|| toml::Value::Table(Default::default()));
        let Some(imports) = imports.as_table_mut() else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"success":false,"error":"Native environment imports must be a table"})),
            );
        };
        imports.insert(provider.clone(), toml::Value::Boolean(false));
    }
    if sdk_descriptor.is_none() && body.account_action.as_deref() == Some("replace") {
        let old_id = body
            .account_id
            .as_deref()
            .expect("native replacement requires accountId");
        let replacement = body
            .api_key
            .as_deref()
            .expect("native replacement requires api_key");
        let new_id = ryu_gw_credentials::provider_account_id(&provider, replacement);
        if let Err(error) =
            carry_gateway_provider_account_policy(providers_table, &provider, old_id, &new_id)
        {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"success":false,"error":error})),
            );
        }
    }
    let remaining_ids: Vec<String> = match gateway_account_keys(providers_table, &provider) {
        Ok(keys) => keys
            .iter()
            .map(|key| ryu_gw_credentials::provider_account_id(&provider, key))
            .collect(),
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"success":false,"error":error})),
            );
        }
    };
    if let Some(policies) = providers_table
        .get_mut("accountPolicies")
        .and_then(toml::Value::as_table_mut)
        .and_then(|table| table.get_mut(&provider))
        .and_then(toml::Value::as_table_mut)
    {
        policies.retain(|id, _| {
            !original_ids.iter().any(|original| original == id)
                || remaining_ids.iter().any(|remaining| remaining == id)
        });
    }
    let toml_str = match toml::to_string_pretty(&root) {
        Ok(value) => value,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"success":false,"error":"Gateway configuration could not be encoded"})),
            );
        }
    };
    let config_revision = match tokio::task::spawn_blocking(move || {
        transaction.commit(&revision, toml_str.as_bytes())
    })
    .await
    {
        Ok(Ok(revision)) => revision,
        Ok(Err(error)) => return gateway_config_transaction_error(error),
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    json!({"success":false,"error":"Gateway configuration transaction could not finish"}),
                ),
            );
        }
    };

    let summary = format!("provider={provider}; action={provider_action}");
    record_gateway_control(
        &state,
        "gateway.provider.update",
        "gateway_provider",
        Some(&summary),
        &caller,
    )
    .await;

    let gateway_application = state
        .gateway
        .apply_provider_revision(&config_revision)
        .await;

    (
        StatusCode::OK,
        Json(
            json!({ "success": true, "persisted": true, "configRevision": config_revision, "provider": provider, "gateway_restarted": false, "gateway_application": gateway_application }),
        ),
    )
}

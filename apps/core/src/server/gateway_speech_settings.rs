//! Protected explicit opt-in for the unofficial anonymous Edge speech service.
use super::ServerState;
use axum::{
    extract::{Json, State},
    http::StatusCode,
    Extension,
};
use ryu_gw_credentials::{ConfigCommitError, ConfigFileTransaction, ConfigRevision};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SpeechSettingsWriteBody {
    anonymous_consumer_opt_in: bool,
    expected_revision: ConfigRevision,
    #[serde(default)]
    provider: AnonymousSpeechProvider,
}
#[derive(Clone, Copy, Default, Deserialize)]
enum AnonymousSpeechProvider {
    #[default]
    #[serde(rename = "edge-tts")]
    Edge,
    #[serde(rename = "google-translate-tts")]
    GoogleTranslate,
}
impl AnonymousSpeechProvider {
    fn field(self) -> &'static str {
        match self {
            Self::Edge => "edge_tts",
            Self::GoogleTranslate => "google_translate_tts",
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::Edge => "edge-tts",
            Self::GoogleTranslate => "google-translate-tts",
        }
    }
}
fn failure(status: StatusCode, message: &'static str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({"success":false,"error":message})))
}
fn safe_view(opt_in: bool) -> Value {
    json!({"provider":"edge-tts","anonymousConsumerOptIn":opt_in,"classification":"unofficial_anonymous_consumer","mode":"anonymous"})
}
fn translate_view(opt_in: bool) -> Value {
    json!({"provider":"google-translate-tts","anonymousConsumerOptIn":opt_in,"classification":"unofficial_anonymous_consumer","mode":"anonymous"})
}
fn read_setting(root: &toml::Value) -> Result<bool, ConfigCommitError> {
    read_provider_setting(root, AnonymousSpeechProvider::Edge)
}
fn read_provider_setting(
    root: &toml::Value,
    provider: AnonymousSpeechProvider,
) -> Result<bool, ConfigCommitError> {
    let Some(providers) = root.get("providers") else {
        return Ok(false);
    };
    let providers = providers.as_table().ok_or(ConfigCommitError::InvalidFile)?;
    let Some(edge) = providers.get(provider.field()) else {
        return Ok(false);
    };
    let edge = edge.as_table().ok_or(ConfigCommitError::InvalidFile)?;
    if edge.keys().any(|key| key != "anonymous_consumer_opt_in") {
        return Err(ConfigCommitError::InvalidFile);
    }
    match edge.get("anonymous_consumer_opt_in") {
        None => Ok(false),
        Some(value) => value.as_bool().ok_or(ConfigCommitError::InvalidFile),
    }
}
#[cfg(test)]
fn read_file(path: &std::path::Path) -> Result<(ConfigRevision, bool), ConfigCommitError> {
    let transaction = ConfigFileTransaction::acquire(path)?;
    let root =
        super::gateway_config_document(&transaction).map_err(|_| ConfigCommitError::InvalidFile)?;
    Ok((
        transaction.snapshot().revision().clone(),
        read_setting(&root)?,
    ))
}
fn read_full_file(
    path: &std::path::Path,
) -> Result<(ConfigRevision, bool, bool), ConfigCommitError> {
    let transaction = ConfigFileTransaction::acquire(path)?;
    let root =
        super::gateway_config_document(&transaction).map_err(|_| ConfigCommitError::InvalidFile)?;
    Ok((
        transaction.snapshot().revision().clone(),
        read_setting(&root)?,
        read_provider_setting(&root, AnonymousSpeechProvider::GoogleTranslate)?,
    ))
}
#[cfg(test)]
fn write_file(
    path: &std::path::Path,
    expected: &ConfigRevision,
    opt_in: bool,
) -> Result<ConfigRevision, ConfigCommitError> {
    write_provider_file(path, expected, opt_in, AnonymousSpeechProvider::Edge)
}
fn write_provider_file(
    path: &std::path::Path,
    expected: &ConfigRevision,
    opt_in: bool,
    provider: AnonymousSpeechProvider,
) -> Result<ConfigRevision, ConfigCommitError> {
    let mut transaction = ConfigFileTransaction::acquire(path)?;
    let current = transaction.snapshot().revision().clone();
    if &current != expected {
        return Err(ConfigCommitError::Conflict {
            current_revision: current,
        });
    }
    let mut root =
        super::gateway_config_document(&transaction).map_err(|_| ConfigCommitError::InvalidFile)?;
    read_provider_setting(&root, provider)?;
    let table = root.as_table_mut().ok_or(ConfigCommitError::InvalidFile)?;
    let providers = table
        .entry("providers")
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or(ConfigCommitError::InvalidFile)?;
    let edge = providers
        .entry(provider.field())
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or(ConfigCommitError::InvalidFile)?;
    edge.insert(
        "anonymous_consumer_opt_in".to_owned(),
        toml::Value::Boolean(opt_in),
    );
    let bytes = toml::to_string_pretty(&root)
        .map_err(|_| ConfigCommitError::InvalidFile)?
        .into_bytes();
    transaction.commit(expected, &bytes)
}

#[utoipa::path(
    get,
    path = "/api/gateway/speech-settings",
    tag = "Gateway",
    summary = "Read the Gateway's free text-to-speech settings",
    responses((status = 200, description = "Speech settings and config revision", body = serde_json::Value))
)]
pub(super) async fn gateway_speech_settings_get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> (StatusCode, Json<Value>) {
    if super::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::GATEWAY_VIEW,
    )
    .await
    .is_err()
    {
        return failure(
            StatusCode::FORBIDDEN,
            "insufficient permissions: gateway.view",
        );
    }
    let Some(path) = super::gateway_config_path() else {
        return failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine gateway config path",
        );
    };
    match tokio::task::spawn_blocking(move || read_full_file(&path)).await {
        Ok(Ok((revision, opt_in, translate_opt_in))) => (
            StatusCode::OK,
            Json(
                json!({"speechSettingsSchema":1,"configRevision":revision,"edgeTts":safe_view(opt_in),"googleTranslateTts":translate_view(translate_opt_in)}),
            ),
        ),
        Ok(Err(error)) => super::gateway_config_transaction_error(error),
        Err(_) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "gateway speech settings could not be read",
        ),
    }
}
#[utoipa::path(
    put,
    path = "/api/gateway/speech-settings",
    tag = "Gateway",
    summary = "Turn the Gateway's free text-to-speech voices on or off",
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved", body = serde_json::Value))
)]
pub(super) async fn gateway_speech_settings_put(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<SpeechSettingsWriteBody>,
) -> (StatusCode, Json<Value>) {
    if super::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .is_err()
    {
        return failure(
            StatusCode::FORBIDDEN,
            "insufficient permissions: gateway.configure",
        );
    }
    let Some(path) = super::gateway_config_path() else {
        return failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot determine gateway config path",
        );
    };
    let opt_in = body.anonymous_consumer_opt_in;
    let provider = body.provider;
    let revision = match tokio::task::spawn_blocking(move || {
        write_provider_file(&path, &body.expected_revision, opt_in, provider)
    })
    .await
    {
        Ok(Ok(revision)) => revision,
        Ok(Err(error)) => return super::gateway_config_transaction_error(error),
        Err(_) => {
            return failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "gateway speech settings could not be saved",
            );
        }
    };
    // No authored-file guard crosses audit or HTTP.
    super::record_gateway_control(
        &state,
        "gateway.speech_settings.update",
        "gateway_speech_settings",
        Some(provider.id()),
        &caller,
    )
    .await;
    let application = state.gateway.apply_provider_revision(&revision).await;
    let mut result = json!({"success":true,"persisted":true,"gateway_restarted":false,"configRevision":revision,"provider":provider.id(),"anonymousConsumerOptIn":opt_in,"gateway_application":application});
    match provider {
        AnonymousSpeechProvider::Edge => result["edgeTts"] = safe_view(opt_in),
        AnonymousSpeechProvider::GoogleTranslate => {
            result["googleTranslateTts"] = translate_view(opt_in)
        }
    }
    (StatusCode::OK, Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn translate_opt_in_is_revision_checked_and_preserves_edge_and_cloud_custody() {
        crate::server::gateway_seal_test_key();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("gateway.toml");
        std::fs::write(&path, "[providers.edge_tts]\nanonymous_consumer_opt_in=true\n[providers.google_tts]\naccounts=[{access_token='synthetic-cloud-token',quota_project='synthetic-project'}]\n").unwrap();
        let (revision, edge, translate) = read_full_file(&path).unwrap();
        assert!(edge);
        assert!(!translate);
        let next = write_provider_file(
            &path,
            &revision,
            true,
            AnonymousSpeechProvider::GoogleTranslate,
        )
        .unwrap();
        assert_eq!(read_full_file(&path).unwrap(), (next.clone(), true, true));
        assert!(matches!(
            write_provider_file(
                &path,
                &revision,
                false,
                AnonymousSpeechProvider::GoogleTranslate
            ),
            Err(ConfigCommitError::Conflict { .. })
        ));
        write_provider_file(
            &path,
            &next,
            false,
            AnonymousSpeechProvider::GoogleTranslate,
        )
        .unwrap();
        let disk = std::fs::read_to_string(&path).unwrap();
        // The legacy plaintext token was sealed by the first keyed write.
        assert!(!disk.contains("synthetic-cloud-token"));
        let root = ryu_gw_credentials::sealed_config::open_document(&disk).unwrap();
        assert_eq!(
            root["providers"]["google_tts"]["accounts"][0]["access_token"].as_str(),
            Some("synthetic-cloud-token")
        );
        assert!(read_full_file(&path).unwrap().1);
        assert!(!read_full_file(&path).unwrap().2);
        assert!(serde_json::from_value::<SpeechSettingsWriteBody>(
            json!({"provider":"unknown","anonymousConsumerOptIn":true,"expectedRevision":next})
        )
        .is_err());
    }
    #[test]
    fn actual_guarded_toggle_preserves_other_fields_rejects_stale_and_disables_without_keys() {
        crate::server::gateway_seal_test_key();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("gateway.toml");
        let original = "operator_unknown = 'preserved'\n[providers.openai]\napi_key = 'private-native-key'\ncustom = 'preserved'\n";
        std::fs::write(&path, original).unwrap();
        let (first, enabled) = read_file(&path).unwrap();
        assert!(!enabled);
        let applied = write_file(&path, &first, true).unwrap();
        assert!(read_file(&path).unwrap().1);
        assert!(matches!(
            write_file(&path, &first, false),
            Err(ConfigCommitError::Conflict { .. })
        ));
        let persisted = std::fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains("private-native-key"));
        let root = ryu_gw_credentials::sealed_config::open_document(&persisted).unwrap();
        assert_eq!(root["operator_unknown"].as_str(), Some("preserved"));
        assert_eq!(
            root["providers"]["openai"]["api_key"].as_str(),
            Some("private-native-key")
        );
        assert_eq!(
            root["providers"]["openai"]["custom"].as_str(),
            Some("preserved")
        );
        assert_eq!(root["providers"]["edge_tts"].as_table().unwrap().len(), 1);
        let disabled = write_file(&path, &applied, false).unwrap();
        let (current, enabled) = read_file(&path).unwrap();
        assert_eq!(current, disabled);
        assert!(!enabled);
        let view = safe_view(enabled);
        assert!(view.get("accounts").is_none());
        assert!(view.get("apiKey").is_none());
    }
    #[test]
    fn malformed_external_settings_and_fake_credential_fields_are_rejected_without_overwrite() {
        for original in [
            "providers='secret-bad-shape'",
            "[providers.edge_tts]\nanonymous_consumer_opt_in='secret-not-bool'",
            "[providers.edge_tts]\napi_key='secret-fake-key'",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("gateway.toml");
            std::fs::write(&path, original).unwrap();
            let transaction = ConfigFileTransaction::acquire(&path).unwrap();
            let revision = transaction.snapshot().revision().clone();
            drop(transaction);
            assert!(write_file(&path, &revision, true).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        }
        assert!(serde_json::from_value::<SpeechSettingsWriteBody>(
            json!({"anonymousConsumerOptIn":true})
        )
        .is_err());
        assert!(serde_json::from_value::<SpeechSettingsWriteBody>(
            json!({"anonymousConsumerOptIn":true,"expectedRevision":"bad","apiKey":"fake"})
        )
        .is_err());
    }
}

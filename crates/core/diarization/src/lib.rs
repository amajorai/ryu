//! Speaker diarization modality primitive for Ryu.
//!
//! One model-neutral request and timestamped-turn contract sits between consumers
//! and local model adapters. The client owns multipart encoding, sidecar
//! authentication, request timeouts, response parsing, and turn validation; it has
//! no dependency on `apps/core` or any model runtime.

use std::{error::Error, fmt, time::Duration};

use reqwest::{multipart, Client, Url};
use serde::{Deserialize, Serialize};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_TURNS: usize = 100_000;
const MAX_SPEAKER_LABEL_BYTES: usize = 128;

/// Supported model adapters. The wire value is the lowercase variant name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiarizationModel {
    Pyannote,
    Nemotron,
}

impl DiarizationModel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pyannote => "pyannote",
            Self::Nemotron => "nemotron",
        }
    }
}

impl fmt::Display for DiarizationModel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl TryFrom<&str> for DiarizationModel {
    type Error = DiarizationError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value.trim() {
            "pyannote" => Ok(Self::Pyannote),
            "nemotron" => Ok(Self::Nemotron),
            _ => Err(DiarizationError::InvalidRequest(format!(
                "unsupported diarization model '{value}'"
            ))),
        }
    }
}

/// Model-neutral request options. `num_speakers` is optional because some models
/// discover speaker count automatically; adapters must reject unsupported values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizationRequest {
    pub model: DiarizationModel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_speakers: Option<u8>,
}

impl DiarizationRequest {
    pub const fn new(model: DiarizationModel) -> Self {
        Self {
            model,
            num_speakers: None,
        }
    }
}

/// One detected speaker interval. `start` and `end` are seconds in the source WAV.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpeakerTurn {
    pub start: f64,
    pub end: f64,
    pub speaker: String,
}

/// Normalized model response shared by all adapters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiarizationResponse {
    pub turns: Vec<SpeakerTurn>,
}

/// Error from client configuration, transport, response parsing, or validation.
#[derive(Debug)]
pub enum DiarizationError {
    InvalidRequest(String),
    InvalidEndpoint(String),
    MissingBearerToken,
    Transport(reqwest::Error),
    HttpStatus { status: u16, body: String },
    InvalidResponse(serde_json::Error),
    InvalidTurn(String),
}

impl fmt::Display for DiarizationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => formatter.write_str(message),
            Self::InvalidEndpoint(message) => {
                write!(formatter, "invalid diarization endpoint: {message}")
            }
            Self::MissingBearerToken => formatter.write_str("Ryu sidecar bearer token is missing"),
            Self::Transport(error) => {
                write!(formatter, "diarization runtime request failed: {error}")
            }
            Self::HttpStatus { status, body } => {
                write!(formatter, "diarization runtime returned HTTP {status}")?;
                if !body.is_empty() {
                    write!(formatter, ": {body}")?;
                }
                Ok(())
            }
            Self::InvalidResponse(error) => {
                write!(formatter, "invalid diarization response: {error}")
            }
            Self::InvalidTurn(message) => write!(formatter, "invalid diarization turn: {message}"),
        }
    }
}

impl Error for DiarizationError {}

/// Authenticated client for a local model-neutral diarization runtime.
#[derive(Clone)]
pub struct DiarizationClient {
    client: Client,
    endpoint: Url,
    bearer_token: String,
}

impl DiarizationClient {
    /// Build a client with the standard ten-minute inference timeout.
    pub fn new(base_url: &str, bearer_token: &str) -> Result<Self, DiarizationError> {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(DiarizationError::Transport)?;
        Self::with_client(base_url, bearer_token, client)
    }

    /// Build a client with a caller-provided HTTP client, useful for host-level
    /// timeout and proxy policy while retaining the same request contract.
    pub fn with_client(
        base_url: &str,
        bearer_token: &str,
        client: Client,
    ) -> Result<Self, DiarizationError> {
        let token = bearer_token.trim();
        if token.is_empty() {
            return Err(DiarizationError::MissingBearerToken);
        }

        let mut base = Url::parse(base_url.trim())
            .map_err(|error| DiarizationError::InvalidEndpoint(error.to_string()))?;
        if !matches!(base.scheme(), "http" | "https")
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(DiarizationError::InvalidEndpoint(
                "expected an HTTP(S) origin without credentials, query, or fragment".to_owned(),
            ));
        }
        if !base.path().ends_with('/') {
            let path = format!("{}/", base.path());
            base.set_path(&path);
        }
        let endpoint = base
            .join("diarize")
            .map_err(|error| DiarizationError::InvalidEndpoint(error.to_string()))?;

        Ok(Self {
            client,
            endpoint,
            bearer_token: token.to_owned(),
        })
    }

    /// Run the selected adapter and return validated, normalized speaker turns.
    pub async fn diarize(
        &self,
        wav: Vec<u8>,
        request: DiarizationRequest,
    ) -> Result<DiarizationResponse, DiarizationError> {
        if wav.is_empty() {
            return Err(DiarizationError::InvalidRequest(
                "audio payload is empty".to_owned(),
            ));
        }
        if request.num_speakers == Some(0) {
            return Err(DiarizationError::InvalidRequest(
                "num_speakers must be greater than zero".to_owned(),
            ));
        }

        let audio = multipart::Part::bytes(wav)
            .file_name("meeting.wav")
            .mime_str("audio/wav")
            .map_err(|error| DiarizationError::InvalidRequest(error.to_string()))?;
        let mut form = multipart::Form::new()
            .part("file", audio)
            .text("model", request.model.as_str().to_owned());
        if let Some(num_speakers) = request.num_speakers {
            form = form.text("num_speakers", num_speakers.to_string());
        }

        let response = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(&self.bearer_token)
            .multipart(form)
            .send()
            .await
            .map_err(DiarizationError::Transport)?;
        let status = response.status();
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_default()
                .chars()
                .take(512)
                .collect();
            return Err(DiarizationError::HttpStatus {
                status: status.as_u16(),
                body,
            });
        }

        let body: serde_json::Value = response.json().await.map_err(DiarizationError::Transport)?;
        let result: DiarizationResponse =
            serde_json::from_value(body).map_err(DiarizationError::InvalidResponse)?;
        validate_turns(&result.turns)?;
        Ok(result)
    }
}

/// Reject malformed model output before an app persists labels derived from it.
pub fn validate_turns(turns: &[SpeakerTurn]) -> Result<(), DiarizationError> {
    if turns.len() > MAX_TURNS {
        return Err(DiarizationError::InvalidTurn(format!(
            "response exceeds {MAX_TURNS} turns"
        )));
    }

    for (index, turn) in turns.iter().enumerate() {
        if !turn.start.is_finite()
            || !turn.end.is_finite()
            || turn.start < 0.0
            || turn.end <= turn.start
        {
            return Err(DiarizationError::InvalidTurn(format!(
                "turn {index} must have finite, nonnegative start < end"
            )));
        }
        if turn.speaker.trim().is_empty() || turn.speaker.len() > MAX_SPEAKER_LABEL_BYTES {
            return Err(DiarizationError::InvalidTurn(format!(
                "turn {index} speaker label must contain 1 to {MAX_SPEAKER_LABEL_BYTES} bytes"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::{
        extract::{Multipart, State},
        http::{HeaderMap, StatusCode},
        routing::post,
        Json, Router,
    };
    use serde_json::{json, Value};
    use tokio::net::TcpListener;

    use super::*;

    #[test]
    fn model_values_are_stable_wire_names() {
        assert_eq!(
            serde_json::to_string(&DiarizationModel::Pyannote).unwrap(),
            "\"pyannote\""
        );
        assert_eq!(
            serde_json::to_string(&DiarizationModel::Nemotron).unwrap(),
            "\"nemotron\""
        );
        assert_eq!(
            DiarizationModel::try_from(" nemotron ").unwrap(),
            DiarizationModel::Nemotron
        );
        assert!(DiarizationModel::try_from("unknown").is_err());
    }

    #[test]
    fn validates_turn_timestamps_and_labels() {
        assert!(validate_turns(&[SpeakerTurn {
            start: 0.0,
            end: 1.0,
            speaker: "SPEAKER_00".to_owned(),
        }])
        .is_ok());
        assert!(validate_turns(&[SpeakerTurn {
            start: f64::NAN,
            end: 1.0,
            speaker: "SPEAKER_00".to_owned(),
        }])
        .is_err());
        assert!(validate_turns(&[SpeakerTurn {
            start: 1.0,
            end: 1.0,
            speaker: "SPEAKER_00".to_owned(),
        }])
        .is_err());
    }

    async fn handle_diarize(
        State(expected_token): State<&'static str>,
        headers: HeaderMap,
        mut form: Multipart,
    ) -> Result<Json<Value>, StatusCode> {
        if headers
            .get(reqwest::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            != Some("Bearer test-token")
            || expected_token != "test-token"
        {
            return Err(StatusCode::UNAUTHORIZED);
        }

        let mut model = None;
        let mut num_speakers = None;
        let mut audio = Vec::new();
        while let Some(field) = form
            .next_field()
            .await
            .map_err(|_| StatusCode::BAD_REQUEST)?
        {
            let field_name = field.name().map(str::to_owned);
            match field_name.as_deref() {
                Some("model") => {
                    model = Some(field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?)
                }
                Some("num_speakers") => {
                    num_speakers = Some(field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?)
                }
                Some("file") => {
                    audio = field
                        .bytes()
                        .await
                        .map_err(|_| StatusCode::BAD_REQUEST)?
                        .to_vec()
                }
                _ => {}
            }
        }
        if model.as_deref() != Some("nemotron")
            || num_speakers.as_deref() != Some("2")
            || audio != b"wav-bytes"
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        Ok(Json(json!({
            "turns": [{ "start": 0.25, "end": 1.5, "speaker": "SPEAKER_00" }]
        })))
    }

    #[tokio::test]
    async fn client_sends_selected_model_audio_and_bearer_token() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/diarize", post(handle_diarize))
            .with_state("test-token");
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let client = DiarizationClient::new(&format!("http://{address}"), "test-token").unwrap();
        let response = client
            .diarize(
                b"wav-bytes".to_vec(),
                DiarizationRequest {
                    model: DiarizationModel::Nemotron,
                    num_speakers: Some(2),
                },
            )
            .await
            .unwrap();
        assert_eq!(response.turns.len(), 1);
        assert_eq!(response.turns[0].speaker, "SPEAKER_00");

        server.abort();
    }

    #[test]
    fn client_rejects_missing_token_and_non_http_endpoints() {
        assert!(matches!(
            DiarizationClient::new("http://127.0.0.1:8087", " "),
            Err(DiarizationError::MissingBearerToken)
        ));
        assert!(DiarizationClient::new("file:///tmp/audio", "token").is_err());
    }
}

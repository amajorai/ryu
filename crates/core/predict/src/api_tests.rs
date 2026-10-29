//! Handler-level tests for `/api/predict/*`: privacy gates, model resolution,
//! reply cleanup, error mapping, and config persistence, driven through the real
//! handlers with an in-memory fake [`PredictHost`].

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use axum::body::to_bytes;
use serde_json::Value;

use super::*;

/// One recorded `call_side_model` invocation.
#[derive(Debug, Clone)]
struct SideCall {
    model: String,
    effort: String,
    user: String,
}

struct FakeHost {
    enabled: bool,
    prefs: Mutex<HashMap<String, String>>,
    pref_set_error: Option<String>,
    agent_models: HashMap<String, String>,
    reply: Result<String, String>,
    calls: Mutex<Vec<SideCall>>,
}

impl FakeHost {
    fn new() -> Self {
        Self {
            enabled: true,
            prefs: Mutex::new(HashMap::new()),
            pref_set_error: None,
            agent_models: HashMap::new(),
            reply: Ok("world".to_string()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn with_config(self, config: &PredictConfig) -> Self {
        self.prefs.lock().unwrap().insert(
            PREDICT_CONFIG_PREF.to_string(),
            serde_json::to_string(config).unwrap(),
        );
        self
    }

    fn calls(&self) -> Vec<SideCall> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl PredictHost for FakeHost {
    fn is_enabled(&self) -> bool {
        self.enabled
    }
    async fn pref_get(&self, key: &str) -> Option<String> {
        self.prefs.lock().unwrap().get(key).cloned()
    }
    async fn pref_set(&self, key: &str, value: &str) -> Result<(), String> {
        if let Some(e) = &self.pref_set_error {
            return Err(e.clone());
        }
        self.prefs
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }
    async fn agent_bound_model(&self, agent_id: &str) -> Option<String> {
        self.agent_models.get(agent_id).cloned()
    }
    fn default_model(&self) -> String {
        "default-model".to_string()
    }
    async fn call_side_model(
        &self,
        model: &str,
        effort: &str,
        _system: &str,
        user: &str,
    ) -> Result<String, String> {
        self.calls.lock().unwrap().push(SideCall {
            model: model.to_string(),
            effort: effort.to_string(),
            user: user.to_string(),
        });
        self.reply.clone()
    }
}

fn ctx_of(host: &Arc<FakeHost>) -> PredictCtx {
    PredictCtx::new(host.clone() as Arc<dyn PredictHost>)
}

fn body(
    context: &str,
    app: Option<&str>,
    control: Option<&str>,
    agent: Option<&str>,
) -> CompleteBody {
    CompleteBody {
        context: context.to_string(),
        app: app.map(str::to_string),
        control: control.map(str::to_string),
        agent_id: agent.map(str::to_string),
    }
}

async fn run_complete(host: &Arc<FakeHost>, b: CompleteBody) -> (StatusCode, Value) {
    let resp = complete(State(ctx_of(host)), Json(b)).await;
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn assert_refused(host: FakeHost, b: CompleteBody, reason: &str) {
    let host = Arc::new(host);
    let (status, json) = run_complete(&host, b).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["reason"], reason);
    assert_eq!(json["suggestion"], "");
    assert!(
        host.calls().is_empty(),
        "refused request must not reach the model"
    );
}

#[tokio::test]
async fn disabled_plugin_refuses_without_calling_model() {
    let mut host = FakeHost::new();
    host.enabled = false;
    let b = body("hello", Some("notepad.exe"), Some("edit"), None);
    assert_refused(host, b, "predictive typing plugin is disabled").await;
}

#[tokio::test]
async fn secure_control_refuses_without_calling_model() {
    for control in ["Password", "secure text field", "OTP"] {
        let b = body("hunter", Some("notepad.exe"), Some(control), None);
        assert_refused(FakeHost::new(), b, "secure field").await;
    }
}

#[tokio::test]
async fn app_outside_allowlist_refuses_without_calling_model() {
    let cfg = PredictConfig {
        app_allowlist: vec!["notepad.exe".to_string()],
        ..PredictConfig::default()
    };
    let b = body("hello", Some("C:\\Apps\\code.exe"), Some("edit"), None);
    assert_refused(FakeHost::new().with_config(&cfg), b, "app not in allowlist").await;

    // The same allowlist admits the listed app and the model is called.
    let host = Arc::new(FakeHost::new().with_config(&cfg));
    let (status, json) = run_complete(&host, body("hello", Some("NOTEPAD.EXE"), None, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["suggestion"], "world");
    assert_eq!(host.calls().len(), 1);
}

#[tokio::test]
async fn blank_context_refuses_without_calling_model() {
    assert_refused(
        FakeHost::new(),
        body("  \n\t ", None, None, None),
        "no context",
    )
    .await;
}

#[tokio::test]
async fn body_agent_wins_over_config_agent_and_config_model() {
    let cfg = PredictConfig {
        model: "config-model".to_string(),
        effort: " low ".to_string(),
        agent_id: Some("config-agent".to_string()),
        ..PredictConfig::default()
    };
    let mut host = FakeHost::new().with_config(&cfg);
    host.agent_models
        .insert("body-agent".to_string(), "body-agent-model".to_string());
    host.agent_models
        .insert("config-agent".to_string(), "config-agent-model".to_string());
    let host = Arc::new(host);

    let (_, json) = run_complete(&host, body(" hi there ", None, None, Some("body-agent"))).await;
    assert_eq!(json["model"], "body-agent-model");
    let (_, json) = run_complete(&host, body("hi", None, None, None)).await;
    assert_eq!(json["model"], "config-agent-model");

    let calls = host.calls();
    assert_eq!(calls[0].model, "body-agent-model");
    assert_eq!(calls[1].model, "config-agent-model");
    assert_eq!(
        calls[0].effort, "low",
        "effort is trimmed before forwarding"
    );
    assert!(
        calls[0].user.contains("\nhi there\n"),
        "context is trimmed: {}",
        calls[0].user
    );
}

#[tokio::test]
async fn unknown_agent_falls_back_to_config_model_then_default() {
    let cfg = PredictConfig {
        model: "config-model".to_string(),
        agent_id: Some("ghost".to_string()),
        ..PredictConfig::default()
    };
    let host = Arc::new(FakeHost::new().with_config(&cfg));
    let (_, json) = run_complete(&host, body("hi", None, None, None)).await;
    assert_eq!(json["model"], "config-model");

    // No agent, no configured model: env override if present, else the host default.
    let host = Arc::new(FakeHost::new());
    let (_, json) = run_complete(&host, body("hi", None, None, None)).await;
    let env_model = ["RYU_PREDICT_MODEL", "RYU_DEFAULT_LLM_MODEL"]
        .iter()
        .find_map(|v| std::env::var(v).ok().filter(|s| !s.is_empty()));
    assert_eq!(
        json["model"],
        env_model.unwrap_or_else(|| "default-model".to_string())
    );
}

#[tokio::test]
async fn side_model_error_maps_to_bad_gateway() {
    let mut host = FakeHost::new();
    host.reply = Err("upstream down".to_string());
    let host = Arc::new(host);
    let (status, json) = run_complete(&host, body("hi", None, None, None)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(json["error"].as_str().unwrap().contains("upstream down"));
    assert_eq!(host.calls().len(), 1);
}

#[tokio::test]
async fn reply_is_cleaned_and_capped_by_config_max_chars() {
    let cfg = PredictConfig {
        max_chars: 5,
        ..PredictConfig::default()
    };
    let mut host = FakeHost::new().with_config(&cfg);
    host.reply = Ok("\"abcdefghij\nsecond line\"".to_string());
    let host = Arc::new(host);
    let (status, json) = run_complete(&host, body("hi", None, None, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["suggestion"], "abcde");
    assert!(json.get("reason").is_none());

    let mut host = FakeHost::new();
    host.reply = Ok("0".to_string());
    let (_, json) = run_complete(&Arc::new(host), body("hi", None, None, None)).await;
    assert_eq!(json["suggestion"], "", "the 0 sentinel means no suggestion");
}

#[tokio::test]
async fn put_config_persists_and_takes_effect() {
    let host = Arc::new(FakeHost::new());
    let cfg = PredictConfig {
        model: "saved-model".to_string(),
        app_allowlist: vec!["notepad.exe".to_string()],
        max_chars: 3,
        ..PredictConfig::default()
    };
    let resp = put_config(State(ctx_of(&host)), Json(cfg.clone())).await;
    assert_eq!(resp.status(), StatusCode::OK);

    let Json(read_back) = get_config(State(ctx_of(&host))).await;
    assert_eq!(read_back, cfg);

    // The saved allowlist and model now govern /complete.
    let (_, json) = run_complete(&host, body("hi", Some("code.exe"), None, None)).await;
    assert_eq!(json["reason"], "app not in allowlist");
    let (_, json) = run_complete(&host, body("hi", Some("notepad.exe"), None, None)).await;
    assert_eq!(json["model"], "saved-model");
    assert_eq!(json["suggestion"], "wor");
}

#[tokio::test]
async fn put_config_pref_failure_is_500_and_not_persisted() {
    let mut host = FakeHost::new();
    host.pref_set_error = Some("disk full".to_string());
    let host = Arc::new(host);
    let cfg = PredictConfig {
        model: "never-saved".to_string(),
        ..PredictConfig::default()
    };
    let resp = put_config(State(ctx_of(&host)), Json(cfg)).await;
    assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(json["error"].as_str().unwrap().contains("disk full"));

    let Json(read_back) = get_config(State(ctx_of(&host))).await;
    assert_eq!(read_back, PredictConfig::default());
}

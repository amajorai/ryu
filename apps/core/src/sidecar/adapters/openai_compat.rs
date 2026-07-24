use crate::sidecar::adapters::{
    AgentAdapter, AgentConfig, AgentInfo, ChatChunk, ChatRequest, MemoryEntry, ToolInfo,
};
use crate::sidecar::BoxFuture;

pub struct OpenAiCompatAdapter {
    pub name: &'static str,
    pub base_url: &'static str,
    pub model_override: Option<&'static str>,
}

impl AgentAdapter for OpenAiCompatAdapter {
    fn name(&self) -> &'static str {
        self.name
    }

    fn is_available(&self) -> bool {
        true
    }

    fn send_message(
        &self,
        _agent_id: &str,
        req: ChatRequest,
    ) -> BoxFuture<anyhow::Result<Vec<ChatChunk>>> {
        let base_url = self.base_url;
        let model = self.model_override.unwrap_or("default");
        Box::pin(async move {
            let payload = serde_json::json!({
                "model": model,
                "stream": false,
                "messages": [{"role": "user", "content": req.message}],
            });
            static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
            let client = HTTP_CLIENT.get_or_init(reqwest::Client::new);
            let resp = client
                .post(format!("{base_url}/v1/chat/completions"))
                .json(&payload)
                .send()
                .await
                .map_err(|e| anyhow::anyhow!("request error: {e}"))?;
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| anyhow::anyhow!("response error: {e}"))?;
            let text = json
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_owned();
            Ok(vec![ChatChunk {
                delta: Some(text),
                done: true,
                metadata: None,
            }])
        })
    }

    fn list_agents(&self) -> BoxFuture<anyhow::Result<Vec<AgentInfo>>> {
        let id = self.name;
        let name = self.name;
        let model = self.model_override.map(str::to_owned);
        Box::pin(async move {
            Ok(vec![AgentInfo {
                id: id.to_owned(),
                name: name.to_owned(),
                description: None,
                install_hint: None,
                installed: None,
                model,
                system_prompt: None,
                created_at: None,
                engine: Some(id.to_owned()),
                transport: Some("openai_compat".into()),
                recommended: None,
                version: None,
                latest_version: None,
                version_status: None,
                locked: None,
                enabled: None,
                gateway_bypass: None,
                avatar_url: None,
            }])
        })
    }

    fn create_agent(&self, config: AgentConfig) -> BoxFuture<anyhow::Result<AgentInfo>> {
        Box::pin(async move {
            Ok(AgentInfo {
                id: config.name.clone(),
                name: config.name,
                description: None,
                install_hint: None,
                installed: None,
                model: config.model,
                system_prompt: config.system_prompt,
                created_at: None,
                engine: None,
                transport: Some("openai_compat".into()),
                recommended: None,
                version: None,
                latest_version: None,
                version_status: None,
                locked: None,
                enabled: None,
                gateway_bypass: None,
                avatar_url: None,
            })
        })
    }

    fn get_memory(
        &self,
        _agent_id: &str,
        _query: String,
    ) -> BoxFuture<anyhow::Result<Vec<MemoryEntry>>> {
        Box::pin(async move { Ok(vec![]) })
    }

    fn list_tools(&self, _agent_id: &str) -> BoxFuture<anyhow::Result<Vec<ToolInfo>>> {
        Box::pin(async move { Ok(vec![]) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(base_url: &'static str) -> OpenAiCompatAdapter {
        OpenAiCompatAdapter {
            name: "test-compat",
            base_url,
            model_override: Some("test-model"),
        }
    }

    #[test]
    fn name_and_availability() {
        let a = adapter("http://127.0.0.1:9");
        assert_eq!(a.name(), "test-compat");
        // OpenAI-compat adapters are always "available" — reachability is proven
        // at request time, not by this flag.
        assert!(a.is_available());
    }

    #[tokio::test]
    async fn list_agents_reports_transport_and_engine() {
        let a = adapter("http://127.0.0.1:9");
        let agents = a.list_agents().await.expect("list_agents");
        assert_eq!(agents.len(), 1);
        let info = &agents[0];
        assert_eq!(info.id, "test-compat");
        assert_eq!(info.name, "test-compat");
        assert_eq!(info.model.as_deref(), Some("test-model"));
        assert_eq!(info.engine.as_deref(), Some("test-compat"));
        assert_eq!(info.transport.as_deref(), Some("openai_compat"));
    }

    #[tokio::test]
    async fn list_agents_without_model_override_reports_no_model() {
        let a = OpenAiCompatAdapter {
            name: "bare",
            base_url: "http://127.0.0.1:9",
            model_override: None,
        };
        let agents = a.list_agents().await.expect("list_agents");
        assert!(agents[0].model.is_none());
    }

    #[tokio::test]
    async fn create_agent_maps_config_fields() {
        let a = adapter("http://127.0.0.1:9");
        let cfg = AgentConfig {
            name: "my-agent".to_owned(),
            model: Some("gpt-x".to_owned()),
            system_prompt: Some("be terse".to_owned()),
            tools: vec![],
        };
        let info = a.create_agent(cfg).await.expect("create_agent");
        assert_eq!(info.id, "my-agent");
        assert_eq!(info.name, "my-agent");
        assert_eq!(info.model.as_deref(), Some("gpt-x"));
        assert_eq!(info.system_prompt.as_deref(), Some("be terse"));
        assert_eq!(info.transport.as_deref(), Some("openai_compat"));
    }

    #[tokio::test]
    async fn get_memory_and_list_tools_are_empty() {
        let a = adapter("http://127.0.0.1:9");
        assert!(a.get_memory("id", "q".to_owned()).await.unwrap().is_empty());
        assert!(a.list_tools("id").await.unwrap().is_empty());
    }

    /// Spawn a loopback OpenAI-compat server that replies to `/v1/chat/completions`
    /// with `body`. Returns the leaked `&'static str` base URL and a shutdown guard.
    async fn spawn_stub(
        body: serde_json::Value,
    ) -> (&'static str, tokio::sync::oneshot::Sender<()>) {
        use axum::routing::post;
        use axum::{Json, Router};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral loopback");
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let body = body.clone();
                async move { Json(body) }
            }),
        );
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await
                .expect("stub server runs");
        });
        let base: &'static str = Box::leak(format!("http://127.0.0.1:{port}").into_boxed_str());
        (base, tx)
    }

    #[tokio::test]
    async fn send_message_extracts_assistant_content() {
        let (base, _shutdown) = spawn_stub(serde_json::json!({
            "choices": [{ "message": { "role": "assistant", "content": "pong" } }]
        }))
        .await;
        let a = adapter(base);
        let chunks = a
            .send_message(
                "test-compat",
                ChatRequest {
                    message: "ping".to_owned(),
                    context: None,
                    conversation_id: None,
                },
            )
            .await
            .expect("send_message");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].delta.as_deref(), Some("pong"));
        assert!(chunks[0].done);
    }

    #[tokio::test]
    async fn send_message_missing_content_yields_empty_delta() {
        // A malformed/empty completion (no choices) must not panic — it collapses
        // to an empty delta, still marked done.
        let (base, _shutdown) = spawn_stub(serde_json::json!({ "choices": [] })).await;
        let a = adapter(base);
        let chunks = a
            .send_message(
                "test-compat",
                ChatRequest {
                    message: "hi".to_owned(),
                    context: None,
                    conversation_id: None,
                },
            )
            .await
            .expect("send_message");
        assert_eq!(chunks[0].delta.as_deref(), Some(""));
        assert!(chunks[0].done);
    }

    #[tokio::test]
    async fn send_message_errors_when_endpoint_unreachable() {
        // Nothing is listening on this port → the request errors (not a panic).
        let a = adapter("http://127.0.0.1:1");
        let result = a
            .send_message(
                "test-compat",
                ChatRequest {
                    message: "hi".to_owned(),
                    context: None,
                    conversation_id: None,
                },
            )
            .await;
        assert!(result.is_err(), "unreachable endpoint must surface an error");
    }
}

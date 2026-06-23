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
                locked: None,
                enabled: None,
                gateway_bypass: None,
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
                locked: None,
                enabled: None,
                gateway_bypass: None,
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

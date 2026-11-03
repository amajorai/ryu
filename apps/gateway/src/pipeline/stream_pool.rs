//! Provider-pool wrappers around a streamed response body.

use super::*;

pub(super) fn hold_pool_load_until_stream_end(
    body: Body,
    lease: Option<ryu_gw_router::pool::PoolLease>,
) -> Body {
    hold_until_stream_end(body, lease)
}

pub(super) fn bound_pool_stream(body: Body, deadline: tokio::time::Instant, limit: usize) -> Body {
    use futures_util::StreamExt;
    let stream = async_stream::stream! {
        let mut source = body.into_data_stream();
        let mut received = 0usize;
        loop {
            match tokio::time::timeout_at(deadline,source.next()).await {
                Ok(Some(Ok(bytes))) => {
                    received = received.saturating_add(bytes.len());
                    if received > limit {
                        yield Err(std::io::Error::other("Pool stream output limit reached"));
                        break;
                    }
                    yield Ok(bytes);
                }
                Ok(Some(Err(error))) => { yield Err(std::io::Error::other(error.to_string())); break; }
                Ok(None) => break,
                Err(_) => { yield Err(std::io::Error::other("Pool stream deadline reached")); break; }
            }
        }
    };
    Body::from_stream(stream)
}

pub(super) fn capture_pool_relay_stream(
    body: Body,
    state: Arc<AppState>,
    ctx: RequestContext,
    route: crate::provider_pools::SelectedPoolRoute,
    request: Value,
) -> Body {
    use futures_util::StreamExt;
    let stream = async_stream::stream! {
        let mut source=body.into_data_stream();
        let mut captured=Vec::new();
        let mut valid=true;
        while let Some(chunk)=source.next().await {
            if let Ok(bytes)=&chunk {
                if valid && captured.len().saturating_add(bytes.len())<=262_144 { captured.extend_from_slice(bytes); }
                else { valid=false;captured.clear(); }
            } else { valid=false; }
            yield chunk;
        }
        if valid {
            if let Ok(text)=std::str::from_utf8(&captured) {
                let mut answer=String::new();let mut done=false;let mut failed=false;
                for line in text.lines().filter_map(|line|line.strip_prefix("data:").map(str::trim)) {
                    if line=="[DONE]" { done=true;continue; }
                    if let Ok(value)=serde_json::from_str::<Value>(line) {
                        failed|=value.get("error").is_some();
                        if let Some(content)=value.pointer("/choices/0/delta/content").and_then(Value::as_str) { answer.push_str(content); }
                    }
                }
                if done && !failed && answer.len()<=16_384 {
                    if let Some(session)=account_affinity(&ctx,&request) {
                        let scoped=format!("{}:{}",auxiliary::scope(&state,&ctx),session);
                        let user=request["messages"].as_array().and_then(|messages|messages.iter().rev().find(|message|message["role"]=="user")).and_then(|message|message["content"].as_str()).unwrap_or_default();
                        provider_snapshot(&state,&ctx).provider_pools.record_relay(&route,&scoped,&json!({"choices":[{"message":{"role":"assistant","content":answer}}]}),user);
                    }
                }
            }
        }
    };
    Body::from_stream(stream)
}

#[cfg(test)]
#[path = "pool_stream_tests.rs"]
mod pool_stream_tests;

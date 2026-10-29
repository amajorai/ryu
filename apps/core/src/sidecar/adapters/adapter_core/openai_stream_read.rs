use super::*;

use crate::routing_policy::reactive::TurnWatch;

/// Turn-wide, read-only inputs to one upstream SSE read loop.
#[derive(Clone, Copy)]
pub(crate) struct OpenAiReadCtx<'a> {
    pub(crate) stream_hop: StreamHop,
    pub(crate) failure_sink: OpenAiFailureSink<'a>,
    pub(crate) turn_registration: Option<&'a turn_control::TurnRegistration>,
    pub(crate) watch: &'a TurnWatch,
    pub(crate) checkpoint: Option<&'a ReplyCheckpoint>,
    pub(crate) text_id: &'a str,
}

/// Mutable turn state the read loop updates (and settles on a stream failure).
pub(crate) struct OpenAiReadState<'a, F> {
    pub(crate) st: &'a mut OpenAiIterState,
    pub(crate) buf: &'a mut String,
    pub(crate) saw_done: &'a mut bool,
    pub(crate) model_span_id: &'a mut Option<String>,
    pub(crate) run_finisher: &'a mut Option<ryu_tracing::ScopeGuard>,
    pub(crate) persist: &'a mut Option<F>,
    pub(crate) reply_all: &'a mut String,
    /// Set when a read error ended the turn; the caller then returns.
    pub(crate) failed: &'a mut bool,
}

/// Drain the upstream SSE body into the iteration state, yielding its UI frames.
pub(crate) fn openai_read_upstream_frames<'a, S, B, F, Fut>(
    mut byte_stream: std::pin::Pin<&'a mut S>,
    ctx: OpenAiReadCtx<'a>,
    state: OpenAiReadState<'a, F>,
) -> impl futures_util::Stream<Item = Vec<u8>> + 'a
where
    S: futures_util::Stream<Item = Result<B, reqwest::Error>> + 'a,
    B: std::ops::Deref<Target = [u8]> + 'a,
    F: FnOnce(String, &'static str, Vec<Value>) -> Fut + 'a,
    Fut: std::future::Future<Output = Option<String>> + 'a,
{
    let OpenAiReadState {
        st,
        buf,
        saw_done,
        model_span_id,
        run_finisher,
        persist,
        reply_all,
        failed,
    } = state;
    async_stream::stream! {
        while let Some(chunk) = byte_stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    let detail = openai_record_stream_failure(
                        &e,
                        ctx.stream_hop,
                        ctx.failure_sink,
                        model_span_id,
                        run_finisher,
                        persist,
                        reply_all,
                        &st.iter_reply,
                    )
                    .await;
                    if st.text_open {
                        yield ui_text_end(ctx.text_id);
                    }
                    for line in error_ui_lines(&detail) {
                        yield line;
                    }
                    *failed = true;
                    return;
                }
            };

            buf.push_str(&String::from_utf8_lossy(&chunk));

            let mut start = 0;
            while let Some(rel) = buf[start..].find("\n\n") {
                let pos = start + rel;
                let data_owned = buf[start..pos]
                    .strip_prefix("data:")
                    .map(|s| s.trim().to_owned());
                start = pos + 2;

                let Some(data) = data_owned else { continue };

                if data == "[DONE]" {
                    *saw_done = true;
                    break;
                }

                if let Ok(json) = serde_json::from_str::<Value>(&data) {
                    let frames = openai_sse_event_frames(
                        &json,
                        st,
                        ctx.turn_registration,
                        ctx.watch,
                        ctx.checkpoint,
                        reply_all,
                        ctx.text_id,
                    );
                    tokio::pin!(frames);
                    while let Some(frame) = frames.next().await {
                        yield frame;
                    }
                }
            }
            buf.drain(..start);
            if *saw_done {
                break;
            }
            }
    }
}

//! Forward a provider body on line boundaries only. A stage that may end the
//! stream between two chunks (the standing guard's mid-stream refusal) then
//! never leaves a half-sent SSE line for its own frame to be glued onto,
//! which the outbound DLP would reject as unscannable.

use axum::body::Body;
use futures_util::StreamExt;

/// The longest partial line held back: the outbound DLP's own limit
/// (`stream_dlp::MAX_HELD_BYTES`). A longer one is forwarded as it is, so the
/// DLP refuses it as oversized instead of this stage holding it unbounded.
const MAX_TAIL: usize = 8 * 1024 * 1024;

/// `body` re-chunked so each chunk ends with `\n`. A partial tail waits for
/// the next chunk and is flushed when the body ends, ahead of an error.
pub(super) fn line_aligned(body: Body) -> Body {
    struct Aligned {
        inner: axum::body::BodyDataStream,
        tail: Vec<u8>,
        /// An upstream error, sent right after the flushed tail.
        pending: Option<axum::Error>,
        done: bool,
    }
    let init = Aligned {
        inner: body.into_data_stream(),
        tail: Vec::new(),
        pending: None,
        done: false,
    };
    let stream = futures_util::stream::unfold(init, |mut state| async move {
        if let Some(error) = state.pending.take() {
            state.done = true;
            return Some((Err(error), state));
        }
        loop {
            if state.done {
                return None;
            }
            match state.inner.next().await {
                Some(Ok(chunk)) => {
                    // Only the new bytes can hold the last newline.
                    let base = state.tail.len();
                    state.tail.extend_from_slice(&chunk);
                    let last = chunk
                        .iter()
                        .rposition(|byte| *byte == b'\n')
                        .map(|index| base + index);
                    let Some(last) = last else {
                        if state.tail.len() > MAX_TAIL {
                            let ready = std::mem::take(&mut state.tail);
                            return Some((Ok(bytes::Bytes::from(ready)), state));
                        }
                        continue;
                    };
                    let rest = state.tail.split_off(last + 1);
                    let ready = std::mem::replace(&mut state.tail, rest);
                    return Some((Ok(bytes::Bytes::from(ready)), state));
                }
                Some(Err(error)) => {
                    if state.tail.is_empty() {
                        state.done = true;
                        return Some((Err(error), state));
                    }
                    state.pending = Some(error);
                    let tail = std::mem::take(&mut state.tail);
                    return Some((Ok(bytes::Bytes::from(tail)), state));
                }
                None => {
                    state.done = true;
                    if state.tail.is_empty() {
                        return None;
                    }
                    let tail = std::mem::take(&mut state.tail);
                    return Some((Ok(bytes::Bytes::from(tail)), state));
                }
            }
        }
    });
    Body::from_stream(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn chunks(parts: Vec<&'static str>) -> Vec<String> {
        let body = Body::from_stream(futures_util::stream::iter(
            parts
                .into_iter()
                .map(|part| Ok::<_, std::io::Error>(bytes::Bytes::from(part))),
        ));
        let mut out = Vec::new();
        let mut stream = line_aligned(body).into_data_stream();
        while let Some(chunk) = stream.next().await {
            out.push(String::from_utf8(chunk.unwrap().to_vec()).unwrap());
        }
        out
    }

    #[tokio::test]
    async fn an_error_mid_line_flushes_the_tail_then_ends() {
        let body = Body::from_stream(futures_util::stream::iter([
            Ok(bytes::Bytes::from_static(b"data: {\"a\"")),
            Err(std::io::Error::other("reset")),
        ]));
        let mut stream = line_aligned(body).into_data_stream();
        let first = stream.next().await.unwrap().unwrap();
        assert_eq!(&first[..], b"data: {\"a\"");
        assert!(stream.next().await.unwrap().is_err());
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn a_line_longer_than_the_cap_is_forwarded() {
        let big = "a".repeat(MAX_TAIL / 4 + 1);
        let body = Body::from_stream(futures_util::stream::iter(
            (0..4).map(move |_| Ok::<_, std::io::Error>(bytes::Bytes::from(big.clone()))),
        ));
        let mut stream = line_aligned(body).into_data_stream();
        let first = stream.next().await.unwrap().unwrap();
        assert!(first.len() > MAX_TAIL);
    }

    #[tokio::test]
    async fn chunks_end_on_line_boundaries_and_the_tail_is_flushed() {
        let out = chunks(vec![
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel",
            "lo\"}}]}\n\ndata: {\"a\"",
            ":1}\n\n",
            "data: [DONE]",
        ])
        .await;
        assert_eq!(
            out,
            vec![
                "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
                "data: {\"a\":1}\n\n",
                "data: [DONE]",
            ]
        );
    }
}

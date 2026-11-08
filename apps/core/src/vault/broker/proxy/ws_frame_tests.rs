//! Frame codec and relay tests over in-memory pipes.

use futures_util::future::BoxFuture;
use tokio::io::AsyncReadExt as _;

use super::*;

/// Replaces `__KEY__` with `value`; refuses messages containing `__DENY__`.
struct Swap;

impl TextRewriter for Swap {
    fn rewrite<'a>(&'a mut self, text: &'a str) -> BoxFuture<'a, Result<Option<String>, ()>> {
        Box::pin(async move {
            if text.contains("__DENY__") {
                return Err(());
            }
            Ok(text
                .contains("__KEY__")
                .then(|| text.replace("__KEY__", "value")))
        })
    }
}

fn frame(fin: bool, opcode: u8, payload: &[u8], mask: Option<[u8; 4]>) -> Vec<u8> {
    let header = Header {
        fin,
        opcode,
        mask,
        len: payload.len() as u64,
    };
    let mut bytes = header.encode();
    let start = bytes.len();
    bytes.extend_from_slice(payload);
    if let Some(mask) = mask {
        apply_mask(&mut bytes[start..], mask);
    }
    bytes
}

/// Decode every frame in `bytes` (sent by `from`) to `(fin, opcode, payload)`.
async fn decode_all(bytes: Vec<u8>, from: Sender) -> Vec<(bool, u8, Vec<u8>)> {
    let mut reader = std::io::Cursor::new(bytes);
    let mut frames = Vec::new();
    while let Some(header) = read_header(&mut reader, from).await.unwrap() {
        let payload = read_payload(&mut reader, &header).await.unwrap();
        frames.push((header.fin, header.opcode, payload));
    }
    frames
}

async fn relay(input: Vec<u8>, from: Sender, max: usize) -> (Result<(), PumpError>, Vec<u8>) {
    let mut reader = std::io::Cursor::new(input);
    let (mut write, mut read) = tokio::io::duplex(1 << 22);
    let result = pump(&mut reader, &mut write, from, &mut Swap, max).await;
    drop(write);
    let mut out = Vec::new();
    read.read_to_end(&mut out).await.unwrap();
    (result, out)
}

const MASK: Option<[u8; 4]> = Some([1, 2, 3, 4]);

#[tokio::test]
async fn headers_round_trip_every_length_form() {
    for len in [0u64, 125, 126, 65_535, 65_536] {
        for mask in [None, MASK] {
            let header = Header {
                fin: true,
                opcode: OP_BINARY,
                mask,
                len,
            };
            let from = if mask.is_some() {
                Sender::Client
            } else {
                Sender::Server
            };
            let mut reader = std::io::Cursor::new(header.encode());
            assert_eq!(read_header(&mut reader, from).await.unwrap(), Some(header));
        }
    }
}

#[tokio::test]
async fn client_text_is_rewritten_and_remasked() {
    let input = frame(true, OP_TEXT, b"auth __KEY__", MASK);
    let (result, out) = relay(input, Sender::Client, 1024).await;
    result.unwrap();
    // Re-encoded client frames are masked again, so the value is not
    // visible on the wire as plain bytes.
    assert!(!out.windows(5).any(|w| w == b"value"));
    let frames = decode_all(out, Sender::Client).await;
    assert_eq!(frames, vec![(true, OP_TEXT, b"auth value".to_vec())]);
}

#[tokio::test]
async fn fragmented_text_is_reassembled_and_control_frames_pass() {
    let mut input = frame(false, OP_TEXT, b"auth __K", MASK);
    input.extend(frame(true, 0x9, b"ping", MASK));
    input.extend(frame(true, OP_CONTINUATION, b"EY__!", MASK));
    input.extend(frame(true, OP_BINARY, b"__KEY__", MASK));
    let (result, out) = relay(input, Sender::Client, 1024).await;
    result.unwrap();
    let frames = decode_all(out, Sender::Client).await;
    assert_eq!(
        frames,
        vec![
            (true, 0x9, b"ping".to_vec()),
            (true, OP_TEXT, b"auth value!".to_vec()),
            // Binary messages are never rewritten.
            (true, OP_BINARY, b"__KEY__".to_vec()),
        ]
    );
}

#[tokio::test]
async fn oversized_text_is_copied_unchanged() {
    let mut input = frame(false, OP_TEXT, b"__KEY__ ", None);
    input.extend(frame(true, OP_CONTINUATION, &[b'a'; 32], None));
    input.extend(frame(true, OP_TEXT, &[b'b'; 40], None));
    let (result, out) = relay(input, Sender::Server, 16).await;
    result.unwrap();
    let frames = decode_all(out, Sender::Server).await;
    assert_eq!(
        frames,
        vec![
            (false, OP_TEXT, b"__KEY__ ".to_vec()),
            (true, OP_CONTINUATION, vec![b'a'; 32]),
            (true, OP_TEXT, vec![b'b'; 40]),
        ]
    );
}

#[tokio::test]
async fn protocol_violations_and_refusals_stop_the_relay() {
    let cases: Vec<(Vec<u8>, Sender)> = vec![
        // RSV1 (permessage-deflate) was never negotiated.
        (vec![0xc1, 0x80, 0, 0, 0, 0], Sender::Client),
        // Client frames must be masked; server frames must not be.
        (frame(true, OP_TEXT, b"x", None), Sender::Client),
        (frame(true, OP_TEXT, b"x", MASK), Sender::Server),
        // Reserved opcode, fragmented control frame, orphan continuation.
        (frame(true, 0x3, b"x", None), Sender::Server),
        (frame(false, 0x9, b"x", None), Sender::Server),
        (frame(true, OP_CONTINUATION, b"x", None), Sender::Server),
    ];
    for (input, from) in cases {
        let (result, _) = relay(input, from, 1024).await;
        assert!(matches!(result, Err(PumpError::Protocol(_))), "{result:?}");
    }
    let mut interleaved = frame(false, OP_TEXT, b"a", None);
    interleaved.extend(frame(true, OP_TEXT, b"b", None));
    let (result, _) = relay(interleaved, Sender::Server, 1024).await;
    assert!(matches!(result, Err(PumpError::Protocol(_))));

    let (result, out) = relay(
        frame(true, OP_TEXT, b"__DENY__", MASK),
        Sender::Client,
        1024,
    )
    .await;
    assert!(matches!(result, Err(PumpError::Refused)));
    assert!(out.is_empty(), "a refused message is never forwarded");
}

#[tokio::test]
async fn close_frames_carry_the_code_and_a_bounded_reason() {
    let mut out = Vec::new();
    write_close(
        &mut out,
        Sender::Server,
        CLOSE_POLICY_VIOLATION,
        &"r".repeat(300),
    )
    .await
    .unwrap();
    let frames = decode_all(out, Sender::Server).await;
    assert_eq!(frames.len(), 1);
    let (fin, opcode, payload) = &frames[0];
    assert!(*fin);
    assert_eq!(*opcode, OP_CLOSE);
    assert_eq!(payload.len(), 125);
    assert_eq!(&payload[..2], &1008u16.to_be_bytes());
}

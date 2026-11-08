//! WebSocket frames (RFC 6455) relayed through a brokered upgrade.
//!
//! [`pump`] copies frames from one side to the other. Text messages up to a
//! size limit (fragmented ones reassembled) go through a [`TextRewriter`]
//! and leave as one frame; binary messages, control frames, and larger text
//! messages are copied unchanged without buffering. Extensions are never
//! negotiated on a rewritten connection, so a frame with an RSV bit set, an
//! unknown opcode, or the wrong masking for its direction ends the relay.

use futures_util::future::BoxFuture;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};

pub(super) const OP_CONTINUATION: u8 = 0x0;
pub(super) const OP_TEXT: u8 = 0x1;
pub(super) const OP_BINARY: u8 = 0x2;
pub(super) const OP_CLOSE: u8 = 0x8;
/// Close code for a message the broker refused (RFC 6455 section 7.4.1).
pub(super) const CLOSE_POLICY_VIOLATION: u16 = 1008;
const MAX_CONTROL_PAYLOAD: u64 = 125;

/// One frame header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Header {
    pub fin: bool,
    pub opcode: u8,
    pub mask: Option<[u8; 4]>,
    pub len: u64,
}

impl Header {
    fn is_control(&self) -> bool {
        self.opcode & 0x8 != 0
    }

    /// The encoded header (RSV bits are always zero).
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(14);
        out.push(if self.fin { 0x80 } else { 0 } | (self.opcode & 0x0f));
        let mask_bit = if self.mask.is_some() { 0x80 } else { 0 };
        match self.len {
            len @ 0..=125 => out.push(mask_bit | len as u8),
            len @ 126..=0xffff => {
                out.push(mask_bit | 126);
                out.extend_from_slice(&(len as u16).to_be_bytes());
            }
            len => {
                out.push(mask_bit | 127);
                out.extend_from_slice(&len.to_be_bytes());
            }
        }
        if let Some(mask) = self.mask {
            out.extend_from_slice(&mask);
        }
        out
    }
}

/// Which peer the frames come from: client frames are masked, server
/// frames are not, and re-encoded frames keep that rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Sender {
    Client,
    Server,
}

/// Why a relay direction stopped early.
#[derive(Debug)]
pub(super) enum PumpError {
    Io(std::io::Error),
    Protocol(&'static str),
    /// The rewriter refused a message (a credential could not be resolved).
    Refused,
}

impl From<std::io::Error> for PumpError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Rewrites whole text messages; `Ok(None)` keeps the message unchanged.
pub(super) trait TextRewriter: Send {
    fn rewrite<'a>(&'a mut self, text: &'a str) -> BoxFuture<'a, Result<Option<String>, ()>>;
}

/// XOR `payload` with `mask` (masking and unmasking are the same).
pub(super) fn apply_mask(payload: &mut [u8], mask: [u8; 4]) {
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }
}

/// Read one header, or `None` on a clean end of stream between frames.
pub(super) async fn read_header<R: AsyncRead + Unpin>(
    reader: &mut R,
    from: Sender,
) -> Result<Option<Header>, PumpError> {
    let first = match reader.read_u8().await {
        Ok(byte) => byte,
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let second = reader.read_u8().await?;
    if first & 0x70 != 0 {
        return Err(PumpError::Protocol(
            "reserved bits set without an extension",
        ));
    }
    let header_len = match second & 0x7f {
        126 => u64::from(reader.read_u16().await?),
        127 => {
            let len = reader.read_u64().await?;
            if len >> 63 != 0 {
                return Err(PumpError::Protocol("frame length out of range"));
            }
            len
        }
        len => u64::from(len),
    };
    let mask = if second & 0x80 != 0 {
        let mut key = [0u8; 4];
        reader.read_exact(&mut key).await?;
        Some(key)
    } else {
        None
    };
    if mask.is_some() != (from == Sender::Client) {
        return Err(PumpError::Protocol(
            "frame masking does not match its direction",
        ));
    }
    let header = Header {
        fin: first & 0x80 != 0,
        opcode: first & 0x0f,
        mask,
        len: header_len,
    };
    match header.opcode {
        OP_CONTINUATION | OP_TEXT | OP_BINARY => {}
        0x8..=0xa if header.fin && header.len <= MAX_CONTROL_PAYLOAD => {}
        0x8..=0xa => return Err(PumpError::Protocol("invalid control frame")),
        _ => return Err(PumpError::Protocol("unknown opcode")),
    }
    Ok(Some(header))
}

/// Read a payload of `header.len` bytes and unmask it.
async fn read_payload<R: AsyncRead + Unpin>(
    reader: &mut R,
    header: &Header,
) -> Result<Vec<u8>, PumpError> {
    let len = usize::try_from(header.len).map_err(|_| PumpError::Protocol("frame too large"))?;
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).await?;
    if let Some(mask) = header.mask {
        apply_mask(&mut payload, mask);
    }
    Ok(payload)
}

/// Copy a frame unchanged: its header, then exactly its payload bytes.
async fn copy_frame<R, W>(reader: &mut R, writer: &mut W, header: &Header) -> Result<(), PumpError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    writer.write_all(&header.encode()).await?;
    let copied = tokio::io::copy(&mut (&mut *reader).take(header.len), writer).await?;
    if copied != header.len {
        return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into());
    }
    Ok(())
}

/// Write one frame, masked with a fresh key when it goes to a server.
pub(super) async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    from: Sender,
    fin: bool,
    opcode: u8,
    payload: &[u8],
) -> Result<(), PumpError> {
    let mask = (from == Sender::Client).then(rand::random::<[u8; 4]>);
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
    writer.write_all(&bytes).await?;
    Ok(())
}

/// A close frame with `code` and a short reason.
pub(super) async fn write_close<W: AsyncWrite + Unpin>(
    writer: &mut W,
    from: Sender,
    code: u16,
    reason: &str,
) -> Result<(), PumpError> {
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(reason.as_bytes());
    payload.truncate(MAX_CONTROL_PAYLOAD as usize);
    write_frame(writer, from, true, OP_CLOSE, &payload).await
}

/// The message a direction is in the middle of.
enum Message {
    None,
    /// A fragmented text message being reassembled (unmasked payload).
    Text(Vec<u8>),
    /// A message copied unchanged (binary or over the size limit).
    Copied,
}

/// Relay frames from `reader` (sent by `from`) to `writer` until the reader
/// ends, rewriting text messages up to `max_message` bytes. The writer is
/// shut down at a clean end.
pub(super) async fn pump<R, W, X>(
    reader: &mut R,
    writer: &mut W,
    from: Sender,
    rewriter: &mut X,
    max_message: usize,
) -> Result<(), PumpError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    X: TextRewriter + ?Sized,
{
    let limit = max_message as u64;
    let mut message = Message::None;
    while let Some(header) = read_header(reader, from).await? {
        if header.is_control() {
            copy_frame(reader, writer, &header).await?;
            continue;
        }
        message = match (message, header.opcode) {
            (Message::None, OP_TEXT) if header.len <= limit => {
                let payload = read_payload(reader, &header).await?;
                if header.fin {
                    send_text(writer, from, rewriter, payload).await?;
                    Message::None
                } else {
                    Message::Text(payload)
                }
            }
            (Message::None, OP_TEXT | OP_BINARY) | (Message::Copied, OP_CONTINUATION) => {
                copy_frame(reader, writer, &header).await?;
                if header.fin {
                    Message::None
                } else {
                    Message::Copied
                }
            }
            (Message::Text(mut buffered), OP_CONTINUATION) => {
                if buffered.len() as u64 + header.len > limit {
                    // Too large to rewrite: send what was held back as the
                    // first fragment, then copy the rest unchanged.
                    write_frame(writer, from, false, OP_TEXT, &buffered).await?;
                    copy_frame(reader, writer, &header).await?;
                    if header.fin {
                        Message::None
                    } else {
                        Message::Copied
                    }
                } else {
                    buffered.extend_from_slice(&read_payload(reader, &header).await?);
                    if header.fin {
                        send_text(writer, from, rewriter, buffered).await?;
                        Message::None
                    } else {
                        Message::Text(buffered)
                    }
                }
            }
            (Message::None, _) => {
                return Err(PumpError::Protocol("continuation without a message"))
            }
            (_, _) => return Err(PumpError::Protocol("new message inside a fragmented one")),
        };
    }
    writer.shutdown().await?;
    Ok(())
}

async fn send_text<W, X>(
    writer: &mut W,
    from: Sender,
    rewriter: &mut X,
    payload: Vec<u8>,
) -> Result<(), PumpError>
where
    W: AsyncWrite + Unpin,
    X: TextRewriter + ?Sized,
{
    let rewritten = match std::str::from_utf8(&payload) {
        Ok(text) => rewriter
            .rewrite(text)
            .await
            .map_err(|()| PumpError::Refused)?,
        Err(_) => None,
    };
    let bytes = rewritten.map_or(payload, String::into_bytes);
    write_frame(writer, from, true, OP_TEXT, &bytes).await
}

#[cfg(test)]
#[path = "ws_frame_tests.rs"]
mod tests;

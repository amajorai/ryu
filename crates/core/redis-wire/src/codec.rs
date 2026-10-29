//! RESP2 frame codec: command encoding and an incremental, bounded reply parser.

use crate::RedisError;

/// Largest bulk string the parser accepts (64 MiB). Bigger replies are refused
/// as a protocol error rather than allocated.
pub const MAX_BULK_BYTES: usize = 64 * 1024 * 1024;
/// Largest array the parser accepts.
pub const MAX_ARRAY_LEN: usize = 1 << 20;
/// Deepest array nesting the parser accepts.
pub const MAX_DEPTH: usize = 16;
/// Longest header or simple/error/integer line the parser accepts (1 MiB). A
/// server that never terminates a line is refused instead of buffered forever.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

/// One RESP2 reply frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// `+OK`
    Simple(String),
    /// `-ERR message` (kept as a frame so pipelines can report per-command errors).
    Error(String),
    /// `:42`
    Integer(i64),
    /// `$n` bulk string; `None` is the nil bulk (`$-1`).
    Bulk(Option<Vec<u8>>),
    /// `*n` array; `None` is the nil array (`*-1`).
    Array(Option<Vec<Frame>>),
}

impl Frame {
    /// Bulk/simple payload as bytes; `None` for nil and non-string frames.
    pub fn into_bytes(self) -> Option<Vec<u8>> {
        match self {
            Self::Bulk(bytes) => bytes,
            Self::Simple(text) => Some(text.into_bytes()),
            _ => None,
        }
    }

    /// Integer payload (also parses a numeric bulk, as some commands reply that way).
    pub fn as_integer(&self) -> Option<i64> {
        match self {
            Self::Integer(value) => Some(*value),
            Self::Bulk(Some(bytes)) => std::str::from_utf8(bytes).ok()?.parse().ok(),
            _ => None,
        }
    }

    /// Array items; nil and non-array frames yield an empty list.
    pub fn into_array(self) -> Vec<Frame> {
        match self {
            Self::Array(Some(items)) => items,
            _ => Vec::new(),
        }
    }

    /// Whether this is the nil bulk or nil array.
    pub fn is_nil(&self) -> bool {
        matches!(self, Self::Bulk(None) | Self::Array(None))
    }

    /// Turn an error frame into a [`RedisError::Server`].
    pub fn into_result(self) -> Result<Frame, RedisError> {
        match self {
            Self::Error(message) => Err(RedisError::Server(message)),
            frame => Ok(frame),
        }
    }
}

/// A command: a binary-safe argument vector sent as a RESP array of bulks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cmd {
    args: Vec<Vec<u8>>,
}

impl Cmd {
    /// Start a command with its name (`GET`, `SET`, `FT.SEARCH`, ...).
    pub fn new(name: &str) -> Self {
        Self {
            args: vec![name.as_bytes().to_vec()],
        }
    }

    /// Append one argument (strings, byte slices, owned bytes).
    #[must_use]
    pub fn arg(mut self, value: impl AsRef<[u8]>) -> Self {
        self.args.push(value.as_ref().to_vec());
        self
    }

    /// Append an integer argument in decimal.
    #[must_use]
    pub fn int(self, value: i64) -> Self {
        self.arg(value.to_string())
    }

    /// The command name, upper-cased, for error messages. Arguments are never
    /// reported because they can carry credentials (`AUTH`) or user data.
    pub fn name(&self) -> String {
        self.args
            .first()
            .map(|name| String::from_utf8_lossy(name).to_ascii_uppercase())
            .unwrap_or_default()
    }

    /// The raw arguments, name first.
    pub fn args(&self) -> &[Vec<u8>] {
        &self.args
    }

    /// Append this command's RESP encoding to `out`.
    pub fn encode_into(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(format!("*{}\r\n", self.args.len()).as_bytes());
        for arg in &self.args {
            out.extend_from_slice(format!("${}\r\n", arg.len()).as_bytes());
            out.extend_from_slice(arg);
            out.extend_from_slice(b"\r\n");
        }
    }
}

/// Parse one frame from the front of `buf`.
///
/// Returns `Ok(None)` when `buf` holds only a prefix of a frame (read more and
/// retry), `Ok(Some((frame, consumed)))` on success, and an error for malformed
/// or over-limit input.
pub fn parse_frame(buf: &[u8]) -> Result<Option<(Frame, usize)>, RedisError> {
    parse_at(buf, 0, 0)
}

fn find_crlf(buf: &[u8], from: usize) -> Option<usize> {
    buf.get(from..)?
        .windows(2)
        .position(|window| window == b"\r\n")
        .map(|offset| from + offset)
}

fn parse_len(line: &[u8]) -> Result<i64, RedisError> {
    std::str::from_utf8(line)
        .ok()
        .and_then(|text| text.parse::<i64>().ok())
        .ok_or_else(|| RedisError::Protocol("invalid length or integer".to_owned()))
}

fn parse_at(buf: &[u8], pos: usize, depth: usize) -> Result<Option<(Frame, usize)>, RedisError> {
    if depth > MAX_DEPTH {
        return Err(RedisError::Protocol("reply nests too deeply".to_owned()));
    }
    let Some(&kind) = buf.get(pos) else {
        return Ok(None);
    };
    let Some(line_end) = find_crlf(buf, pos + 1) else {
        if buf.len() - pos > MAX_LINE_BYTES {
            return Err(RedisError::Protocol("reply line is too long".to_owned()));
        }
        return Ok(None);
    };
    if line_end - pos > MAX_LINE_BYTES {
        return Err(RedisError::Protocol("reply line is too long".to_owned()));
    }
    let line = &buf[pos + 1..line_end];
    let after = line_end + 2;
    match kind {
        b'+' => Ok(Some((
            Frame::Simple(String::from_utf8_lossy(line).into_owned()),
            after,
        ))),
        b'-' => Ok(Some((
            Frame::Error(String::from_utf8_lossy(line).into_owned()),
            after,
        ))),
        b':' => Ok(Some((Frame::Integer(parse_len(line)?), after))),
        b'$' => {
            let len = parse_len(line)?;
            if len < 0 {
                return Ok(Some((Frame::Bulk(None), after)));
            }
            let len = usize::try_from(len)
                .map_err(|_| RedisError::Protocol("invalid bulk length".to_owned()))?;
            if len > MAX_BULK_BYTES {
                return Err(RedisError::Protocol("bulk reply is too large".to_owned()));
            }
            let end = after + len;
            if buf.len() < end + 2 {
                return Ok(None);
            }
            if &buf[end..end + 2] != b"\r\n" {
                return Err(RedisError::Protocol(
                    "bulk reply is not CRLF-terminated".to_owned(),
                ));
            }
            Ok(Some((Frame::Bulk(Some(buf[after..end].to_vec())), end + 2)))
        }
        b'*' => {
            let len = parse_len(line)?;
            if len < 0 {
                return Ok(Some((Frame::Array(None), after)));
            }
            let len = usize::try_from(len)
                .map_err(|_| RedisError::Protocol("invalid array length".to_owned()))?;
            if len > MAX_ARRAY_LEN {
                return Err(RedisError::Protocol("array reply is too large".to_owned()));
            }
            let mut items = Vec::with_capacity(len.min(1024));
            let mut cursor = after;
            for _ in 0..len {
                match parse_at(buf, cursor, depth + 1)? {
                    Some((item, next)) => {
                        items.push(item);
                        cursor = next;
                    }
                    None => return Ok(None),
                }
            }
            Ok(Some((Frame::Array(Some(items)), cursor)))
        }
        other => Err(RedisError::Protocol(format!(
            "unknown reply type byte 0x{other:02x}"
        ))),
    }
}

/// Encode a frame (used by the in-process test server; clients only send [`Cmd`]s).
pub fn encode_frame(frame: &Frame, out: &mut Vec<u8>) {
    match frame {
        Frame::Simple(text) => {
            out.push(b'+');
            out.extend_from_slice(text.as_bytes());
            out.extend_from_slice(b"\r\n");
        }
        Frame::Error(text) => {
            out.push(b'-');
            out.extend_from_slice(text.as_bytes());
            out.extend_from_slice(b"\r\n");
        }
        Frame::Integer(value) => out.extend_from_slice(format!(":{value}\r\n").as_bytes()),
        Frame::Bulk(None) => out.extend_from_slice(b"$-1\r\n"),
        Frame::Bulk(Some(bytes)) => {
            out.extend_from_slice(format!("${}\r\n", bytes.len()).as_bytes());
            out.extend_from_slice(bytes);
            out.extend_from_slice(b"\r\n");
        }
        Frame::Array(None) => out.extend_from_slice(b"*-1\r\n"),
        Frame::Array(Some(items)) => {
            out.extend_from_slice(format!("*{}\r\n", items.len()).as_bytes());
            for item in items {
                encode_frame(item, out);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(frame: &Frame) -> Vec<u8> {
        let mut out = Vec::new();
        encode_frame(frame, &mut out);
        out
    }

    #[test]
    fn commands_encode_as_binary_safe_bulk_arrays() {
        let mut out = Vec::new();
        Cmd::new("SET")
            .arg("k")
            .arg([0u8, b'\r', b'\n', 255])
            .encode_into(&mut out);
        assert_eq!(
            out,
            b"*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$4\r\n\0\r\n\xff\r\n".to_vec()
        );
    }

    #[test]
    fn every_frame_kind_round_trips() {
        let frame = Frame::Array(Some(vec![
            Frame::Simple("OK".into()),
            Frame::Error("ERR nope".into()),
            Frame::Integer(-7),
            Frame::Bulk(None),
            Frame::Bulk(Some(b"a\r\nb".to_vec())),
            Frame::Array(None),
            Frame::Array(Some(vec![Frame::Integer(1)])),
        ]));
        let bytes = encoded(&frame);
        let (parsed, consumed) = parse_frame(&bytes).unwrap().unwrap();
        assert_eq!(parsed, frame);
        assert_eq!(consumed, bytes.len());
    }

    #[test]
    fn every_strict_prefix_is_incomplete_not_an_error() {
        let bytes = encoded(&Frame::Array(Some(vec![
            Frame::Bulk(Some(b"hello".to_vec())),
            Frame::Integer(12),
        ])));
        for cut in 0..bytes.len() {
            assert_eq!(parse_frame(&bytes[..cut]).unwrap(), None, "prefix {cut}");
        }
    }

    #[test]
    fn trailing_bytes_are_left_for_the_next_frame() {
        let (frame, consumed) = parse_frame(b"+OK\r\n:1\r\n").unwrap().unwrap();
        assert_eq!(frame, Frame::Simple("OK".into()));
        assert_eq!(consumed, 5);
    }

    #[test]
    fn malformed_and_oversized_replies_are_rejected() {
        assert!(parse_frame(b"?x\r\n").is_err());
        assert!(parse_frame(b":abc\r\n").is_err());
        assert!(parse_frame(b"$3\r\nabcXY").is_err());
        let huge = format!("${}\r\n", MAX_BULK_BYTES + 1);
        assert!(parse_frame(huge.as_bytes()).is_err());
        let deep = "*1\r\n".repeat(MAX_DEPTH + 2);
        assert!(parse_frame(deep.as_bytes()).is_err());
        let unterminated = format!("+{}", "x".repeat(MAX_LINE_BYTES + 1));
        assert!(parse_frame(unterminated.as_bytes()).is_err());
        let long_line = format!("-{}\r\n", "x".repeat(MAX_LINE_BYTES + 1));
        assert!(parse_frame(long_line.as_bytes()).is_err());
    }

    #[test]
    fn frame_helpers() {
        assert_eq!(Frame::Bulk(Some(b"12".to_vec())).as_integer(), Some(12));
        assert!(Frame::Bulk(None).is_nil());
        assert!(Frame::Error("ERR x".into()).into_result().is_err());
        assert_eq!(Cmd::new("auth").arg("secret").name(), "AUTH");
    }
}

//! Binary frames carried one-per-message over the desktop route WebSocket.
//!
//! Layout: `kind: u8 | stream: u32 (BE) | payload`. Only the node (entry side)
//! allocates stream ids and sends `Open`; only the desktop (exit side) answers
//! with `Opened` / `Refused`. Every other frame flows in both directions.

/// Largest hostname an `Open` frame may carry (DNS limit).
pub(crate) const MAX_HOST_BYTES: usize = 253;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum RefuseCode {
    /// The destination resolves to a private, loopback, or reserved address.
    Blocked = 1,
    /// DNS failed or the TCP connection was refused/unreachable.
    Unreachable = 2,
    /// The exit could not connect in time.
    Timeout = 3,
    /// The exit is at its concurrent-stream limit.
    Busy = 4,
    /// The request itself was malformed.
    Invalid = 5,
}

impl RefuseCode {
    fn from_byte(byte: u8) -> Self {
        match byte {
            1 => Self::Blocked,
            2 => Self::Unreachable,
            3 => Self::Timeout,
            4 => Self::Busy,
            _ => Self::Invalid,
        }
    }

    pub(crate) fn describe(self) -> &'static str {
        match self {
            Self::Blocked => "destination is a private or reserved address",
            Self::Unreachable => "destination is unreachable from the desktop",
            Self::Timeout => "desktop timed out connecting to the destination",
            Self::Busy => "desktop route is at its connection limit",
            Self::Invalid => "invalid destination",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Frame {
    Open {
        stream: u32,
        host: String,
        port: u16,
    },
    Opened {
        stream: u32,
    },
    Refused {
        stream: u32,
        code: RefuseCode,
    },
    Data {
        stream: u32,
        bytes: Vec<u8>,
    },
    /// Grants the peer `bytes` more send credit on `stream`.
    Window {
        stream: u32,
        bytes: u32,
    },
    /// The sender will write no more data on `stream` (TCP half-close).
    Fin {
        stream: u32,
    },
    /// Abort `stream` in both directions.
    Reset {
        stream: u32,
    },
}

const OPEN: u8 = 1;
const OPENED: u8 = 2;
const REFUSED: u8 = 3;
const DATA: u8 = 4;
const WINDOW: u8 = 5;
const FIN: u8 = 6;
const RESET: u8 = 7;

impl Frame {
    pub(crate) fn encode(&self) -> Vec<u8> {
        let (kind, stream) = match self {
            Self::Open { stream, .. } => (OPEN, *stream),
            Self::Opened { stream } => (OPENED, *stream),
            Self::Refused { stream, .. } => (REFUSED, *stream),
            Self::Data { stream, .. } => (DATA, *stream),
            Self::Window { stream, .. } => (WINDOW, *stream),
            Self::Fin { stream } => (FIN, *stream),
            Self::Reset { stream } => (RESET, *stream),
        };
        let mut out = Vec::with_capacity(5);
        out.push(kind);
        out.extend_from_slice(&stream.to_be_bytes());
        match self {
            Self::Open { host, port, .. } => {
                out.extend_from_slice(&port.to_be_bytes());
                out.extend_from_slice(host.as_bytes());
            }
            Self::Refused { code, .. } => out.push(*code as u8),
            Self::Data { bytes, .. } => out.extend_from_slice(bytes),
            Self::Window { bytes, .. } => out.extend_from_slice(&bytes.to_be_bytes()),
            Self::Opened { .. } | Self::Fin { .. } | Self::Reset { .. } => {}
        }
        out
    }

    pub(crate) fn decode(raw: &[u8]) -> Option<Self> {
        let (&kind, rest) = raw.split_first()?;
        let stream = u32::from_be_bytes(rest.get(..4)?.try_into().ok()?);
        let payload = &rest[4..];
        Some(match kind {
            OPEN => {
                let port = u16::from_be_bytes(payload.get(..2)?.try_into().ok()?);
                let host = std::str::from_utf8(&payload[2..]).ok()?;
                if port == 0 || host.is_empty() || host.len() > MAX_HOST_BYTES {
                    return None;
                }
                Self::Open {
                    stream,
                    host: host.to_owned(),
                    port,
                }
            }
            OPENED if payload.is_empty() => Self::Opened { stream },
            REFUSED if payload.len() == 1 => Self::Refused {
                stream,
                code: RefuseCode::from_byte(payload[0]),
            },
            DATA if !payload.is_empty() => Self::Data {
                stream,
                bytes: payload.to_vec(),
            },
            WINDOW if payload.len() == 4 => Self::Window {
                stream,
                bytes: u32::from_be_bytes(payload.try_into().ok()?),
            },
            FIN if payload.is_empty() => Self::Fin { stream },
            RESET if payload.is_empty() => Self::Reset { stream },
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_frame_round_trips() {
        let frames = [
            Frame::Open {
                stream: 7,
                host: "example.com".into(),
                port: 443,
            },
            Frame::Opened { stream: 7 },
            Frame::Refused {
                stream: 7,
                code: RefuseCode::Blocked,
            },
            Frame::Data {
                stream: u32::MAX,
                bytes: b"hello".to_vec(),
            },
            Frame::Window {
                stream: 1,
                bytes: 65536,
            },
            Frame::Fin { stream: 2 },
            Frame::Reset { stream: 3 },
        ];
        for frame in frames {
            assert_eq!(Frame::decode(&frame.encode()), Some(frame));
        }
    }

    #[test]
    fn malformed_frames_are_rejected() {
        assert_eq!(Frame::decode(&[]), None);
        assert_eq!(Frame::decode(&[DATA, 0, 0, 0]), None);
        // Empty data, zero port, oversized host, trailing bytes, unknown kind.
        assert_eq!(Frame::decode(&[DATA, 0, 0, 0, 1]), None);
        assert_eq!(Frame::decode(&[OPEN, 0, 0, 0, 1, 0, 0, b'a']), None);
        let mut long = vec![OPEN, 0, 0, 0, 1, 1, 187];
        long.extend(std::iter::repeat(b'a').take(MAX_HOST_BYTES + 1));
        assert_eq!(Frame::decode(&long), None);
        assert_eq!(Frame::decode(&[FIN, 0, 0, 0, 1, 9]), None);
        assert_eq!(Frame::decode(&[99, 0, 0, 0, 1]), None);
    }
}

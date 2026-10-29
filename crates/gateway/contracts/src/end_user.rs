//! The tenant end-user header (`x-ryu-end-user`).
//!
//! A tenant that serves its own users names the person behind a request with
//! one opaque id per user: its internal id or a hash of it, never an email or
//! a phone number. The Gateway hashes the value per organization as soon as
//! the organization is known and drops the raw value, so it never reaches a
//! request context, an audit row, a trace span or an upstream provider.
//!
//! Pure: no clock, IO or secrets. Hashing lives in the Gateway, which holds the
//! keys.

/// The request header that carries a tenant's end-user id.
pub const END_USER_HEADER: &str = "x-ryu-end-user";
/// The longest accepted value, in bytes.
pub const MAX_END_USER_BYTES: usize = 128;
/// Optional prefix for a logged-out visitor's session id.
pub const END_USER_SESSION_PREFIX: &str = "session:";

/// A validated raw end-user id. The manual `Debug` never prints the value and
/// the type has no `Serialize`, so it cannot leak into a log or a payload by
/// accident.
#[derive(Clone, PartialEq, Eq)]
pub struct EndUserKey(String);

impl EndUserKey {
    /// The raw value, for hashing only.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for EndUserKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("EndUserKey(..)")
    }
}

/// Why an end-user header is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndUserProblem {
    /// The header is present but empty (or only the session prefix).
    Empty,
    /// Longer than [`MAX_END_USER_BYTES`].
    TooLong,
    /// A byte outside printable ASCII (0x21 to 0x7E): whitespace, a control
    /// byte or anything non-ASCII.
    InvalidByte,
}

impl EndUserProblem {
    pub fn as_str(self) -> &'static str {
        match self {
            EndUserProblem::Empty => "empty",
            EndUserProblem::TooLong => "too_long",
            EndUserProblem::InvalidByte => "invalid_byte",
        }
    }
}

/// Parse an `x-ryu-end-user` value. `None` (no header) is no end user. A
/// present header must be 1 to 128 bytes of printable ASCII; it is never
/// trimmed, so a value with surrounding whitespace is refused rather than
/// silently becoming a different person.
pub fn parse_end_user(raw: Option<&[u8]>) -> Result<Option<EndUserKey>, EndUserProblem> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Err(EndUserProblem::Empty);
    }
    if raw.len() > MAX_END_USER_BYTES {
        return Err(EndUserProblem::TooLong);
    }
    if !raw.iter().all(|byte| (0x21..=0x7E).contains(byte)) {
        return Err(EndUserProblem::InvalidByte);
    }
    if raw == END_USER_SESSION_PREFIX.as_bytes() {
        return Err(EndUserProblem::Empty);
    }
    // Every byte is printable ASCII, so this is valid UTF-8.
    let value = String::from_utf8(raw.to_vec()).map_err(|_| EndUserProblem::InvalidByte)?;
    Ok(Some(EndUserKey(value)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_header_is_no_end_user() {
        assert_eq!(parse_end_user(None), Ok(None));
    }

    #[test]
    fn printable_ascii_up_to_the_limit_is_accepted() {
        for value in [
            "u".to_owned(),
            "tenant-user-42".to_owned(),
            "session:7f3a9c".to_owned(),
            "x".repeat(MAX_END_USER_BYTES),
            "!~".to_owned(),
        ] {
            let parsed = parse_end_user(Some(value.as_bytes()))
                .unwrap_or_else(|problem| panic!("{value}: {problem:?}"))
                .expect("a present header parses to a key");
            assert_eq!(parsed.expose(), value);
        }
    }

    #[test]
    fn malformed_values_are_refused() {
        let too_long = "x".repeat(MAX_END_USER_BYTES + 1);
        let cases: [(&[u8], EndUserProblem); 8] = [
            (b"", EndUserProblem::Empty),
            (b"session:", EndUserProblem::Empty),
            (too_long.as_bytes(), EndUserProblem::TooLong),
            (b"two words", EndUserProblem::InvalidByte),
            (b" leading", EndUserProblem::InvalidByte),
            (b"tab\tinside", EndUserProblem::InvalidByte),
            (b"bell\x07", EndUserProblem::InvalidByte),
            ("caf\u{e9}".as_bytes(), EndUserProblem::InvalidByte),
        ];
        for (raw, expected) in cases {
            assert_eq!(parse_end_user(Some(raw)), Err(expected), "{raw:?}");
        }
    }

    #[test]
    fn debug_never_prints_the_raw_value() {
        let key = parse_end_user(Some(b"tenant-user-SECRET-42"))
            .unwrap()
            .unwrap();
        assert_eq!(format!("{key:?}"), "EndUserKey(..)");
    }
}

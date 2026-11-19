//! TDS encoding tests, plus token builders the fake server shares.

use super::*;

fn utf16_text(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// Undo LOGIN7 password obfuscation.
pub(crate) fn deobfuscate(bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .map(|b| {
            let b = b ^ 0xA5;
            (b << 4) | (b >> 4)
        })
        .collect()
}

/// (user, password, database) from a LOGIN7 message.
pub(crate) fn login7_fields(message: &[u8]) -> (String, String, String) {
    let field = |index: usize| {
        let at = 36 + index * 4;
        let offset = u16::from_le_bytes([message[at], message[at + 1]]) as usize;
        let chars = u16::from_le_bytes([message[at + 2], message[at + 3]]) as usize;
        message[offset..offset + chars * 2].to_vec()
    };
    (
        utf16_text(&field(1)),
        utf16_text(&deobfuscate(&field(2))),
        utf16_text(&field(8)),
    )
}

/// The SQL text of a batch.
pub(crate) fn batch_sql(message: &[u8]) -> String {
    utf16_text(&message[22..])
}

pub(crate) fn done(error: bool) -> Vec<u8> {
    let mut token = vec![0xFD];
    token.extend_from_slice(&(if error { 0x2u16 } else { 0 }).to_le_bytes());
    token.extend_from_slice(&[0; 10]);
    token
}

pub(crate) fn error_token(number: u32, message: &str) -> Vec<u8> {
    let text = utf16(message);
    let mut body = number.to_le_bytes().to_vec();
    body.extend_from_slice(&[1, 14]);
    body.extend_from_slice(&((text.len() / 2) as u16).to_le_bytes());
    body.extend(text);
    body.extend_from_slice(&[0, 0]);
    body.extend_from_slice(&1u32.to_le_bytes());
    let mut token = vec![0xAA];
    token.extend_from_slice(&(body.len() as u16).to_le_bytes());
    token.extend(body);
    token
}

pub(crate) fn loginack() -> Vec<u8> {
    let mut token = vec![0xAD, 10, 0];
    token.extend_from_slice(&[1, 4, 0, 0, 0x74, 0, 16, 0, 0, 0]);
    token
}

pub(crate) fn envchange() -> Vec<u8> {
    // Database change: master -> app (lengths only matter here).
    let mut token = vec![0xE3, 3, 0];
    token.extend_from_slice(&[1, 0, 0]);
    token
}

/// A PRELOGIN reply carrying `encryption`.
pub(crate) fn prelogin_reply(encryption: u8) -> Vec<u8> {
    let mut reply = prelogin(encryption);
    reply[16..22].copy_from_slice(&[16, 0, 0x10, 0x37, 0, 0]);
    reply
}

#[test]
fn large_payloads_split_into_numbered_packets() {
    let payload = vec![7u8; PACKET_SIZE * 2];
    let bytes = packets(TYPE_BATCH, &payload);
    let first: [u8; HEADER] = bytes[..HEADER].try_into().unwrap();
    assert_eq!(
        header(&first).unwrap(),
        (TYPE_BATCH, false, PACKET_SIZE - HEADER)
    );
    assert_eq!(bytes[6], 1);
    // Three packets: two full, one remainder with end-of-message.
    assert_eq!(bytes.len(), payload.len() + 3 * HEADER);
    let last_at = 2 * PACKET_SIZE;
    let last: [u8; HEADER] = bytes[last_at..last_at + HEADER].try_into().unwrap();
    assert_eq!(header(&last).unwrap(), (TYPE_BATCH, true, 16));
    assert_eq!(bytes[last_at + 6], 3);
    assert!(header(&[4, 1, 0, 2, 0, 0, 0, 0]).is_err());
}

#[test]
fn prelogin_round_trips_its_encryption_option() {
    assert_eq!(
        prelogin_encryption(&prelogin(ENCRYPT_NOT_SUP)).unwrap(),
        ENCRYPT_NOT_SUP
    );
    assert_eq!(
        prelogin_encryption(&prelogin_reply(ENCRYPT_REQ)).unwrap(),
        ENCRYPT_REQ
    );
    assert!(prelogin_encryption(&[0x00, 0, 5, 0, 6, 0xFF]).is_err());
}

#[test]
fn login7_carries_obfuscated_credentials() {
    let message = login7("sa", "P@ssw0rd!", "db.example.com", "app");
    assert_eq!(
        u32::from_le_bytes(message[..4].try_into().unwrap()) as usize,
        message.len()
    );
    assert_eq!(&message[4..8], &[0x04, 0, 0, 0x74]);
    assert_eq!(
        login7_fields(&message),
        ("sa".into(), "P@ssw0rd!".into(), "app".into())
    );
    // The password never appears in clear.
    let clear = utf16("P@ssw0rd!");
    assert!(!message.windows(clear.len()).any(|window| window == clear));
    assert_eq!(batch_sql(&batch("SELECT 1")), "SELECT 1");
}

#[test]
fn replies_report_logins_errors_and_rows() {
    let mut ok = envchange();
    ok.extend(loginack());
    ok.extend(done(false));
    assert_eq!(
        parse_reply(&ok).unwrap(),
        Outcome {
            logged_in: true,
            error: None,
            done_error: false
        }
    );
    let mut failed = error_token(18456, "Login failed for user 'sa'.");
    failed.extend(done(true));
    let outcome = parse_reply(&failed).unwrap();
    assert_eq!(
        outcome.error.as_deref(),
        Some("[18456] Login failed for user 'sa'.")
    );
    assert!(outcome.done_error && !outcome.logged_in);
    assert!(parse_reply(&[0x81, 1, 0])
        .unwrap_err()
        .to_string()
        .contains("return rows"));
    assert!(parse_reply(&[0xAA, 50, 0, 1]).is_err());
}

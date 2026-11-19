//! Shared transit test helpers and tests of the module's own helpers.

use super::*;

pub(super) fn actor() -> AuditActor {
    AuditActor::new("machine", Some("m1"))
}

pub(super) fn opts(context: Option<&[u8]>) -> TransitOpOptions {
    TransitOpOptions {
        context: context.map(|c| B64.encode(c)),
        ..TransitOpOptions::default()
    }
}

#[test]
fn key_names_types_and_transit_strings_round_trip() {
    assert!(is_valid_key_name("orders-2024_a"));
    for bad in ["", "Orders", "-lead", "_wrapping", &"a".repeat(65), "a/b"] {
        assert!(!is_valid_key_name(bad), "{bad}");
    }
    for kind in TransitKeyType::ALL {
        assert_eq!(TransitKeyType::parse(kind.as_str()), Some(kind));
    }
    assert_eq!(TransitKeyType::parse("aes128-gcm96x"), None);
    let encoded = encode(7, b"payload");
    assert!(encoded.starts_with("ryu:v7:"));
    assert_eq!(decode(&encoded).unwrap(), (7, b"payload".to_vec()));
    for bad in ["vault:v1:AAAA", "ryu:vX:AAAA", "ryu:v1", "ryu:v1:@@@"] {
        assert!(decode(bad).is_err(), "{bad}");
    }
    assert!(decode_input(&B64.encode(vec![0u8; MAX_INPUT_BYTES + 1])).is_err());
}

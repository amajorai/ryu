//! Tests for [`super::der`].

use super::der;

#[test]
fn tlvs_round_trip_with_short_and_long_lengths() {
    for length in [0usize, 1, 127, 128, 255, 256, 70_000] {
        let value = vec![0xab; length];
        let encoded = der::tlv(der::OCTET_STRING, &value);
        let (tlv, rest) = der::read(&encoded).unwrap();
        assert!(rest.is_empty());
        assert_eq!(tlv.tag, der::OCTET_STRING);
        assert_eq!(tlv.value, value.as_slice());
        assert_eq!(tlv.raw, encoded.as_slice());
    }
    let seq = der::sequence(&[&der::tlv(der::INTEGER, &[1]), &der::tlv(der::NULL, &[])]);
    let (outer, _) = der::expect(&seq, der::SEQUENCE).unwrap();
    let inner = der::items(outer.value).unwrap();
    assert_eq!(inner.len(), 2);
    assert_eq!(inner[1].raw, [0x05, 0x00]);
    assert!(der::expect(&seq, der::INTEGER).is_err());
}

#[test]
fn malformed_encodings_are_refused() {
    for bad in [
        &[][..],
        &[0x30][..],
        &[0x30, 0x05, 0x01][..],
        &[0x1f, 0x01, 0x00][..],
        &[0x04, 0x81, 0x05, 0, 0, 0, 0, 0][..],
        &[0x04, 0x85, 1, 0, 0, 0, 0][..],
    ] {
        assert!(der::read(bad).is_err(), "{bad:02x?}");
    }
}

#[test]
fn oids_times_and_bit_strings_encode_as_der() {
    // id-pkix-ocsp-basic and sha256WithRSAEncryption, from RFC 6960 / RFC 4055.
    assert_eq!(
        hex::encode(der::oid("1.3.6.1.5.5.7.48.1.1")),
        "06092b0601050507300101"
    );
    assert_eq!(
        hex::encode(der::oid("1.2.840.113549.1.1.11")),
        "06092a864886f70d01010b"
    );
    let time = der::generalized_time(1_700_000_000);
    assert_eq!(&time[2..], b"20231114221320Z");
    assert_eq!(der::bit_string(&[0xff]), [0x03, 0x02, 0x00, 0xff]);
    assert_eq!(der::context(1), 0xa1);
    assert_eq!(der::context_primitive(2), 0x82);
}

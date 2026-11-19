//! Tests for [`super::kwp`].

use super::*;

#[test]
fn aes_key_wrap_matches_rfc_3394_and_kwp_round_trips() {
    // RFC 3394 section 4.6: 256 bits of key data with a 256-bit KEK.
    let kek =
        hex::decode("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F").unwrap();
    let data =
        hex::decode("00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F").unwrap();
    let cipher = kw_cipher(&kek).unwrap();
    let mut blocks = to_blocks(&data);
    let a = kw_wrap_blocks(&cipher, [0xA6; 8], &mut blocks);
    let mut wrapped = a.to_vec();
    wrapped.extend(blocks.concat());
    assert_eq!(
        hex::encode_upper(&wrapped),
        "28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21"
    );
    let mut back = to_blocks(&wrapped[8..]);
    let mut iv = [0u8; 8];
    iv.copy_from_slice(&wrapped[..8]);
    assert_eq!(kw_unwrap_blocks(&cipher, iv, &mut back), [0xA6; 8]);
    assert_eq!(back.concat(), data);

    for len in [1usize, 7, 8, 9, 20, 32, 1218] {
        let material = random_bytes(len);
        let wrapped = kwp_wrap(&kek, &material).unwrap();
        assert_eq!(kwp_unwrap(&kek, &wrapped).unwrap(), material, "len {len}");
        let mut tampered = wrapped.clone();
        tampered[0] ^= 1;
        assert!(kwp_unwrap(&kek, &tampered).is_err());
    }
}

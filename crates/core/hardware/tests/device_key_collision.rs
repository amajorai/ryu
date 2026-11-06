//! Tool-name device keys are injective: a device cannot choose an id equal to
//! another device's hashed key and take over that device's capability tools.

use ryu_hardware::capability::{device_key, tool_id, tool_name};
use sha2::{Digest, Sha256};

fn hashed(device_id: &str) -> String {
    format!(
        "d{}",
        &hex::encode(Sha256::digest(device_id.as_bytes()))[..12]
    )
}

#[test]
fn a_hashed_key_used_as_a_device_id_is_hashed_again() {
    let victim = "rhw_0123456789abcdef0123456789abcdef";
    let victim_key = device_key(victim);
    assert_eq!(victim_key, hashed(victim));

    // The attacker pairs with the victim's key as its own device_id.
    let attacker_key = device_key(&victim_key);
    assert_ne!(attacker_key, victim_key);
    assert_eq!(attacker_key, hashed(&victim_key));
    assert_ne!(tool_name(&victim_key, "ping"), tool_name(victim, "ping"));
    assert_ne!(tool_id(&victim_key, "ping"), tool_id(victim, "ping"));
}

#[test]
fn only_the_exact_hashed_form_is_reserved() {
    for verbatim in [
        "d0123456789a",
        "d0123456789abc",
        "dabc_0123456789ab",
        "rhw_1",
    ] {
        assert_eq!(device_key(verbatim), verbatim);
    }
    assert_eq!(device_key("d0123456789ab"), hashed("d0123456789ab"));
}

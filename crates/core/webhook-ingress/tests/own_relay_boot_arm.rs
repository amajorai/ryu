//! Core arms own-relay loopback distrust at boot, before the listener accepts a
//! request and independent of the background `start()`. Its own test binary,
//! because the flag is process-global.

use ryu_webhook_ingress::OwnRelaySource;

#[test]
fn arming_at_boot_marks_the_process_as_forwarding() {
    assert!(!OwnRelaySource::forwarding_active());
    OwnRelaySource::arm_forwarding();
    assert!(OwnRelaySource::forwarding_active());
}

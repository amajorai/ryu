//! Smoke coverage for the extracted BYOK SMTP sink: transport-prefs cache
//! round-trip, env fallback gated on the injected password resolver, and the
//! unconfigured no-op.

use ryu_email_send::{
    apply_transport_prefs_json, current_transport_prefs, resolve_transport,
    set_password_resolver, set_transport,
};

// One test: every case mutates process-global sink state (the transport cache +
// the password-resolver hook), so they must run sequentially in one thread.
#[test]
fn sink_prefs_cache_and_resolution() {
    // Transport-prefs JSON round-trips through the cache.
    apply_transport_prefs_json(
        r#"{"host":"smtp.example.com","port":2525,"username":"u","from":"a@b.c","starttls":false}"#,
    );
    let prefs = current_transport_prefs().expect("prefs cached");
    assert_eq!(prefs.host, "smtp.example.com");
    assert_eq!(prefs.port, 2525);
    assert_eq!(prefs.username, "u");
    assert_eq!(prefs.from, "a@b.c");
    assert!(!prefs.starttls);

    // A malformed value clears the cache.
    apply_transport_prefs_json("not json");
    assert!(current_transport_prefs().is_none());

    // A relay is cached, but no password ⇒ still disabled (fail-safe no-op).
    set_transport("smtp.example.com", 587, "u", "from@example.com", true);
    set_password_resolver(|| None);
    assert!(resolve_transport().is_none(), "no password ⇒ disabled");

    // Password now available via the hook ⇒ transport resolves from the cache.
    set_password_resolver(|| Some("s3cret".to_string()));
    let cfg = resolve_transport().expect("configured");
    assert_eq!(cfg.host, "smtp.example.com");
    assert_eq!(cfg.password, "s3cret");
    assert_eq!(cfg.from, "from@example.com");

    // Clearing the relay (empty host) disables again even with a password.
    set_transport("", 0, "", "", true);
    std::env::remove_var("RYU_SMTP_HOST");
    assert!(resolve_transport().is_none(), "no relay ⇒ disabled");
}

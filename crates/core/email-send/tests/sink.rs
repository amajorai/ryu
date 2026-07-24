//! Smoke coverage for the extracted BYOK SMTP sink: transport-prefs cache
//! round-trip, env fallback gated on the injected password resolver, and the
//! unconfigured no-op.

use ryu_email_send::{
    apply_transport_prefs_json, current_transport_prefs, resolve_transport, set_password_resolver,
    set_transport,
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

    // set_transport trims host/username/from before caching.
    set_transport("  smtp.trim.io  ", 25, "  user  ", "  me@trim.io  ", false);
    let trimmed = current_transport_prefs().expect("cached");
    assert_eq!(trimmed.host, "smtp.trim.io");
    assert_eq!(trimmed.username, "user");
    assert_eq!(trimmed.from, "me@trim.io");
    assert_eq!(trimmed.port, 25);
    assert!(!trimmed.starttls);

    // current_transport_prefs is None once the cache is cleared.
    set_transport("", 0, "", "", true);
    assert!(current_transport_prefs().is_none(), "cleared ⇒ None");

    // --- Env fallback: with the cache empty, resolve_transport reads RYU_SMTP_*.
    // A password is required for any of it to resolve.
    set_password_resolver(|| Some("envpw".to_string()));

    // No host env ⇒ still disabled.
    std::env::remove_var("RYU_SMTP_HOST");
    assert!(resolve_transport().is_none(), "no env host ⇒ disabled");

    // Whitespace-only host ⇒ disabled (host.trim().is_empty()).
    std::env::set_var("RYU_SMTP_HOST", "   ");
    assert!(resolve_transport().is_none(), "blank env host ⇒ disabled");

    // Full env config: explicit port/username/from/starttls-off, host trimmed.
    std::env::set_var("RYU_SMTP_HOST", "  env.smtp.io  ");
    std::env::set_var("RYU_SMTP_PORT", "2525");
    std::env::set_var("RYU_SMTP_USERNAME", "envuser");
    std::env::set_var("RYU_SMTP_FROM", "  env@from.io  ");
    std::env::set_var("RYU_SMTP_STARTTLS", "0");
    let env_cfg = resolve_transport().expect("env-configured");
    assert_eq!(env_cfg.host, "env.smtp.io", "host trimmed");
    assert_eq!(env_cfg.port, 2525);
    assert_eq!(env_cfg.username, "envuser");
    assert_eq!(env_cfg.from, "env@from.io", "from trimmed");
    assert_eq!(env_cfg.password, "envpw");
    assert!(!env_cfg.starttls, "STARTTLS=0 ⇒ false");

    // STARTTLS=false (case-insensitive) ⇒ false.
    std::env::set_var("RYU_SMTP_STARTTLS", "False");
    assert!(!resolve_transport().expect("cfg").starttls);

    // Any other STARTTLS value ⇒ true (the default-on posture).
    std::env::set_var("RYU_SMTP_STARTTLS", "yes");
    assert!(resolve_transport().expect("cfg").starttls, "non-0/false ⇒ true");

    // Defaults: no port/username/from/starttls env ⇒ port 587, starttls true,
    // and `from` defaults to the username.
    std::env::remove_var("RYU_SMTP_PORT");
    std::env::remove_var("RYU_SMTP_FROM");
    std::env::remove_var("RYU_SMTP_STARTTLS");
    std::env::set_var("RYU_SMTP_USERNAME", "solo@user.io");
    let defaulted = resolve_transport().expect("env-defaulted");
    assert_eq!(defaulted.port, 587, "default submission port");
    assert!(defaulted.starttls, "default STARTTLS on");
    assert_eq!(defaulted.from, "solo@user.io", "from defaults to username");

    // A non-numeric port falls back to 587.
    std::env::set_var("RYU_SMTP_PORT", "not-a-number");
    assert_eq!(resolve_transport().expect("cfg").port, 587, "bad port ⇒ 587");

    // With the password hook unwired, env config resolves to nothing (fail-safe).
    set_password_resolver(|| None);
    assert!(resolve_transport().is_none(), "no password ⇒ disabled even w/ env");

    // Clean up env so it cannot leak into other tests in this binary.
    for key in [
        "RYU_SMTP_HOST",
        "RYU_SMTP_PORT",
        "RYU_SMTP_USERNAME",
        "RYU_SMTP_FROM",
        "RYU_SMTP_STARTTLS",
    ] {
        std::env::remove_var(key);
    }
}

use super::test_config_path::ConfigPathGuard;
use super::GatewayConfig;

/// Restore one env var on drop, so a panicking test cannot leak it into the
/// rest of the binary. The `ConfigPathGuard` the caller also holds serializes
/// these windows against each other.
struct EnvVar(&'static str, Option<std::ffi::OsString>);
impl EnvVar {
    fn set(name: &'static str, value: &str) -> Self {
        let prior = std::env::var_os(name);
        std::env::set_var(name, value);
        Self(name, prior)
    }
    fn cleared(name: &'static str) -> Self {
        let prior = std::env::var_os(name);
        std::env::remove_var(name);
        Self(name, prior)
    }
}
impl Drop for EnvVar {
    fn drop(&mut self) {
        match self.1.take() {
            Some(prior) => std::env::set_var(self.0, prior),
            None => std::env::remove_var(self.0),
        }
    }
}

/// Provisioning an administrator retains the authenticated default.
#[test]
fn admin_key_preserves_authenticated_default() {
    let _path = ConfigPathGuard::isolated("admin-key");
    let _master = EnvVar::cleared("GATEWAY_MASTER_KEY");
    let _admin = EnvVar::set(
        "GATEWAY_ADMIN_KEY",
        "gwadm_0123456789abcdef0123456789abcdef",
    );

    let cfg = GatewayConfig::load().expect("gateway config loads");
    assert_eq!(
        cfg.auth.master_key.as_deref(),
        Some("gwadm_0123456789abcdef0123456789abcdef")
    );
    assert!(
        cfg.auth.require_auth,
        "authentication must be enabled by default"
    );
}

/// An operator's explicit master key outranks the one Core mints for itself —
/// and keeps its `require_auth` semantics.
#[test]
fn explicit_master_key_outranks_admin_key() {
    let _path = ConfigPathGuard::isolated("admin-key-precedence");
    let _master = EnvVar::set(
        "GATEWAY_MASTER_KEY",
        "operator_0123456789abcdef0123456789abcdef",
    );
    let _admin = EnvVar::set(
        "GATEWAY_ADMIN_KEY",
        "gwadm_0123456789abcdef0123456789abcdef",
    );

    let cfg = GatewayConfig::load().expect("gateway config loads");
    assert_eq!(
        cfg.auth.master_key.as_deref(),
        Some("operator_0123456789abcdef0123456789abcdef")
    );
    assert!(cfg.auth.require_auth);
}

/// An explicitly blank credential is a startup error, never an auth opt-out.
#[test]
fn blank_admin_key_is_rejected() {
    let _path = ConfigPathGuard::isolated("admin-key-blank");
    let _master = EnvVar::cleared("GATEWAY_MASTER_KEY");
    let _admin = EnvVar::set("GATEWAY_ADMIN_KEY", "   ");
    assert!(GatewayConfig::load().is_err());
}

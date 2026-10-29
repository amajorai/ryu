//! Custody-source probes over the real root `docker-compose.yml` and the
//! shipped images: the self-host compose env, its vault-signal twin, and the
//! fleet key in `gateway.toml`.
use super::*;

#[test]
fn probe_real_compose_gateway_env_is_self_hosted_with_exposure_hardening() {
    let (env, required) = compose_gateway_env();
    // A parser that found nothing would pass every assertion below vacuously.
    for name in [
        "GATEWAY_MASTER_KEY",
        "GATEWAY_RELAY_KEY",
        "RYU_GATEWAY_FLEET",
    ] {
        assert!(
            env.contains_key(name),
            "compose scan missed {name}: {env:?}"
        );
    }
    assert!(required.contains("GATEWAY_MASTER_KEY"), "{required:?}");
    // The identity secrets are optional on the self-host stack.
    for name in ["RYU_IDENTITY_ROOT", "RYU_IDENTITY_PEPPER"] {
        assert!(
            !required.contains(name),
            "{name} must not be required: {required:?}"
        );
    }
    for name in VAULT_SIGNALS {
        assert!(!env.contains_key(*name), "self-host compose sets {name}");
    }
    let custody = custody_of(&env);
    assert_eq!(custody, GatewayCustody::SelfHosted);
    assert!(
        fleet_flag_of(&env),
        "compose keeps the exposure hardening flag"
    );
    assert!(exposure_hardened(fleet_flag_of(&env), custody));
    // The startup rules main.rs applies to this env.
    assert!(crate::auth_disabled_startup_rejected(
        "0.0.0.0:7981",
        true,
        false
    ));
    assert!(crate::auth_disabled_startup_rejected(
        "127.0.0.1:7981",
        true,
        false
    ));
    assert!(!crate::auth_disabled_startup_rejected(
        "0.0.0.0:7981",
        true,
        true
    ));
    assert!(!crate::hosted_web_origin_allowed(
        None,
        false,
        custody.is_fleet()
    ));
    let identity = IdentityKeys::from_lookup(custody, |name| env.get(name).cloned())
        .expect("the self-host stack starts without identity secrets");
    assert!(!identity.has_pepper());
}

#[test]
fn probe_compose_env_with_a_vault_signal_is_fleet_and_needs_identity_secrets() {
    for (case, env) in [
        ("vault pair", vault_pair_env()),
        ("vault required", vault_required_env()),
        (
            "vault required on compose",
            with(compose_env(), &[("RYU_PROVIDER_VAULT_REQUIRED", "true")]),
        ),
    ] {
        let custody = custody_of(&env);
        assert_eq!(custody, GatewayCustody::Fleet, "{case}");
        // Fleet custody hardens exposure with or without the flag.
        assert!(exposure_hardened(false, custody), "{case}");
        assert!(
            crate::auth_disabled_startup_rejected(
                "127.0.0.1:7981",
                exposure_hardened(false, custody),
                false
            ),
            "{case}"
        );
        assert!(
            crate::hosted_web_origin_allowed(None, false, custody.is_fleet()),
            "{case}"
        );
        assert!(
            IdentityKeys::from_lookup(custody, |name| env.get(name).cloned()).is_err(),
            "{case}: the fleet must refuse to start without identity secrets"
        );
    }
}

#[test]
fn probe_images_set_no_custody_signal() {
    for (image, source) in [("root", ROOT_DOCKERFILE), ("gateway", GATEWAY_DOCKERFILE)] {
        for line in source.lines().map(str::trim) {
            let Some(rest) = line
                .strip_prefix("ENV ")
                .or_else(|| line.strip_prefix("ARG "))
            else {
                continue;
            };
            for name in VAULT_SIGNALS.iter().chain(&["RYU_GATEWAY_FLEET"]) {
                assert!(
                    !rest.contains(name),
                    "{image} Dockerfile bakes {name} into the image: {line}"
                );
            }
        }
    }
}

#[test]
fn probe_fleet_key_in_gateway_toml_is_the_exposure_flag_only() {
    let parsed: GatewayConfig =
        toml::from_str("fleet = true").expect("fleet parses from gateway.toml");
    assert!(parsed.fleet);
    // gateway.toml never reaches custody detection.
    let custody = custody_of(&compose_env());
    assert_eq!(custody, GatewayCustody::SelfHosted);
    assert!(exposure_hardened(parsed.fleet, custody));
}

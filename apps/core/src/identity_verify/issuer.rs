//! Which Better Auth issuer Core trusts for user JWTs.
//!
//! The issuer is the URL Core fetches signing keys from AND the value `iss` and
//! `aud` must equal, so trusting a loopback issuer means trusting whatever
//! process listens on that port. Loopback is therefore only trusted on a dev
//! Core: not managed, not enrolled, not registered, and listening on loopback.
//! Anywhere else Core refuses the issuer and every user JWT fails closed (the
//! caller is anonymous); the node token path is unaffected and Core still starts.

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

/// Fallback Better Auth base URL when no env override is set. Matches the
/// `BETTER_AUTH_URL` default in `packages/auth` (`http://localhost:3000`). The
/// JWT `iss`/`aud` are this BASE_URL, so JWKS-fetch and claim-validation MUST
/// resolve to the same value. A loopback control plane URL (its default is
/// `127.0.0.1:3000`) is never used in its place, because it would mismatch
/// `iss`/`aud` and deny every token on a dev Core.
pub(super) const DEFAULT_BASE_URL: &str = "http://localhost:3000";

/// Everything the issuer decision depends on, read from the process by
/// [`issuer_inputs_from_process`] and passed in so the rule is unit tested
/// without touching process environment.
#[derive(Debug, Default, Clone)]
pub(super) struct IssuerInputs {
    /// `RYU_AUTH_BASE_URL`, else `BETTER_AUTH_URL`: the operator named the issuer.
    pub(super) auth_base_url: Option<String>,
    /// `RYU_CONTROL_PLANE_URL`.
    pub(super) control_plane_env: Option<String>,
    /// The control plane URL saved with an acknowledged enrollment.
    pub(super) enrolled_control_plane: Option<String>,
    /// Managed (`RYU_MANAGED_NODE`), enrolled, or registered to an org.
    pub(super) node_bound: bool,
    /// Core listens beyond loopback (`--bind=`, then `RYU_BIND`).
    pub(super) bind_non_loopback: bool,
}

/// Where the trusted issuer came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum IssuerSource {
    AuthBaseUrl,
    ControlPlane,
    Enrollment,
    LoopbackDefault,
}

/// Why a loopback issuer was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct IssuerRefusal {
    pub(super) issuer: String,
    pub(super) reason: &'static str,
}

fn normalized(raw: Option<&str>) -> Option<String> {
    raw.map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
}

/// Whether a URL's host is the local machine. An unparsable URL is not loopback
/// here; the JWKS fetch rejects it later anyway.
pub(super) fn url_is_loopback(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(is_loopback_host))
        .unwrap_or(false)
}

/// The issuer candidate in precedence order, before the loopback rule: the
/// configured auth URL, then the control plane URL (environment, then the
/// enrolled one) when it is not loopback, then the loopback default. This is
/// the Gateway's precedence (`RYU_AUTH_BASE_URL`, else the control plane).
pub(super) fn issuer_candidate(inputs: &IssuerInputs) -> (String, IssuerSource) {
    if let Some(url) = normalized(inputs.auth_base_url.as_deref()) {
        return (url, IssuerSource::AuthBaseUrl);
    }
    let control_plane = [
        (&inputs.control_plane_env, IssuerSource::ControlPlane),
        (&inputs.enrolled_control_plane, IssuerSource::Enrollment),
    ];
    for (url, source) in control_plane {
        if let Some(url) = normalized(url.as_deref()).filter(|url| !url_is_loopback(url)) {
            return (url, source);
        }
    }
    (DEFAULT_BASE_URL.to_owned(), IssuerSource::LoopbackDefault)
}

/// Decide the issuer Core trusts, or refuse. A loopback issuer is refused on a
/// managed, enrolled or registered node whatever its source, and on a Core that
/// listens beyond loopback unless the operator set it explicitly with
/// `RYU_AUTH_BASE_URL` or `BETTER_AUTH_URL` (a self-hosted web app on the same
/// machine). Every other issuer is used as is; HTTPS is enforced at fetch time.
pub(super) fn decide_issuer(inputs: &IssuerInputs) -> Result<String, IssuerRefusal> {
    let (issuer, source) = issuer_candidate(inputs);
    if !url_is_loopback(&issuer) {
        return Ok(issuer);
    }
    let reason = if inputs.node_bound {
        "this Core is a managed, enrolled or registered node"
    } else if inputs.bind_non_loopback && source != IssuerSource::AuthBaseUrl {
        "this Core listens beyond loopback and no auth issuer is configured"
    } else {
        return Ok(issuer);
    };
    Err(IssuerRefusal { issuer, reason })
}

fn non_empty_env(name: &str) -> Option<String> {
    normalized(std::env::var(name).ok().as_deref())
}

/// The address Core listens on, resolved by the same chain as the listener in
/// `boot/sidecar_set.rs` (`--bind=`, then `RYU_BIND`). Empty means the
/// loopback default, which `server::host_is_non_loopback` treats as loopback.
fn listen_address() -> String {
    std::env::args()
        .skip(1)
        .find_map(|arg| arg.strip_prefix("--bind=").map(str::to_owned))
        .or_else(|| std::env::var("RYU_BIND").ok())
        .unwrap_or_default()
}

pub(super) fn issuer_inputs_from_process() -> IssuerInputs {
    let auth_base_url =
        non_empty_env("RYU_AUTH_BASE_URL").or_else(|| non_empty_env("BETTER_AUTH_URL"));
    let control_plane_env = non_empty_env("RYU_CONTROL_PLANE_URL");
    // The enrollment file is only read when nothing earlier names an issuer.
    let needs_enrollment =
        auth_base_url.is_none() && control_plane_env.as_deref().map_or(true, url_is_loopback);
    IssuerInputs {
        auth_base_url,
        control_plane_env,
        enrolled_control_plane: if needs_enrollment {
            crate::fleet::enrolled_control_plane_url()
        } else {
            None
        },
        node_bound: crate::sidecar::node_binding::node_expects_binding()
            || crate::sidecar::control_plane::registered_node().is_some(),
        bind_non_loopback: crate::server::host_is_non_loopback(&listen_address()),
    }
}

/// Set once by [`pin_test_issuer`] so tests that sign their own tokens keep the
/// issuer they signed with, whatever node binding the test runs under.
#[cfg(test)]
static TEST_PINNED_ISSUER: OnceLock<String> = OnceLock::new();

#[cfg(test)]
pub(super) fn pin_test_issuer() -> String {
    TEST_PINNED_ISSUER
        .get_or_init(|| DEFAULT_BASE_URL.to_owned())
        .clone()
}

/// The Better Auth BASE_URL used for the JWKS endpoint, the token exchange AND
/// `iss`/`aud` validation; one resolver keeps them consistent. A refused issuer
/// is an [`AuthError::UntrustedIssuer`] and is logged once per process.
pub(super) fn trusted_issuer() -> Result<String, AuthError> {
    #[cfg(test)]
    if let Some(pinned) = TEST_PINNED_ISSUER.get() {
        return Ok(pinned.clone());
    }
    decide_issuer(&issuer_inputs_from_process()).map_err(|refusal| {
        static LOGGED: AtomicBool = AtomicBool::new(false);
        if !LOGGED.swap(true, Ordering::Relaxed) {
            tracing::error!(
                issuer = %refusal.issuer,
                "refusing the loopback identity issuer because {}; user JWTs will not \
                 verify until RYU_AUTH_BASE_URL is set to the hosted auth URL",
                refusal.reason
            );
        }
        AuthError::UntrustedIssuer(refusal.issuer)
    })
}

/// True for hosts that resolve to the local machine, where plain HTTP is
/// acceptable (dev). Everything else must use HTTPS for the JWKS fetch.
pub(super) fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    if h.eq_ignore_ascii_case("localhost") {
        return true;
    }
    h.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOSTED: &str = "https://auth.example.com";

    fn dev() -> IssuerInputs {
        IssuerInputs::default()
    }

    #[test]
    fn a_dev_core_on_loopback_keeps_the_loopback_default() {
        assert_eq!(decide_issuer(&dev()), Ok(DEFAULT_BASE_URL.to_owned()));
        // The control plane's own loopback default never replaces it.
        let loopback_control_plane = IssuerInputs {
            control_plane_env: Some("http://127.0.0.1:3000".into()),
            ..dev()
        };
        assert_eq!(
            decide_issuer(&loopback_control_plane),
            Ok(DEFAULT_BASE_URL.to_owned())
        );
    }

    #[test]
    fn a_non_loopback_bind_without_a_configured_issuer_is_refused() {
        let exposed = IssuerInputs {
            bind_non_loopback: true,
            ..dev()
        };
        let refusal = decide_issuer(&exposed).unwrap_err();
        assert_eq!(refusal.issuer, DEFAULT_BASE_URL);
        assert!(refusal.reason.contains("beyond loopback"));
        let loopback_control_plane = IssuerInputs {
            control_plane_env: Some("http://localhost:3000/".into()),
            ..exposed
        };
        assert!(decide_issuer(&loopback_control_plane).is_err());
    }

    #[test]
    fn a_managed_enrolled_or_registered_node_refuses_any_loopback_issuer() {
        let bound = IssuerInputs {
            node_bound: true,
            ..dev()
        };
        assert!(decide_issuer(&bound)
            .unwrap_err()
            .reason
            .contains("managed"));
        for configured in [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
        ] {
            let explicit = IssuerInputs {
                auth_base_url: Some(configured.into()),
                ..bound.clone()
            };
            assert!(decide_issuer(&explicit).is_err(), "{configured}");
        }
    }

    #[test]
    fn a_configured_issuer_is_used_and_wins_over_the_control_plane() {
        let exposed_and_bound = IssuerInputs {
            node_bound: true,
            bind_non_loopback: true,
            ..dev()
        };
        for inputs in [dev(), exposed_and_bound] {
            let configured = IssuerInputs {
                auth_base_url: Some(format!("{HOSTED}/")),
                control_plane_env: Some("https://cp.example.com".into()),
                ..inputs
            };
            assert_eq!(decide_issuer(&configured), Ok(HOSTED.to_owned()));
        }
        // A self-hosted web app beside an exposed but unbound Core stays allowed
        // when the operator names it explicitly.
        let self_hosted = IssuerInputs {
            auth_base_url: Some("http://localhost:3000".into()),
            bind_non_loopback: true,
            ..dev()
        };
        assert_eq!(decide_issuer(&self_hosted), Ok(DEFAULT_BASE_URL.to_owned()));
    }

    #[test]
    fn the_control_plane_url_is_the_fallback_environment_first() {
        let both = IssuerInputs {
            control_plane_env: Some("https://cp.example.com/".into()),
            enrolled_control_plane: Some("https://enrolled.example.com".into()),
            node_bound: true,
            bind_non_loopback: true,
            ..dev()
        };
        assert_eq!(
            issuer_candidate(&both),
            (
                "https://cp.example.com".to_owned(),
                IssuerSource::ControlPlane
            )
        );
        let enrolled_only = IssuerInputs {
            control_plane_env: None,
            ..both.clone()
        };
        assert_eq!(
            decide_issuer(&enrolled_only),
            Ok("https://enrolled.example.com".to_owned())
        );
        // A loopback control plane in the environment does not hide the enrollment.
        let loopback_env = IssuerInputs {
            control_plane_env: Some("http://127.0.0.1:3000".into()),
            ..both
        };
        assert_eq!(issuer_candidate(&loopback_env).1, IssuerSource::Enrollment);
    }

    #[test]
    fn a_refused_issuer_is_an_untrusted_issuer_error() {
        let message = AuthError::UntrustedIssuer(DEFAULT_BASE_URL.into()).to_string();
        assert!(message.contains("untrusted identity issuer"), "{message}");
        assert!(url_is_loopback("http://LOCALHOST:3000"));
        assert!(!url_is_loopback(HOSTED));
        assert!(!url_is_loopback("not a url"));
    }
}

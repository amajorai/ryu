use super::*;

#[test]
fn failed_proxy_does_not_open_the_upstream_provider_circuit() {
    assert!(!penalizes_provider_circuit(
        &GatewayError::ProviderTransport("proxy unavailable".to_owned())
    ));
    assert!(penalizes_provider_circuit(&GatewayError::ProviderError(
        "upstream server failed".to_owned()
    )));
}

#[test]
fn a_rejected_request_does_not_open_the_shared_provider_circuit() {
    // One tenant's malformed requests must not cut the provider off for
    // every other tenant on the node.
    assert!(!penalizes_provider_circuit(&GatewayError::from(
        ryu_gw_providers::ProviderError::Rejected {
            status: 400,
            message: "openai error 400 Bad Request: invalid max_tokens".to_owned(),
        }
    )));
}

fn rejected(status: u16) -> GatewayError {
    GatewayError::ProviderRejected {
        status,
        message: format!("upstream error {status} forbidden"),
        signal: None,
    }
}

#[test]
fn only_genuine_upstream_health_faults_open_the_circuit() {
    // Genuine health faults: a 5xx, a 408 or an unreadable reply, and a
    // credential the upstream no longer accepts.
    assert!(penalizes_provider_circuit(&GatewayError::ProviderError(
        "anthropic error 503".to_owned()
    )));
    assert!(penalizes_provider_circuit(&GatewayError::from(
        ryu_gw_providers::ProviderError::Provider("openai error 408".to_owned())
    )));
    assert!(penalizes_provider_circuit(&rejected(401)));
    // Never a health signal, whatever the message says. The same predicate
    // gates pool-member demotion in the auxiliary dispatcher, where the
    // inbound rate limiter and the model allowlist can fail a leg.
    let never = [
        GatewayError::FirewallBlocked("Inbound content blocked".to_owned(), None),
        GatewayError::PolicyViolation("model not approved".to_owned()),
        GatewayError::PlatformRefused {
            code: "feature_not_permitted",
            message: "This feature is not permitted on the hosted Gateway.",
        },
        GatewayError::RateLimited,
        rejected(400),
        rejected(403),
        rejected(404),
        rejected(451),
        GatewayError::ProviderRateLimited {
            provider: "openai".to_owned(),
            retry_after: None,
            reset_at: None,
        },
        GatewayError::ProviderPaymentRequired {
            provider: "openrouter".to_owned(),
            message: "no credits".to_owned(),
        },
        GatewayError::ProviderTransport("proxy unavailable".to_owned()),
        GatewayError::ProviderDeliveryUncertain("timed out".to_owned()),
        GatewayError::Overloaded("engine busy".to_owned()),
        GatewayError::BudgetExceeded(None),
        GatewayError::InsufficientCredits,
        GatewayError::Internal(anyhow::anyhow!("tool loop failed")),
    ];
    for error in never {
        assert!(!penalizes_provider_circuit(&error), "{error:?}");
    }
}

#[test]
fn the_fleet_and_managed_nodes_end_the_chain_on_an_upstream_refusal() {
    let payment = || GatewayError::ProviderPaymentRequired {
        provider: "openrouter".to_owned(),
        message: "no credits".to_owned(),
    };
    let mut state = AppState::new_for_test_default();
    for status in [400, 401, 403, 404, 422] {
        assert!(!ends_attempt_chain(&state, &rejected(status)), "{status}");
    }
    assert!(!ends_attempt_chain(&state, &payment()));
    for custody in [
        crate::custody::GatewayCustody::ManagedNode,
        crate::custody::GatewayCustody::Fleet,
    ] {
        state.custody = custody;
        for status in [400, 401, 403, 404, 422] {
            assert!(
                ends_attempt_chain(&state, &rejected(status)),
                "{custody:?} {status}"
            );
        }
        assert!(ends_attempt_chain(&state, &payment()), "{custody:?} 402");
        for moves_on in [
            GatewayError::ProviderError("anthropic error 500".to_owned()),
            GatewayError::ProviderTransport("connection failed".to_owned()),
            GatewayError::ProviderRateLimited {
                provider: "openai".to_owned(),
                retry_after: Some(1),
                reset_at: None,
            },
            GatewayError::CircuitOpen("openai".to_owned()),
        ] {
            assert!(
                !ends_attempt_chain(&state, &moves_on),
                "{custody:?} {moves_on:?}"
            );
        }
    }
}

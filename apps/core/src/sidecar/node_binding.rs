//! Whether this node is MEANT to be bound to an organization, from persisted
//! enrollment state rather than from whether registration currently succeeds.
//!
//! `control_plane::registered_org()` is a reachability answer: it is `None` in the
//! window after every boot, during a control-plane outage, and after the control
//! plane rejects or revokes the node credential. An enrolled (v2 fleet)
//! self-hosted node is not flagged `RYU_MANAGED_NODE`, so treating "not registered"
//! as "unbound personal node" would hand every paired client the single-owner
//! policy and with it every member's private memory and Space chunks. The access
//! gates ask [`node_expects_binding`] instead, so an enrolled node that has lost
//! its registration fails closed until the binding resolves again.

use crate::sidecar::control_plane;

/// Whether this node must be org-bound before any per-member policy can admit a
/// caller: a managed node, or a node with a persisted enrollment (the v2 bundle,
/// pending or acknowledged, or the fleet identity it produced). Only removing that
/// local enrollment state returns the node to unbound-personal semantics; a
/// control-plane error never does.
pub fn node_expects_binding() -> bool {
    control_plane::is_managed_node() || enrollment_persisted()
}

/// Whether per-member tenancy filters must apply: the node is registered to an
/// org, or it expects to be. With no registered org the bound filters see a
/// caller with no matching org, so only the shared node/project brain survives.
pub fn node_bound_for_tenancy() -> bool {
    control_plane::registered_org().is_some() || node_expects_binding()
}

/// The node expects a binding it does not currently have (registration pending,
/// failed, or revoked).
pub fn binding_unresolved() -> bool {
    control_plane::registered_org().is_none() && node_expects_binding()
}

fn enrollment_persisted() -> bool {
    #[cfg(test)]
    {
        // Tests never read the shared data dir's enrollment files: they declare
        // the enrollment state per task, so parallel tests cannot leak into
        // each other.
        TEST_ENROLLMENT_PERSISTED
            .try_with(|persisted| *persisted)
            .unwrap_or(false)
    }
    #[cfg(not(test))]
    {
        crate::fleet::has_persisted_enrollment()
    }
}

#[cfg(test)]
tokio::task_local! {
    static TEST_ENROLLMENT_PERSISTED: bool;
}

/// Run `fut` as if this node did (or did not) hold a persisted enrollment.
#[cfg(test)]
pub(crate) async fn with_test_enrollment<F: std::future::Future>(
    persisted: bool,
    fut: F,
) -> F::Output {
    TEST_ENROLLMENT_PERSISTED.scope(persisted, fut).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_enrolled_node_without_registration_still_expects_a_binding() {
        let (expects, bound, unresolved) = control_plane::with_test_node_binding(
            false,
            None,
            with_test_enrollment(true, async {
                (
                    node_expects_binding(),
                    node_bound_for_tenancy(),
                    binding_unresolved(),
                )
            }),
        )
        .await;
        assert!(expects);
        assert!(bound);
        assert!(unresolved);
    }

    #[tokio::test]
    async fn a_plain_personal_node_stays_unbound() {
        let (expects, bound, unresolved) = control_plane::with_test_node_binding(
            false,
            None,
            with_test_enrollment(false, async {
                (
                    node_expects_binding(),
                    node_bound_for_tenancy(),
                    binding_unresolved(),
                )
            }),
        )
        .await;
        assert!(!expects);
        assert!(!bound);
        assert!(!unresolved);
    }

    #[tokio::test]
    async fn a_managed_node_expects_a_binding_without_enrollment_files() {
        let expects =
            control_plane::with_test_node_binding(true, None, async { node_expects_binding() })
                .await;
        assert!(expects);
    }
}

//! Policy-required response wrapping.
//!
//! An allow rule may carry `minWrappingTtlSecs` and `maxWrappingTtlSecs`
//! (Vault's `min_wrapping_ttl` / `max_wrapping_ttl`). A minimum means a vault
//! API request using one of the rule's capabilities on a matching path must
//! ask for a wrapped response (`X-Ryu-Wrap-TTL`) of at least that TTL; a
//! maximum caps the TTL a wrapped request may ask for.
//!
//! Requirements are enforced only inside a vault API request, which
//! `request_layer` opens with [`scope`] and the request's wrap TTL. There,
//! [`super::evaluate_with`] drops an unsatisfied capability (fail closed, so
//! every route's own check refuses it) and records a [`Violation`] that the
//! layer turns into a `vault_wrapping_required` error. Outside a request (a
//! tool-time `use` resolution or the broker injecting a credential upstream)
//! nothing is returned to the caller, so there is nothing to wrap.
//!
//! The scope belongs to the request's caller. A check of another principal's
//! recorded authority inside that request (a change requester re-checked at
//! approval) runs under [`suspended`], so the caller's wrap TTL neither drops
//! that principal's capabilities nor records violations against the caller.
//!
//! When several matching rules constrain one capability, the strictest bound
//! wins: the largest minimum and the smallest maximum.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::future::Future;

use anyhow::{bail, Result};
use serde::{Deserialize, Deserializer};

use super::{Capability, CapabilitySet, PolicyRule};
use crate::vault::wrapping::{parse_wrap_ttl, MAX_WRAP_TTL_SECS, MIN_WRAP_TTL_SECS};

/// The merged wrap TTL bounds on one capability.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Bounds {
    pub min_secs: Option<i64>,
    pub max_secs: Option<i64>,
}

impl Bounds {
    fn merge(&mut self, rule: &PolicyRule) {
        if let Some(min) = rule.min_wrapping_ttl_secs {
            self.min_secs = Some(self.min_secs.map_or(min, |current| current.max(min)));
        }
        if let Some(max) = rule.max_wrapping_ttl_secs {
            self.max_secs = Some(self.max_secs.map_or(max, |current| current.min(max)));
        }
    }

    /// Whether a request asking for `requested` (seconds, `None` = not
    /// wrapped) meets these bounds.
    pub fn satisfied_by(&self, requested: Option<i64>) -> bool {
        let min_ok = self
            .min_secs
            .is_none_or(|min| requested.is_some_and(|ttl| ttl >= min));
        let max_ok = self
            .max_secs
            .is_none_or(|max| requested.is_none_or(|ttl| ttl <= max));
        min_ok && max_ok
    }
}

/// A capability a request lost because its wrap TTL did not meet a rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    /// The policy key (`ENV/folder/NAME` or `sys/...`).
    pub path: String,
    pub capability: Capability,
    pub bounds: Bounds,
}

impl Violation {
    /// A caller-facing explanation. Names the path and bounds, never a value.
    pub fn message(&self) -> String {
        let need = match (self.bounds.min_secs, self.bounds.max_secs) {
            (Some(min), Some(max)) if min > max => {
                "a wrap TTL no policy allows (the matching rules conflict)".to_owned()
            }
            (Some(min), Some(max)) => format!("a wrap TTL between {min}s and {max}s"),
            (Some(min), None) => format!("a wrap TTL of at least {min}s"),
            (None, Some(max)) => format!("a wrap TTL of at most {max}s"),
            (None, None) => "a wrapped response".to_owned(),
        };
        format!(
            "`{}` on `{}` requires a wrapped response: send X-Ryu-Wrap-TTL with {need}",
            self.capability.as_str(),
            self.path
        )
    }
}

/// Wrapping bounds collected from the rules matching one path.
#[derive(Debug, Default)]
pub struct Requirements(BTreeMap<Capability, Bounds>);

impl Requirements {
    /// Add a matching rule. Deny rules and rules without bounds add nothing.
    pub fn add(&mut self, rule: &PolicyRule) {
        if rule.deny
            || (rule.min_wrapping_ttl_secs.is_none() && rule.max_wrapping_ttl_secs.is_none())
        {
            return;
        }
        for capability in &rule.capabilities {
            self.0.entry(*capability).or_default().merge(rule);
        }
    }

    /// Drop from `allowed` every capability whose bounds the current request
    /// does not meet, recording a violation for each. A no-op outside
    /// [`scope`].
    pub fn enforce(&self, path: &str, allowed: &mut CapabilitySet) {
        if self.0.is_empty() || SUSPENDED.with(Cell::get) > 0 {
            return;
        }
        let _ = REQUEST.try_with(|request| {
            for (capability, bounds) in &self.0 {
                if !allowed.contains(capability) || bounds.satisfied_by(request.ttl_secs) {
                    continue;
                }
                allowed.remove(capability);
                let violation = Violation {
                    path: path.to_owned(),
                    capability: *capability,
                    bounds: *bounds,
                };
                let mut violations = request.violations.borrow_mut();
                if violations.len() < MAX_VIOLATIONS && !violations.contains(&violation) {
                    violations.push(violation);
                }
            }
        });
    }
}

/// Violations kept per request; a listing may evaluate many keys.
const MAX_VIOLATIONS: usize = 32;

struct Request {
    ttl_secs: Option<i64>,
    violations: RefCell<Vec<Violation>>,
}

tokio::task_local! {
    static REQUEST: Request;
}

thread_local! {
    /// Depth of [`suspended`] calls on this thread. A thread-local (not a
    /// task-local) is enough because `suspended` takes a synchronous closure:
    /// no await point can move the task to another thread inside it.
    static SUSPENDED: Cell<u32> = const { Cell::new(0) };
}

/// Run `check` with wrapping requirements not enforced, for a policy check of
/// a principal other than the current request's caller. Requirements bind the
/// caller's own response; they say nothing about another principal's
/// authority.
pub fn suspended<R>(check: impl FnOnce() -> R) -> R {
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            SUSPENDED.with(|depth| depth.set(depth.get() - 1));
        }
    }
    SUSPENDED.with(|depth| depth.set(depth.get() + 1));
    let _restore = Restore;
    check()
}

/// Run `future` as one vault API request asking for a wrapped response of
/// `ttl_secs` (`None` = not wrapped). Returns its output and the wrapping
/// violations its policy checks recorded.
pub async fn scope<F: Future>(ttl_secs: Option<i64>, future: F) -> (F::Output, Vec<Violation>) {
    let request = Request {
        ttl_secs,
        violations: RefCell::new(Vec::new()),
    };
    REQUEST
        .scope(request, async move {
            let output = future.await;
            let violations = REQUEST.with(|request| request.violations.take());
            (output, violations)
        })
        .await
}

/// Validate a rule's wrapping bounds.
pub fn validate_rule(rule: &PolicyRule) -> Result<()> {
    let (min, max) = (rule.min_wrapping_ttl_secs, rule.max_wrapping_ttl_secs);
    if min.is_none() && max.is_none() {
        return Ok(());
    }
    if rule.deny {
        bail!("deny rule `{}` cannot carry wrapping TTLs", rule.path);
    }
    for ttl in [min, max].into_iter().flatten() {
        if !(MIN_WRAP_TTL_SECS..=MAX_WRAP_TTL_SECS).contains(&ttl) {
            bail!(
                "rule `{}`: wrapping TTLs must be between {MIN_WRAP_TTL_SECS}s and {MAX_WRAP_TTL_SECS}s",
                rule.path
            );
        }
    }
    if let (Some(min), Some(max)) = (min, max) {
        if min > max {
            bail!(
                "rule `{}`: minWrappingTtlSecs exceeds maxWrappingTtlSecs",
                rule.path
            );
        }
    }
    Ok(())
}

/// Deserialize a wrapping TTL given as seconds (`300`) or a duration string
/// (`"300"`, `"300s"`, `"5m"`, `"1h"`).
pub fn deserialize_ttl<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Ttl {
        Secs(i64),
        Text(String),
    }
    match Option::<Ttl>::deserialize(deserializer)? {
        None => Ok(None),
        Some(Ttl::Secs(secs)) => Ok(Some(secs)),
        Some(Ttl::Text(text)) => parse_wrap_ttl(&text)
            .map(Some)
            .map_err(|_| serde::de::Error::custom(format!("invalid wrapping TTL `{text}`"))),
    }
}

#[cfg(test)]
#[path = "wrap_requirement_tests.rs"]
mod tests;

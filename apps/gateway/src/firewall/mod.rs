// The pure regex detection engine — the curated pattern builders, the
// `DetectionKind` / `FirewallMatch` scan types, the Unicode-normalization
// pre-pass, and the Luhn / credit-card / public-IPv4 validators — plus the
// command-injection scanner were extracted to the `ryu-gw-firewall` crate
// ("engine moves, wiring stays"). `FirewallScanner`, `FirewallBackend`, and
// `FirewallRegistry` (which hold `FirewallConfig` and drive the alert/inspector/
// evaluator config cascade) stay here and consume the crate. `DetectionKind` /
// `FirewallMatch` are re-exported so existing `crate::firewall::…` paths
// (inline_eval, evaluators) resolve unchanged; the command scanner is re-exported
// as `crate::firewall::cmdscan`.
//
// The wiring is split by responsibility: `scanner` (construction and detection
// scans), `redaction` (config-gated `sanitize` and the unconditional outbound
// scrubber), `companion` (companion egress), `curated` (the shared curated
// pattern sets) and `backend` (the swappable backend trait and its registry).
// Everything is re-exported below, so `crate::firewall::…` paths are unchanged.
pub use ryu_gw_firewall::cmdscan;
pub use ryu_gw_firewall::{DetectionKind, FirewallMatch};

mod backend;
mod companion;
mod curated;
pub mod inspector;
mod redaction;
pub mod resolve;
mod scanner;

pub use backend::{FirewallBackend, FirewallRegistry};
pub(crate) use scanner::custom_pattern_compiles;
pub use scanner::FirewallScanner;

// The firewall tests reach the scanner internals and the config types through
// `use super::*`.
#[cfg(test)]
use crate::config::{CustomPatternKind, FirewallConfig, FirewallPolicy};

#[cfg(test)]
mod backend_tests;
#[cfg(test)]
mod companion_tests;
#[cfg(test)]
mod custom_unicode_tests;
#[cfg(test)]
mod detection_tests;
#[cfg(test)]
mod tests;

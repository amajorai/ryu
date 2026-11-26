//! The protocol number the desktop, Core and the Gateway speak to each other.
//!
//! It is separate from the release version. A release bumps the version every
//! time; the protocol number moves only when the calls between the desktop,
//! Core and the Gateway change in a way an older part cannot follow. Each side
//! states the oldest and the newest protocol it speaks, both sides pick the
//! highest number they share, and when they share none the answer names the
//! side that has to update.
//!
//! The TypeScript copy is `packages/core-client/src/protocol.ts`.
//! `tools/protocol-range-contract.test.mjs` fails when the two differ.

/// Oldest protocol this build still speaks.
pub const PROTOCOL_MIN: u32 = 1;
/// Newest protocol this build speaks.
pub const PROTOCOL_MAX: u32 = 1;
/// What a part counts as when it is too old to report a range.
pub const LEGACY_PROTOCOL: u32 = 0;
/// Oldest Core protocol a client (desktop, web, mobile, CLI, extension) still
/// accepts. It stays at the legacy protocol in the first release that reports a
/// range, so an app update never locks a user out of a Core that is one
/// release behind.
pub const CLIENT_ACCEPTS_MIN: u32 = 0;

/// The oldest and the newest protocol one side speaks, both included.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProtocolRange {
    pub min: u32,
    pub max: u32,
}

impl ProtocolRange {
    /// What Core and the Gateway report and accept from each other.
    pub const CURRENT: Self = Self::new(PROTOCOL_MIN, PROTOCOL_MAX);
    /// A part that reports no range.
    pub const LEGACY: Self = Self::new(LEGACY_PROTOCOL, LEGACY_PROTOCOL);
    /// What a client accepts from the Core it talks to.
    pub const CLIENT_ACCEPTS: Self = Self::new(CLIENT_ACCEPTS_MIN, PROTOCOL_MAX);

    pub const fn new(min: u32, max: u32) -> Self {
        Self { min, max }
    }

    /// The range in a `/api/health` body (`"protocol": {"min": 1, "max": 1}`).
    /// A body without the field, or with a range that is not two whole numbers
    /// in order, is a part that predates the protocol number.
    pub fn from_health(body: &serde_json::Value) -> Self {
        let field = |name: &str| {
            body.get("protocol")
                .and_then(|range| range.get(name))
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
        };
        match (field("min"), field("max")) {
            (Some(min), Some(max)) if min <= max => Self::new(min, max),
            _ => Self::LEGACY,
        }
    }
}

impl std::fmt::Display for ProtocolRange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.min == self.max {
            write!(f, "{}", self.min)
        } else {
            write!(f, "{} to {}", self.min, self.max)
        }
    }
}

/// The side that has to update before the two can talk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateSide {
    /// This build is too old for the other side.
    Local,
    /// The other side is too old for this build.
    Remote,
}

/// The two sides share no protocol number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoSharedProtocol {
    pub local: ProtocolRange,
    pub remote: ProtocolRange,
    pub update: UpdateSide,
}

impl NoSharedProtocol {
    /// One sentence for a log line or an error, naming both sides and the one
    /// to update, for example `describe("Core", "the Gateway")`.
    pub fn describe(&self, local_name: &str, remote_name: &str) -> String {
        let outdated = match self.update {
            UpdateSide::Local => local_name,
            UpdateSide::Remote => remote_name,
        };
        format!(
            "no shared protocol: {local_name} speaks protocol {}, {remote_name} speaks protocol {}; update {outdated}",
            self.local, self.remote
        )
    }
}

/// Pick the highest protocol both sides speak.
///
/// With no shared number the older side is the one to update: the side whose
/// newest protocol is below the other side's oldest.
pub fn negotiate(local: ProtocolRange, remote: ProtocolRange) -> Result<u32, NoSharedProtocol> {
    let lowest = local.min.max(remote.min);
    let highest = local.max.min(remote.max);
    if lowest <= highest {
        return Ok(highest);
    }
    let update = if remote.max < local.min {
        UpdateSide::Remote
    } else {
        UpdateSide::Local
    };
    Err(NoSharedProtocol {
        local,
        remote,
        update,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(min: u32, max: u32) -> ProtocolRange {
        ProtocolRange::new(min, max)
    }

    #[test]
    fn equal_ranges_pick_their_newest_protocol() {
        assert_eq!(negotiate(range(1, 1), range(1, 1)), Ok(1));
        assert_eq!(negotiate(range(2, 4), range(2, 4)), Ok(4));
    }

    #[test]
    fn overlapping_ranges_pick_the_highest_shared_protocol() {
        assert_eq!(negotiate(range(1, 3), range(2, 5)), Ok(3));
        assert_eq!(negotiate(range(2, 5), range(1, 3)), Ok(3));
        assert_eq!(negotiate(range(1, 5), range(3, 3)), Ok(3));
    }

    #[test]
    fn a_remote_below_the_local_range_names_the_remote() {
        let refused = negotiate(range(3, 4), range(1, 2)).unwrap_err();
        assert_eq!(refused.update, UpdateSide::Remote);
        assert_eq!(refused.local, range(3, 4));
        assert_eq!(refused.remote, range(1, 2));
        assert_eq!(
            refused.describe("Core", "the Gateway"),
            "no shared protocol: Core speaks protocol 3 to 4, the Gateway speaks protocol 1 to 2; update the Gateway"
        );
    }

    #[test]
    fn a_remote_above_the_local_range_names_the_local_side() {
        let refused = negotiate(range(1, 2), range(3, 4)).unwrap_err();
        assert_eq!(refused.update, UpdateSide::Local);
        assert_eq!(
            refused.describe("this app", "Core"),
            "no shared protocol: this app speaks protocol 1 to 2, Core speaks protocol 3 to 4; update this app"
        );
    }

    #[test]
    fn a_legacy_part_is_protocol_zero() {
        // A client still accepts it in this release.
        assert_eq!(
            negotiate(ProtocolRange::CLIENT_ACCEPTS, ProtocolRange::LEGACY),
            Ok(LEGACY_PROTOCOL)
        );
        // Core and the Gateway do not accept it from each other.
        let refused = negotiate(ProtocolRange::CURRENT, ProtocolRange::LEGACY).unwrap_err();
        assert_eq!(refused.update, UpdateSide::Remote);
    }

    #[test]
    fn a_client_picks_the_current_protocol_from_a_current_core() {
        assert_eq!(
            negotiate(ProtocolRange::CLIENT_ACCEPTS, ProtocolRange::CURRENT),
            Ok(PROTOCOL_MAX)
        );
    }

    #[test]
    fn the_constants_form_valid_ranges() {
        assert!(PROTOCOL_MIN <= PROTOCOL_MAX);
        assert!(CLIENT_ACCEPTS_MIN <= PROTOCOL_MIN);
        assert!(LEGACY_PROTOCOL < PROTOCOL_MIN);
        assert_eq!(ProtocolRange::CURRENT, range(PROTOCOL_MIN, PROTOCOL_MAX));
    }

    #[test]
    fn health_bodies_without_a_usable_range_are_legacy() {
        let current = serde_json::json!({"protocol": {"min": 1, "max": 2}});
        assert_eq!(ProtocolRange::from_health(&current), range(1, 2));
        for body in [
            serde_json::json!({"status": "ok", "version": "0.5.1"}),
            serde_json::json!({"protocol": null}),
            serde_json::json!({"protocol": {"min": 1}}),
            serde_json::json!({"protocol": {"min": 3, "max": 2}}),
            serde_json::json!({"protocol": {"min": "1", "max": "1"}}),
            serde_json::json!({"protocol": {"min": -1, "max": 1}}),
            serde_json::json!("not an object"),
        ] {
            assert_eq!(
                ProtocolRange::from_health(&body),
                ProtocolRange::LEGACY,
                "{body}"
            );
        }
    }

    #[test]
    fn a_range_serializes_as_min_and_max() {
        let value = serde_json::to_value(ProtocolRange::CURRENT).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"min": PROTOCOL_MIN, "max": PROTOCOL_MAX})
        );
        assert_eq!(
            ProtocolRange::from_health(&serde_json::json!({"protocol": value})),
            ProtocolRange::CURRENT
        );
    }
}

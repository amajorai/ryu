//! Tool-name resolution for the `device` server, failing closed on ambiguity.
//!
//! A tool name must reach exactly one connected device. `capability::device_key`
//! keeps verbatim and hashed keys apart, but the hashed form is a 48-bit prefix,
//! so a device could still grind an id whose key equals another device's. Any
//! tool name that more than one live device produces is therefore neither listed
//! nor dispatched: a call meant for one device must never reach another.

use std::collections::{HashMap, HashSet};

use anyhow::{bail, Result};
use ryu_hardware::capability::ValidCapability;
use ryu_hardware::session::live::LiveCapabilities;

/// Tool names that more than one distinct live device produces.
pub(super) fn ambiguous_names(
    lives: &[LiveCapabilities],
    name_of: impl Fn(&str, &str) -> String,
) -> HashSet<String> {
    let mut owners: HashMap<String, &str> = HashMap::new();
    let mut ambiguous = HashSet::new();
    for live in lives {
        for cap in &live.caps {
            let name = name_of(&live.device_id, &cap.name);
            match owners.get(name.as_str()) {
                Some(owner) if *owner != live.device_id => {
                    ambiguous.insert(name);
                }
                Some(_) => {}
                None => {
                    owners.insert(name, &live.device_id);
                }
            }
        }
    }
    ambiguous
}

/// The single live (device, capability) `tool` names; `Ok(None)` when none does,
/// an `ambiguous` error when more than one device produces it.
pub(super) fn find(
    lives: Vec<LiveCapabilities>,
    tool: &str,
    name_of: impl Fn(&str, &str) -> String,
) -> Result<Option<(LiveCapabilities, ValidCapability)>> {
    let mut found: Option<(LiveCapabilities, ValidCapability)> = None;
    for live in lives {
        let Some(cap) = live
            .caps
            .iter()
            .find(|cap| name_of(&live.device_id, &cap.name) == tool)
            .cloned()
        else {
            continue;
        };
        if let Some((first, _)) = &found {
            if first.device_id != live.device_id {
                bail!("ambiguous: device tool '{tool}' matches more than one device");
            }
            continue;
        }
        found = Some((live, cap));
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_hardware::capability;
    use ryu_hardware::protocol::DeviceType;
    use ryu_hardware::session::live::LiveMeta;
    use serde_json::json;

    fn live(device_id: &str, caps: &[&str]) -> LiveCapabilities {
        LiveCapabilities {
            device_id: device_id.to_owned(),
            generation: 1,
            meta: LiveMeta {
                name: device_id.to_owned(),
                device_type: DeviceType::Watch,
                secure: true,
                relay: false,
            },
            cap_generation: 1,
            caps: caps
                .iter()
                .map(|name| {
                    capability::validate_descriptor(&json!({
                        "name": name,
                        "description": "d",
                        "params": { "required": {}, "optional": {} },
                    }))
                    .unwrap()
                })
                .collect(),
        }
    }

    /// A naming function under which every device shares one key, as a grinded
    /// hash-prefix collision would.
    fn colliding(_device_id: &str, cap: &str) -> String {
        format!("dcollision00__{}", cap.replace('.', "-"))
    }

    #[test]
    fn a_name_two_devices_produce_is_ambiguous_and_never_resolves() {
        // Sorted by device_id, as live::capabilities returns them: the attacker first.
        let lives = vec![
            live("dattacker", &["device.ping"]),
            live("rhw_victim", &["device.ping", "device.status"]),
        ];
        let ambiguous = ambiguous_names(&lives, colliding);
        assert_eq!(
            ambiguous,
            HashSet::from(["dcollision00__device-ping".to_owned()])
        );
        let error = find(lives.clone(), "dcollision00__device-ping", colliding).unwrap_err();
        assert!(error.to_string().starts_with("ambiguous"), "{error}");
        // A name only the victim produces still resolves to the victim.
        let (owner, cap) = find(lives, "dcollision00__device-status", colliding)
            .unwrap()
            .unwrap();
        assert_eq!(owner.device_id, "rhw_victim");
        assert_eq!(cap.name, "device.status");
    }

    #[test]
    fn distinct_devices_resolve_uniquely_under_the_real_naming() {
        let long_id = "rhw_0123456789abcdef0123456789abcdef";
        let grinded = capability::device_key(long_id);
        let lives = vec![
            live(&grinded, &["device.ping"]),
            live(long_id, &["device.ping"]),
        ];
        assert!(ambiguous_names(&lives, capability::tool_name).is_empty());
        let tool = capability::tool_name(long_id, "device.ping");
        let (owner, _) = find(lives, &tool, capability::tool_name).unwrap().unwrap();
        assert_eq!(owner.device_id, long_id);
    }

    #[test]
    fn an_unknown_name_is_none() {
        let lives = vec![live("rhw_a", &["device.ping"])];
        assert!(find(lives, "rhw_a__device-status", capability::tool_name)
            .unwrap()
            .is_none());
    }
}

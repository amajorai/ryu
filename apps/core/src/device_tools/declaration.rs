//! `client_device`: what a phone declares on a chat request or a presence
//! lease. Declarations are routing hints only (design §1.2): the phone checks
//! OS authorization again before it runs, and Core caps every field.

use serde::{Deserialize, Serialize};

use super::catalog::{catalog, CATALOG_VERSION};

pub(crate) const MAX_TOOLS: usize = 6;
pub(crate) const MAX_LABEL: usize = 40;
pub(crate) const MAX_OS_VERSION: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AppPermission {
    Granted,
    Limited,
    Denied,
    Undetermined,
    Restricted,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct AppDecl {
    pub(crate) app: String,
    pub(crate) permission: AppPermission,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) precision: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) user_disabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ClientDeviceDecl {
    pub(crate) device_id: String,
    pub(crate) app: String,
    pub(crate) platform: String,
    #[serde(default)]
    pub(crate) os_version: String,
    #[serde(default)]
    pub(crate) utc_offset_min: i32,
    #[serde(default)]
    pub(crate) tz: String,
    #[serde(default)]
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) foreground: bool,
    pub(crate) catalog_version: u32,
    #[serde(default)]
    pub(crate) tools: Vec<AppDecl>,
}

/// Strip control characters and cap at `max` chars.
pub(crate) fn clean_label(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

impl ClientDeviceDecl {
    /// Validate and normalize in place. `header_device_id` is the request's
    /// `X-Ryu-Client-Id`, which must equal the declared id.
    pub(crate) fn validate(&mut self, header_device_id: Option<&str>) -> Result<(), String> {
        let id = uuid::Uuid::parse_str(self.device_id.trim())
            .map_err(|_| "client_device.device_id must be a UUID".to_owned())?;
        self.device_id = id.to_string();
        if header_device_id != Some(self.device_id.as_str()) {
            return Err("client_device.device_id must equal X-Ryu-Client-Id".to_owned());
        }
        if !matches!(self.app.as_str(), "ryu-bot" | "ryu-native") {
            return Err("client_device.app must be ryu-bot or ryu-native".to_owned());
        }
        if !matches!(self.platform.as_str(), "ios" | "android") {
            return Err("client_device.platform must be ios or android".to_owned());
        }
        if self.catalog_version != CATALOG_VERSION {
            return Err("client_device.catalog_version is not supported".to_owned());
        }
        if !(-18 * 60..=18 * 60).contains(&self.utc_offset_min) {
            return Err("client_device.utc_offset_min is out of range".to_owned());
        }
        if self.tools.len() > MAX_TOOLS {
            return Err("client_device.tools has too many entries".to_owned());
        }
        let mut seen = std::collections::HashSet::new();
        for decl in &self.tools {
            if catalog().app(&decl.app).is_none() || !seen.insert(decl.app.clone()) {
                return Err("client_device.tools names an unknown or repeated app".to_owned());
            }
        }
        self.label = clean_label(&self.label, MAX_LABEL);
        self.os_version = clean_label(&self.os_version, MAX_OS_VERSION);
        self.tz = clean_label(&self.tz, 64);
        Ok(())
    }

    pub(crate) fn app(&self, app: &str) -> Option<&AppDecl> {
        self.tools.iter().find(|decl| decl.app == app)
    }

    /// The label shown on cards; a neutral fallback when none was declared.
    pub(crate) fn display_label(&self) -> String {
        if self.label.is_empty() {
            match self.platform.as_str() {
                "ios" => "iPhone".to_owned(),
                _ => "Android phone".to_owned(),
            }
        } else {
            self.label.clone()
        }
    }
}

/// Whether a declared app may be offered at all. Undetermined and denied apps
/// are offered so the phone can show the needs-permission card; unsupported,
/// restricted and user-disabled apps never are.
pub(crate) fn offerable(decl: &AppDecl) -> bool {
    !decl.user_disabled
        && !matches!(
            decl.permission,
            AppPermission::Unsupported | AppPermission::Restricted
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decl() -> ClientDeviceDecl {
        serde_json::from_value(serde_json::json!({
            "device_id": "6F1C0D2E-7A41-4C33-9C0B-2D3E4F506172",
            "app": "ryu-bot",
            "platform": "ios",
            "os_version": "26.1",
            "utc_offset_min": -480,
            "label": "Alex's\u{0007} iPhone that has a very long name indeed",
            "foreground": true,
            "catalog_version": 1,
            "tools": [{ "app": "calendar", "permission": "granted" }]
        }))
        .unwrap()
    }

    #[test]
    fn header_and_body_device_ids_must_match_after_normalization() {
        let mut ok = decl();
        ok.validate(Some("6f1c0d2e-7a41-4c33-9c0b-2d3e4f506172"))
            .unwrap();
        assert_eq!(ok.device_id, "6f1c0d2e-7a41-4c33-9c0b-2d3e4f506172");
        assert!(!ok.label.contains('\u{0007}'));
        assert!(ok.label.chars().count() <= MAX_LABEL);
        assert!(decl()
            .validate(Some("00000000-0000-4000-8000-000000000000"))
            .is_err());
        assert!(decl().validate(None).is_err());
    }

    #[test]
    fn caps_and_vocabulary_are_enforced() {
        let mut too_many = decl();
        too_many.tools = (0..7)
            .map(|_| AppDecl {
                app: "calendar".into(),
                permission: AppPermission::Granted,
                precision: None,
                user_disabled: false,
            })
            .collect();
        assert!(too_many
            .validate(Some("6f1c0d2e-7a41-4c33-9c0b-2d3e4f506172"))
            .is_err());
        let mut repeated = decl();
        repeated.tools.push(repeated.tools[0].clone());
        assert!(repeated
            .validate(Some("6f1c0d2e-7a41-4c33-9c0b-2d3e4f506172"))
            .is_err());
        let mut wrong_app = decl();
        wrong_app.app = "desktop".into();
        assert!(wrong_app
            .validate(Some("6f1c0d2e-7a41-4c33-9c0b-2d3e4f506172"))
            .is_err());
        let disabled = AppDecl {
            app: "calendar".into(),
            permission: AppPermission::Denied,
            precision: None,
            user_disabled: true,
        };
        assert!(!offerable(&disabled));
        assert!(offerable(&AppDecl {
            user_disabled: false,
            ..disabled.clone()
        }));
        assert!(!offerable(&AppDecl {
            permission: AppPermission::Unsupported,
            user_disabled: false,
            ..disabled
        }));
    }
}

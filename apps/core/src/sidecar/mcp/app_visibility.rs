//! App-call visibility is per tool; a result's UI resource is independent.
use serde_json::Value;

fn legacy_access(meta: &Value) -> Option<bool> {
    meta.get("ryu/widgetAccessible")
        .or_else(|| meta.get("openai/widgetAccessible"))
        .map(|value| value.as_bool().unwrap_or(false))
}

pub fn callable(meta: Option<&Value>, standard_app_server: bool) -> bool {
    let Some(meta) = meta else {
        return standard_app_server;
    };
    if let Some(access) = legacy_access(meta) {
        return access;
    }
    if let Some(visibility) = meta.get("ui").and_then(|ui| ui.get("visibility")) {
        return visibility.as_array().is_some_and(|visibility| {
            visibility.iter().any(|value| value.as_str() == Some("app"))
        });
    }
    standard_app_server
}

pub fn instance_callable(
    meta: Option<&Value>,
    legacy_default: bool,
    has_callable_peers: bool,
) -> bool {
    let Some(meta) = meta else {
        return legacy_default;
    };
    if let Some(access) = legacy_access(meta) {
        return access;
    }
    if super::ui_extensions::resource_uri(Some(meta)).is_some() {
        return has_callable_peers;
    }
    legacy_default
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn ordinary_app_visible_tools_do_not_need_a_ui_resource() {
        assert!(callable(Some(&json!({"ui":{"visibility":["app"]}})), true));
        assert!(!callable(
            Some(&json!({"ui":{"visibility":["model"]}})),
            true
        ));
        assert!(callable(None, true));
        assert!(!callable(None, false));
        assert!(!callable(Some(&json!({"ui":{"visibility":"app"}})), true));
    }
    #[test]
    fn legacy_flags_override_standard_defaults() {
        assert!(!callable(
            Some(&json!({"ryu/widgetAccessible":false,"ui":{"visibility":["app"]}})),
            true
        ));
        assert!(callable(
            Some(&json!({"openai/widgetAccessible":true})),
            false
        ));
        assert!(!callable(
            Some(&json!({"ryu/widgetAccessible":"yes"})),
            true
        ));
    }
    #[test]
    fn model_only_openers_can_call_different_app_visible_peers() {
        let opener = json!({"ui":{"resourceUri":"ui://demo/app","visibility":["model"]}});
        assert!(instance_callable(Some(&opener), false, true));
        assert!(!instance_callable(Some(&opener), true, false));
        assert!(!instance_callable(
            Some(&json!({"ryu/widgetAccessible":false,"ui":{"resourceUri":"ui://demo/app"}})),
            true,
            true
        ));
        assert!(instance_callable(
            Some(&json!({"openai/outputTemplate":"ui://legacy"})),
            true,
            false
        ));
    }
}

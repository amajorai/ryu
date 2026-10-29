use super::*;

#[test]
fn validates_https_remote_jev_and_loopback_only_laya() {
    assert!(Settings::default().validate().is_ok());

    let mut settings = Settings::default();
    settings.jev_url = "http://model.example/predict".to_owned();
    assert!(settings.validate().is_err());

    let mut settings = Settings::default();
    settings.laya_url = "https://model.example/predict".to_owned();
    assert!(settings.validate().is_err());

    let mut settings = Settings::default();
    settings.jev_url = "https://user:pass@example.com/predict".to_owned();
    assert!(settings.validate().is_err());
}

#[test]
fn local_model_settings_require_a_provider_and_model() {
    let mut settings = Settings::default();
    settings.planner = Planner::Local;
    assert!(settings.validate().is_err());

    settings.local_plugin_id = "@ryu/needle3".to_owned();
    settings.local_model_id = "needle3".to_owned();
    assert!(settings.validate().is_ok());

    settings.local_plugin_id = "@ryu/../outside".to_owned();
    assert!(settings.validate().is_err());
}

#[test]
fn reads_legacy_snake_case_settings_and_writes_canonical_camel_case() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("computer-use.json");
    std::fs::write(
        &path,
        r#"{"version":1,"planner":"laya","jev_url":"https://api.typesafe.ai/v1/systemone","jev_model":"jev-latest","laya_url":"http://127.0.0.1:8980/api/ext/@ryu/laya/predict","max_steps":7}"#,
    )
    .unwrap();

    let settings = read_settings(&path).unwrap();
    assert_eq!(settings.max_steps, 7);
    write_settings(directory.path(), &settings).unwrap();
    let persisted = std::fs::read_to_string(path).unwrap();
    assert!(persisted.contains("\"jevUrl\""));
    assert!(persisted.contains("\"maxSteps\""));
}

#[test]
fn request_shape_is_camel_case_bounded_and_strict() {
    let update = serde_json::from_str::<SettingsUpdate>(
        r#"{"planner":"jev","jevUrl":"https://api.typesafe.ai/v1/systemone","jevModel":"jev-latest","layaUrl":"http://127.0.0.1:8980/api/ext/@ryu/laya/predict","maxSteps":5}"#,
    )
    .unwrap();
    assert_eq!(Settings::from(update).max_steps, 5);
    assert!(serde_json::from_str::<SettingsUpdate>(
        r#"{"planner":"jev","jevUrl":"https://api.typesafe.ai/v1/systemone","jevModel":"jev-latest","layaUrl":"http://127.0.0.1:8980/api/ext/@ryu/laya/predict","maxSteps":5,"extra":true}"#
    )
    .is_err());
}

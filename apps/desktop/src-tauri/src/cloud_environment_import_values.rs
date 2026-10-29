//! Native environment enumeration and explicit selection. No values are
//! returned by the names-only operation; the Tauri wrapper owns window authority.
use serde::Serialize;
#[path = "cloud_environment_import_policy.rs"]
mod policy;
use policy::allowed_key;

pub(crate) fn variable_names() -> Vec<String> {
    let mut names: Vec<_> = std::env::vars_os()
        .filter_map(|(key, _)| key.into_string().ok())
        .filter(|key| allowed_key(key))
        .collect();
    names.sort();
    names.truncate(1000);
    names
}

#[derive(Serialize)]
pub struct SelectedVariable {
    key: String,
    value: String,
}

pub(crate) fn selected_variables(keys: Vec<String>) -> Result<Vec<SelectedVariable>, String> {
    if keys.is_empty() || keys.len() > 100 || keys.iter().any(|key| !allowed_key(key)) {
        return Err("Select between 1 and 100 non-reserved variable names.".into());
    }
    let mut selected = Vec::with_capacity(keys.len());
    for key in keys {
        let value = std::env::var(&key)
            .map_err(|_| "A selected variable is no longer available.".to_string())?;
        if value.len() > 65_536 {
            return Err("A selected variable exceeds the value size limit.".into());
        }
        selected.push(SelectedVariable { key, value });
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_owned_environment(case: &str) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "selected_environment_subprocess_fixture",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("PROOF_IMPORT_CASE", case)
            .env("PROOF_IMPORT_SELECTED", "harmless-selected-value-946321")
            .env("PROOF_IMPORT_OTHER", "harmless-unselected-value-236489")
            .env("RYU_PROOF_IMPORT_RESERVED", "harmless-reserved-value")
            .env("PROOF_IMPORT_TOO_LARGE", "X".repeat(65_537))
            .env_remove("PROOF_IMPORT_MISSING")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn enumeration_exposes_only_names_and_explicit_selection_only_selected_values() {
        run_owned_environment("selected");
    }

    #[test]
    fn reserved_or_malformed_selection_refuses_instead_of_returning_any_value() {
        run_owned_environment("reserved");
    }

    #[test]
    fn disappearing_or_oversized_values_refuse_without_partial_success() {
        run_owned_environment("unavailable");
    }

    #[test]
    fn empty_or_excessive_selection_refuses() {
        run_owned_environment("limits");
    }

    #[test]
    #[ignore = "subprocess fixture launched by owned-environment regression tests"]
    fn selected_environment_subprocess_fixture() {
        match std::env::var("PROOF_IMPORT_CASE").unwrap().as_str() {
            "selected" => {
                let names = variable_names();
                assert!(names.contains(&"PROOF_IMPORT_SELECTED".to_string()));
                assert!(names.contains(&"PROOF_IMPORT_OTHER".to_string()));
                assert!(!names.contains(&"RYU_PROOF_IMPORT_RESERVED".to_string()));
                let names_json = serde_json::to_string(&names).unwrap();
                assert!(!names_json.contains("harmless-selected-value-946321"));
                assert!(!names_json.contains("harmless-unselected-value-236489"));
                let values = selected_variables(vec!["PROOF_IMPORT_SELECTED".into()]).unwrap();
                let value = serde_json::to_value(values).unwrap();
                assert_eq!(
                    value,
                    serde_json::json!([{
                        "key": "PROOF_IMPORT_SELECTED", "value": "harmless-selected-value-946321"
                    }])
                );
            }
            "reserved" => {
                for key in ["RYU_PROOF_IMPORT_RESERVED", "PATH", "HTTP_PROXY", "x=y"] {
                    assert!(
                        selected_variables(vec!["PROOF_IMPORT_SELECTED".into(), key.into()])
                            .is_err()
                    );
                }
            }
            "unavailable" => {
                for key in ["PROOF_IMPORT_MISSING", "PROOF_IMPORT_TOO_LARGE"] {
                    assert!(
                        selected_variables(vec!["PROOF_IMPORT_SELECTED".into(), key.into()])
                            .is_err()
                    );
                }
            }
            "limits" => {
                assert!(selected_variables(Vec::new()).is_err());
                assert!(selected_variables(
                    (0..101)
                        .map(|index| format!("PROOF_IMPORT_{index}"))
                        .collect()
                )
                .is_err());
            }
            other => panic!("unknown owned fixture case: {other}"),
        }
    }
}

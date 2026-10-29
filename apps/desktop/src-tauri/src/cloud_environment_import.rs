//! Names are listed first. Values leave this process only after explicit selection.
#[path = "cloud_environment_import_values.rs"]
mod values;
pub use values::SelectedVariable;

fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Variable import is available in the main Ryu window only.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn cloud_environment_variable_names(
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, String> {
    require_main(&window)?;
    Ok(values::variable_names())
}

#[tauri::command]
pub fn cloud_environment_selected_variables(
    window: tauri::WebviewWindow,
    keys: Vec<String>,
) -> Result<Vec<SelectedVariable>, String> {
    require_main(&window)?;
    values::selected_variables(keys)
}

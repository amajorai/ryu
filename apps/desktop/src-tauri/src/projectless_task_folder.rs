use std::{io, path::Path, path::PathBuf};

use tauri::Manager;

fn ensure_default_projectless_task_folder(documents_dir: &Path) -> io::Result<PathBuf> {
    let folder = documents_dir.join("Ryu").join("Projects");
    std::fs::create_dir_all(&folder)?;
    Ok(folder)
}

#[tauri::command]
pub fn get_default_projectless_task_folder(app: tauri::AppHandle) -> Result<String, String> {
    let documents_dir = app
        .path()
        .document_dir()
        .map_err(|error| format!("could not locate the Documents directory: {error}"))?;
    let folder = ensure_default_projectless_task_folder(&documents_dir).map_err(|error| {
        format!("could not create the default projectless task folder: {error}")
    })?;
    Ok(folder.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::ensure_default_projectless_task_folder;

    #[test]
    fn creates_ryu_projects_under_the_resolved_documents_directory() {
        let temp_dir = tempfile::tempdir().expect("temporary directory");
        let documents_dir = temp_dir.path().join("Documents");

        let folder = ensure_default_projectless_task_folder(&documents_dir)
            .expect("default projectless task folder");

        assert_eq!(folder, documents_dir.join("Ryu").join("Projects"));
        assert!(folder.is_dir());
    }
}

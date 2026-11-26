use super::super::tests::body_json;
use super::*;

#[tokio::test]
async fn list_directory_returns_child_dirs_and_hides_files_and_dotfiles() {
    // A temp dir with two sub-folders, one file, and one hidden folder.
    let base = dirs::home_dir()
        .unwrap()
        .join(format!(".ryu_listdir_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("alpha")).unwrap();
    std::fs::create_dir_all(base.join("beta")).unwrap();
    std::fs::create_dir_all(base.join(".hidden")).unwrap();
    std::fs::write(base.join("readme.txt"), b"x").unwrap();

    let resp = list_directory(Query(ListDirQuery {
        path: Some(base.to_string_lossy().into_owned()),
    }))
    .await;
    let (status, json) = body_json(resp).await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<String> = json["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap().to_string())
        .collect();
    // Only the two visible sub-directories, sorted; no file, no dotfile.
    assert_eq!(names, vec!["alpha".to_string(), "beta".to_string()]);
    assert!(json["parent"].is_string());
    assert!(json["home"].is_string());

    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn list_directory_404s_on_missing_path() {
    let missing = dirs::home_dir()
        .unwrap()
        .join(format!(".ryu_missing_directory_{}", std::process::id()));
    let resp = list_directory(Query(ListDirQuery {
        path: Some(missing.to_string_lossy().into_owned()),
    }))
    .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn list_directory_rejects_paths_outside_home_tree() {
    let outside = std::env::temp_dir();
    if outside.starts_with(dirs::home_dir().unwrap()) {
        return;
    }
    let resp = list_directory(Query(ListDirQuery {
        path: Some(outside.to_string_lossy().into_owned()),
    }))
    .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn list_directory_defaults_to_home_when_path_absent() {
    let resp = list_directory(Query(ListDirQuery { path: None })).await;
    let (status, json) = body_json(resp).await;
    assert_eq!(status, StatusCode::OK);
    // The emitted path must never carry the Windows verbatim (`\\?\`) prefix
    // that `canonicalize` adds — `display_path` strips it. (Trivially true off
    // Windows, where no path starts with that.) This locks the display fix.
    let path = json["path"].as_str().unwrap();
    assert!(!path.starts_with(r"\\?\"), "verbatim prefix leaked: {path}");
    // Home is a real directory, so listing it succeeds and echoes the home path.
    let home = display_path(&dirs::home_dir().unwrap());
    assert_eq!(path, home);
}

#[cfg(windows)]
#[tokio::test]
async fn list_directory_this_pc_lists_drives() {
    let resp = list_directory(Query(ListDirQuery {
        path: Some(THIS_PC.to_string()),
    }))
    .await;
    let (status, json) = body_json(resp).await;
    assert_eq!(status, StatusCode::OK);
    assert!(json["parent"].is_null());
    assert_eq!(json["label"].as_str().unwrap(), "This PC");
    // The home tree is always present, so at least one entry comes back.
    assert!(!json["entries"].as_array().unwrap().is_empty());
}

#[cfg(windows)]
#[tokio::test]
async fn list_directory_drive_root_stays_outside_home_tree() {
    // Drive roots are outside the home-tree boundary. Keep the traversal guard
    // closed rather than allowing a remote picker to enumerate another drive.
    let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    let root = format!("{system_drive}\\");
    let resp = list_directory(Query(ListDirQuery { path: Some(root) })).await;
    let (status, json) = body_json(resp).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        json["error"],
        "workspace path must stay inside the node home directory"
    );
}

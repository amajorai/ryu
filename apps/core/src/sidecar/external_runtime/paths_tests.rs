//! Tests for the file name an asset URL ends in (finding TC-W2, the asset file
//! name). `asset_dest` is pure, so nothing here touches the disk.

use super::*;

/// One refused case: the URL's last part is not joined onto the assets folder.
fn assert_refused(file_name: &str) {
    let base = Path::new("runtime-tcw2");
    let url = format!("https://example.com/a/{file_name}");
    let result = asset_dest(base, "models", &url);
    println!("TCW2 asset {file_name}: {result:?}");
    let error = result.expect_err("a file name that holds ':' must be refused");
    assert!(
        matches!(error, ProvisionError::UnsafeAssetPath(_)),
        "{error}"
    );
    let refusal = format!("asset file name '{file_name}' is refused");
    assert!(error.to_string().contains(&refusal), "{error}");
}

// On Windows `C:tcw2.bin` is a drive-relative path: joined onto the assets
// folder it drops that folder, and the download lands in the current folder.
#[test]
fn an_asset_file_name_with_a_drive_form_is_refused() {
    for name in ["C:tcw2.bin", "Q:x", "x:y"] {
        assert_refused(name);
    }
}

// A colon that is not a drive form. Refused on every OS as well, so a plugin
// package behaves the same everywhere.
#[test]
fn an_asset_file_name_with_a_stream_form_is_refused() {
    for name in ["ab:tcw2c", "model.gguf:tcw2"] {
        assert_refused(name);
    }
}

#[test]
fn an_ordinary_asset_file_name_still_joins_under_the_assets_folder() {
    let base = Path::new("runtime-tcw2");
    for dest in ["models/hf", "", "./models"] {
        let joined = asset_dest(base, dest, "https://example.com/a/model.gguf").unwrap();
        let expected = base.join("assets").join(dest).join("model.gguf");
        assert_eq!(joined, expected, "{dest:?}");
    }
}

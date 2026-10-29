//! Source files compiled for opt-in first-party plugins whose manifests point at a
//! package-owned runtime tree. Model weights are deliberately not included here;
//! the manifest's pinned snapshot declaration sends those through Downloads.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use crate::plugin_manifest::schema::SidecarProcess;

/// `(plugin id, package-root-relative path, source)` for the small Python runtime
/// trees shipped by the opt-in local-model plugins. Keep this separate from the
/// sandboxed JS, unsandboxed Pi extensions, and inert output-style tables.
const BUILTIN_PLUGIN_SOURCE_FILES: &[(&str, &str, &str)] = &[
    (
        "@ryu/functiongemma",
        "sidecar/pyproject.toml",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/functiongemma/sidecar/pyproject.toml"),
    ),
    (
        "@ryu/functiongemma",
        "sidecar/ryu_functiongemma/__main__.py",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/functiongemma/sidecar/ryu_functiongemma/__main__.py"
        ),
    ),
    (
        "@ryu/functiongemma",
        "sidecar/ryu_functiongemma/__init__.py",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/functiongemma/sidecar/ryu_functiongemma/__init__.py"
        ),
    ),
    (
        "@ryu/functiongemma",
        "sidecar/ryu_functiongemma/decision.py",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/functiongemma/sidecar/ryu_functiongemma/decision.py"
        ),
    ),
    (
        "@ryu/functiongemma",
        "sidecar/ryu_functiongemma/server.py",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/functiongemma/sidecar/ryu_functiongemma/server.py"
        ),
    ),
    (
        "@ryu/laya",
        "sidecar/pyproject.toml",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/laya/sidecar/pyproject.toml"),
    ),
    (
        "@ryu/laya",
        "sidecar/ryu_laya/__init__.py",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/laya/sidecar/ryu_laya/__init__.py"),
    ),
    (
        "@ryu/laya",
        "sidecar/ryu_laya/__main__.py",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/laya/sidecar/ryu_laya/__main__.py"),
    ),
    (
        "@ryu/laya",
        "sidecar/ryu_laya/decision.py",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/laya/sidecar/ryu_laya/decision.py"),
    ),
    (
        "@ryu/laya",
        "sidecar/ryu_laya/server.py",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/laya/sidecar/ryu_laya/server.py"),
    ),
    (
        "@ryu/needle3",
        "sidecar/pyproject.toml",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/needle3/sidecar/pyproject.toml"),
    ),
    (
        "@ryu/needle3",
        "sidecar/ryu_needle3/__main__.py",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/needle3/sidecar/ryu_needle3/__main__.py"),
    ),
    (
        "@ryu/needle3",
        "sidecar/ryu_needle3/__init__.py",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/needle3/sidecar/ryu_needle3/__init__.py"),
    ),
    (
        "@ryu/needle3",
        "sidecar/ryu_needle3/decision.py",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/needle3/sidecar/ryu_needle3/decision.py"),
    ),
    (
        "@ryu/needle3",
        "sidecar/ryu_needle3/server.py",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/needle3/sidecar/ryu_needle3/server.py"),
    ),
];

fn safe_relative_path(raw: &str) -> Option<PathBuf> {
    if raw.is_empty() || raw.trim() != raw || raw.contains('\\') || raw.contains('\0') {
        return None;
    }

    let path = Path::new(raw);
    if path.is_absolute()
        || path.components().count() == 0
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return None;
    }
    Some(path.to_path_buf())
}

/// Ensure the source files for an embedded plugin exist only when the installed
/// on-disk manifest exactly matches a compiled install-catalog entry. Missing files
/// are restored but existing regular files are never overwritten. Ordinary plugins
/// must carry their own source tree or archive.
pub(crate) fn ensure_compiled_source(
    package_root: &Path,
    plugins_root: &Path,
    source_path: &str,
) -> Result<bool, String> {
    let Some(relative_source) = safe_relative_path(source_path) else {
        return Ok(false);
    };
    let plugins_root = match plugins_root.canonicalize() {
        Ok(path) => path,
        Err(_) => return Ok(false),
    };
    let package_root = match package_root.canonicalize() {
        Ok(path) if path.parent() == Some(plugins_root.as_path()) => path,
        _ => return Ok(false),
    };
    let manifest_path = package_root.join(super::MANIFEST_FILE_NAME);
    let Ok(metadata) = fs::symlink_metadata(&manifest_path) else {
        return Ok(false);
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(false);
    }
    let Ok(manifest_bytes) = fs::read(&manifest_path) else {
        return Ok(false);
    };
    let Ok(manifest) = serde_json::from_slice::<super::PluginManifest>(&manifest_bytes) else {
        return Ok(false);
    };
    if package_root.file_name().and_then(|name| name.to_str())
        != Some(super::plugin_dir_name(&manifest.id).as_str())
    {
        return Ok(false);
    }

    let Some(compiled_manifest) = super::PluginManifestLoader::load_install_catalog()
        .into_iter()
        .find(|candidate| candidate.id == manifest.id)
    else {
        return Ok(false);
    };
    let compiled_value = serde_json::to_value(compiled_manifest)
        .map_err(|error| format!("compiled plugin manifest could not be serialized: {error}"))?;
    let installed_value = serde_json::to_value(&manifest)
        .map_err(|error| format!("installed plugin manifest could not be serialized: {error}"))?;
    if compiled_value != installed_value {
        return Ok(false);
    }

    let source_is_declared = manifest.sidecars.iter().any(|sidecar| {
        matches!(
            &sidecar.process,
            SidecarProcess::Python(runtime)
                if runtime.source.as_ref().and_then(|source| source.path.as_deref())
                    == Some(source_path)
        )
    });
    if !source_is_declared {
        return Ok(false);
    }

    let source_prefix = format!("{source_path}/");
    let files: Vec<_> = BUILTIN_PLUGIN_SOURCE_FILES
        .iter()
        .filter(|(plugin_id, path, _)| {
            *plugin_id == manifest.id && path.starts_with(&source_prefix)
        })
        .collect();
    if files.is_empty()
        || files
            .iter()
            .any(|(_, path, _)| safe_relative_path(path).is_none())
    {
        return Ok(false);
    }

    let destination = package_root.join(&relative_source);
    match fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            ensure_directories_without_symlinks(&package_root, &destination)?;
            for (_, path, contents) in files {
                let relative_file = relative_file(path, &source_prefix)?;
                let file_path = destination.join(relative_file);
                let parent = file_path
                    .parent()
                    .ok_or_else(|| "embedded source file has no parent".to_owned())?;
                ensure_directories_without_symlinks(&package_root, parent)?;
                match fs::symlink_metadata(&file_path) {
                    Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
                    Ok(_) => {
                        return Err(format!(
                            "embedded plugin source path '{}' is not a regular file",
                            file_path.display()
                        ));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        write_missing_file(&file_path, contents)?;
                    }
                    Err(error) => {
                        return Err(format!(
                            "could not inspect embedded plugin source '{}': {error}",
                            file_path.display()
                        ));
                    }
                }
            }
            Ok(true)
        }
        Ok(_) => Err("embedded plugin source path is not a safe directory".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let stage = tempfile::Builder::new()
                .prefix(".ryu-plugin-source-")
                .tempdir_in(&package_root)
                .map_err(|error| {
                    format!("could not create a private source staging directory: {error}")
                })?;
            let staged_source = stage.path().join(&relative_source);
            fs::create_dir_all(&staged_source).map_err(|error| {
                format!("could not create embedded source directories: {error}")
            })?;

            for (_, path, contents) in files {
                let relative_file = relative_file(path, &source_prefix)?;
                let file_path = staged_source.join(relative_file);
                if let Some(parent) = file_path.parent() {
                    fs::create_dir_all(parent).map_err(|error| {
                        format!("could not create embedded package directories: {error}")
                    })?;
                }
                fs::write(file_path, contents.as_bytes())
                    .map_err(|error| format!("could not write embedded plugin source: {error}"))?;
            }

            if let Some(parent) = destination.parent() {
                ensure_directories_without_symlinks(&package_root, parent)?;
            }
            fs::rename(&staged_source, &destination)
                .map_err(|error| format!("could not publish embedded plugin source: {error}"))?;
            Ok(true)
        }
        Err(error) => Err(format!(
            "could not inspect embedded plugin source '{}': {error}",
            destination.display()
        )),
    }
}

fn relative_file(path: &str, source_prefix: &str) -> Result<PathBuf, String> {
    let Some(relative_file) = path.strip_prefix(source_prefix) else {
        return Err("embedded plugin file is outside its declared source directory".to_owned());
    };
    safe_relative_path(relative_file)
        .ok_or_else(|| "embedded plugin file contains an unsafe path component".to_owned())
}

fn write_missing_file(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "embedded plugin file has no parent directory".to_owned())?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("could not stage embedded plugin source: {error}"))?;
    staged
        .write_all(contents.as_bytes())
        .map_err(|error| format!("could not write staged plugin source: {error}"))?;
    staged
        .as_file()
        .sync_all()
        .map_err(|error| format!("could not sync staged plugin source: {error}"))?;

    match staged.persist_noclobber(path) {
        Ok(_) => Ok(()),
        Err(error) => match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(()),
            _ => Err(format!(
                "could not publish embedded plugin source: {}",
                error.error
            )),
        },
    }
}

fn ensure_directories_without_symlinks(root: &Path, destination: &Path) -> Result<(), String> {
    let relative = destination
        .strip_prefix(root)
        .map_err(|_| "embedded source parent escaped its plugin directory".to_owned())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("embedded source parent contains an unsafe path component".to_owned());
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err("embedded source parent is not a safe directory".to_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .map_err(|error| format!("could not create plugin source parent: {error}"))?;
            }
            Err(error) => return Err(format!("could not inspect plugin source parent: {error}")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{ensure_compiled_source, BUILTIN_PLUGIN_SOURCE_FILES};
    use crate::plugin_manifest::PluginManifestLoader;

    fn package_root(root: &std::path::Path, id: &str) -> std::path::PathBuf {
        root.join(crate::plugin_manifest::plugin_dir_name(id))
    }

    #[test]
    fn all_installable_model_runtime_files_materialize_from_exact_compiled_manifests() {
        let catalog = PluginManifestLoader::load_install_catalog();
        for id in ["@ryu/laya", "@ryu/functiongemma", "@ryu/needle3"] {
            let manifest = catalog
                .iter()
                .find(|manifest| manifest.id == id)
                .unwrap_or_else(|| panic!("{id} must be in the compiled install catalog"));
            let root = tempfile::tempdir().expect("plugin root");
            let installed = package_root(root.path(), id);
            fs::create_dir_all(&installed).expect("plugin directory");
            fs::write(
                installed.join(crate::plugin_manifest::MANIFEST_FILE_NAME),
                serde_json::to_vec_pretty(manifest).expect("manifest JSON"),
            )
            .expect("installed manifest");

            assert!(
                ensure_compiled_source(&installed, root.path(), "sidecar")
                    .expect("source materialization"),
                "{id} should receive its compiled source tree"
            );
            let files: Vec<_> = BUILTIN_PLUGIN_SOURCE_FILES
                .iter()
                .filter(|(plugin_id, _, _)| *plugin_id == id)
                .collect();
            for (_, relative, contents) in files {
                let destination = installed.join(relative);
                assert_eq!(
                    fs::read_to_string(destination).expect("materialized file"),
                    *contents,
                    "{id} source should match its canonical plugin package"
                );
            }
            assert!(!installed.join("sidecar/tests").exists());
        }
    }

    #[test]
    fn modified_manifests_and_existing_sources_are_never_overwritten() {
        let catalog = PluginManifestLoader::load_install_catalog();
        let mut manifest = catalog
            .into_iter()
            .find(|manifest| manifest.id == "@ryu/needle3")
            .expect("Needle 3 install manifest");
        manifest.name.push_str(" modified");
        let root = tempfile::tempdir().expect("plugin root");
        let installed = package_root(root.path(), &manifest.id);
        fs::create_dir_all(installed.join("sidecar")).expect("existing source");
        fs::write(
            installed.join(crate::plugin_manifest::MANIFEST_FILE_NAME),
            serde_json::to_vec_pretty(&manifest).expect("manifest JSON"),
        )
        .expect("installed manifest");
        fs::write(installed.join("sidecar/user-owned.txt"), "keep").expect("user file");

        assert!(!ensure_compiled_source(&installed, root.path(), "sidecar").unwrap());
        assert_eq!(
            fs::read_to_string(installed.join("sidecar/user-owned.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn unsafe_source_paths_are_ignored_before_any_filesystem_write() {
        let root = tempfile::tempdir().expect("plugin root");
        let installed = package_root(root.path(), "@ryu/needle3");
        fs::create_dir_all(&installed).expect("plugin directory");

        assert!(!ensure_compiled_source(&installed, root.path(), "../escape").unwrap());
        assert!(!root.path().join("escape").exists());
    }

    #[test]
    fn existing_compiled_source_receives_missing_files_without_overwriting_edits() {
        let manifest = PluginManifestLoader::load_install_catalog()
            .into_iter()
            .find(|manifest| manifest.id == "@ryu/needle3")
            .expect("Needle 3 install manifest");
        let root = tempfile::tempdir().expect("plugin root");
        let installed = package_root(root.path(), &manifest.id);
        let source = installed.join("sidecar");
        fs::create_dir_all(&source).expect("existing source directory");
        fs::write(source.join("pyproject.toml"), "local edit").expect("local edit");
        fs::write(source.join("user-owned.txt"), "preserve").expect("user file");
        fs::write(
            installed.join(crate::plugin_manifest::MANIFEST_FILE_NAME),
            serde_json::to_vec_pretty(&manifest).expect("manifest JSON"),
        )
        .expect("installed manifest");

        assert!(ensure_compiled_source(&installed, root.path(), "sidecar").unwrap());
        assert_eq!(
            fs::read_to_string(source.join("pyproject.toml")).unwrap(),
            "local edit"
        );
        assert_eq!(
            fs::read_to_string(source.join("user-owned.txt")).unwrap(),
            "preserve"
        );
        assert!(source.join("ryu_needle3/__main__.py").is_file());
    }
}

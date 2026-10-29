//! Core's bootstrap data-location contract, shared by lifecycle hosts.
//! Discovery reads configuration only; it never executes a Core binary or opens stores.
use std::{ffi::OsString, io, path::PathBuf};

use serde::{Deserialize, Serialize};

/// Existing on-disk pointer format. Missing/null/empty data_dir selects the default.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct DataPathPointer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DataPaths {
    pub default_data_dir: PathBuf,
    pub config_dir: PathBuf,
    pub pointer_path: PathBuf,
}

impl DataPaths {
    /// Profile layout owned by Core. Unknown profiles must not alias release data.
    pub fn for_profile(
        profile: &str,
        home: Option<PathBuf>,
        os_config: Option<PathBuf>,
    ) -> io::Result<Self> {
        let suffix = match profile {
            "release" => String::new(),
            "dev" | "canary" | "nightly" | "beta" => format!("-{profile}"),
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "unknown Ryu profile",
                ))
            }
        };
        let default_data_dir = home
            .unwrap_or_else(|| PathBuf::from("."))
            .join(format!(".ryu{suffix}"));
        let config_dir = os_config
            .unwrap_or_else(|| default_data_dir.clone())
            .join(format!("ryu{suffix}"));
        let pointer_path = config_dir.join("data-path.json");
        Ok(Self {
            default_data_dir,
            config_dir,
            pointer_path,
        })
    }

    /// Only a missing file means no pointer. Corruption and inaccessible state
    /// cannot authorize lifecycle operations against the default directory.
    pub fn read_pointer(&self) -> io::Result<DataPathPointer> {
        match crate::bounded_file::read(&self.pointer_path, 128 * 1024) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DataPathPointer::default()),
            Err(error) => Err(error),
        }
    }

    /// Explicit nonempty override > configured pointer > profile default.
    /// Paths retain their existing spelling, including relative operator paths.
    pub fn resolve_data_dir(&self, override_dir: Option<OsString>) -> io::Result<PathBuf> {
        if let Some(path) = override_dir.filter(|path| !path.is_empty()) {
            return Ok(PathBuf::from(path));
        }
        Ok(self
            .read_pointer()?
            .data_dir
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.default_data_dir.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, DataPaths) {
        let root = tempfile::tempdir().unwrap();
        let paths = DataPaths::for_profile(
            "dev",
            Some(root.path().join("home")),
            Some(root.path().join("config")),
        )
        .unwrap();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        (root, paths)
    }

    #[test]
    fn relocated_pointer_wins_without_an_environment_override() {
        let (root, paths) = fixture();
        let relocated = root.path().join("relocated");
        std::fs::write(
            &paths.pointer_path,
            serde_json::to_vec(&DataPathPointer {
                data_dir: Some(relocated.to_string_lossy().into_owned()),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(paths.resolve_data_dir(None).unwrap(), relocated);
        assert_eq!(
            paths.resolve_data_dir(Some(OsString::new())).unwrap(),
            relocated
        );
        let explicit = root.path().join("explicit");
        assert_eq!(
            paths
                .resolve_data_dir(Some(explicit.clone().into_os_string()))
                .unwrap(),
            explicit
        );
    }

    #[test]
    fn absent_and_cleared_pointers_select_the_profile_default() {
        let (_root, paths) = fixture();
        assert_eq!(
            paths.resolve_data_dir(None).unwrap(),
            paths.default_data_dir
        );
        for json in ["{}", "{\"data_dir\":null}", "{\"data_dir\":\"\"}"] {
            std::fs::write(&paths.pointer_path, json).unwrap();
            assert_eq!(
                paths.resolve_data_dir(None).unwrap(),
                paths.default_data_dir
            );
        }
    }

    #[test]
    fn corrupt_or_inaccessible_pointer_fails_closed_unless_explicitly_overridden() {
        let (root, paths) = fixture();
        for json in ["{", "null", "{\"data_dir\":42}"] {
            std::fs::write(&paths.pointer_path, json).unwrap();
            assert_eq!(
                paths.resolve_data_dir(None).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
            let explicit = root.path().join("explicit");
            assert_eq!(
                paths
                    .resolve_data_dir(Some(explicit.clone().into_os_string()))
                    .unwrap(),
                explicit
            );
        }
        std::fs::remove_file(&paths.pointer_path).unwrap();
        std::fs::create_dir(&paths.pointer_path).unwrap();
        assert!(paths.resolve_data_dir(None).is_err());
    }

    #[test]
    fn layout_is_profile_isolated_and_unknown_profile_is_rejected() {
        for profile in ["release", "dev", "canary", "nightly", "beta"] {
            let paths = DataPaths::for_profile(
                profile,
                Some(PathBuf::from("home")),
                Some(PathBuf::from("config")),
            )
            .unwrap();
            let suffix = if profile == "release" {
                String::new()
            } else {
                format!("-{profile}")
            };
            assert_eq!(
                paths.default_data_dir,
                PathBuf::from("home").join(format!(".ryu{suffix}"))
            );
            assert_eq!(
                paths.pointer_path,
                PathBuf::from("config")
                    .join(format!("ryu{suffix}"))
                    .join("data-path.json")
            );
        }
        assert!(DataPaths::for_profile("unknown", None, None).is_err());
        let fallback = DataPaths::for_profile("dev", None, None).unwrap();
        assert_eq!(
            fallback.config_dir,
            PathBuf::from(".").join(".ryu-dev").join("ryu-dev")
        );
    }
}

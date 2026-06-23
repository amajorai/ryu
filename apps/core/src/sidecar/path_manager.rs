//! PATH environment variable management for Ryu binaries.
//!
//! Automatically adds `~/.ryu/bin/` to PATH on first run to make installed
//! sidecar binaries (zeroclaw, temporal, etc.) accessible from the terminal.

use std::path::Path;
#[cfg(not(target_os = "windows"))]
use std::io::Write;
#[cfg(not(target_os = "windows"))]
use std::path::PathBuf;

use anyhow::{Context, Result};

pub struct PathManager;

impl PathManager {
    /// Add ~/.ryu/bin to PATH permanently
    pub fn add_to_path() -> Result<()> {
        let bin_dir = crate::paths::ryu_dir().join("bin");

        #[cfg(target_os = "windows")]
        {
            Self::add_to_windows_path(&bin_dir)?;
        }

        #[cfg(not(target_os = "windows"))]
        {
            Self::add_to_unix_path(&bin_dir)?;
        }

        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn add_to_windows_path(bin_dir: &Path) -> Result<()> {
        use winapi::shared::minwindef::LPARAM;
        use winapi::um::winuser::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };
        use winreg::{enums::*, RegKey};

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let env = hkcu
            .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
            .context("opening Environment registry key")?;

        let current_path: String = env.get_value("Path").unwrap_or_default();

        // Check if already in PATH
        if current_path.split(';').any(|p| Path::new(p) == bin_dir) {
            tracing::debug!("~/.ryu/bin already in PATH");
            return Ok(());
        }

        // Append to PATH
        let new_path = if current_path.ends_with(';') || current_path.is_empty() {
            format!("{}{}", current_path, bin_dir.display())
        } else {
            format!("{};{}", current_path, bin_dir.display())
        };

        env.set_value("Path", &new_path)
            .context("setting Path registry value")?;

        // Notify other processes of the change
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                "Environment\0".as_ptr() as LPARAM,
                SMTO_ABORTIFHUNG,
                5000,
                std::ptr::null_mut(),
            );
        }

        tracing::info!("Added ~/.ryu/bin to user PATH (Windows)");
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    fn add_to_unix_path(bin_dir: &Path) -> Result<()> {
        let shell_profile = Self::detect_shell_profile()?;

        let export_line = format!(
            "\n# Added by ryu-core\nexport PATH=\"$PATH:{}\"\n",
            bin_dir.display()
        );

        // Check if already in profile
        if let Ok(contents) = std::fs::read_to_string(&shell_profile) {
            if contents.contains(&bin_dir.display().to_string()) {
                tracing::debug!(
                    "~/.ryu/bin already in PATH (found in {})",
                    shell_profile.display()
                );
                return Ok(());
            }
        }

        // Append to profile
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&shell_profile)
            .context("opening shell profile for append")?
            .write_all(export_line.as_bytes())
            .context("writing PATH export to shell profile")?;

        tracing::info!("Added ~/.ryu/bin to PATH in {}", shell_profile.display());
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    fn detect_shell_profile() -> Result<PathBuf> {
        let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home directory"))?;

        // Try common shell profiles in order of preference
        let profiles = vec![
            ".zshrc",        // Zsh (default on newer macOS)
            ".bashrc",       // Bash (common on Linux)
            ".bash_profile", // Bash (common on macOS)
            ".profile",      // Generic POSIX shell
        ];

        for profile in &profiles {
            let path = home.join(profile);
            if path.exists() {
                return Ok(path);
            }
        }

        // Default to .bashrc if none exist (create it if needed)
        Ok(home.join(".bashrc"))
    }
}

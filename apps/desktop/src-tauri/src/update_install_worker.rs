//! Cached, signature-verified installation in a process owned by the guard.
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedInstall {
    pub artifact: PathBuf,
    pub signature: String,
    pub version: String,
    pub raw_feed: serde_json::Value,
    pub target_executable: PathBuf,
    pub nonce: String,
    pub format: String,
}

pub fn run(path: PathBuf) -> anyhow::Result<()> {
    use anyhow::{ensure, Context};
    let path = fs::canonicalize(path)?;
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let root = fs::canonicalize(
        crate::update_recovery::recovery_root(&context.config().identifier)
            .map_err(anyhow::Error::msg)?,
    )?;
    ensure!(
        path.starts_with(root.join("handoffs")),
        "cached installer escaped the owned handoff directory"
    );
    let record: CachedInstall = serde_json::from_slice(&fs::read(&path)?)?;
    let artifact = fs::canonicalize(&record.artifact)?;
    ensure!(
        artifact.parent() == path.parent(),
        "cached installer artifact is outside its handoff"
    );
    ensure!(
        record.target_executable.is_absolute() && !record.nonce.is_empty(),
        "invalid cached installation target"
    );
    #[cfg(windows)]
    ensure!(
        !record
            .target_executable
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
            && !record
                .target_executable
                .to_string_lossy()
                .chars()
                .any(|value| matches!(value, '"' | '\0' | '\r' | '\n')),
        "cached installation target contains unsafe command-line characters"
    );
    let key = context
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .context("missing embedded updater key")?;
    let bytes = fs::read(&artifact)?;
    crate::app_update::verify_minisign(&bytes, &record.signature, key)
        .map_err(anyhow::Error::msg)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Windows Installer needs a normal, short source path accessible to its
        // service. Canonical cache paths can be verbatim/redirected MSIX paths
        // that it cannot open. The bytes are already signature-verified above.
        let temporary = if record.format == "msi" {
            tempfile::Builder::new().prefix("ryu-msi-").tempdir()?
        } else {
            tempfile::Builder::new()
                .prefix("installer-")
                .tempdir_in(path.parent().unwrap())?
        };
        let mut command = if record.format == "exe" {
            ensure!(
                bytes.starts_with(b"MZ"),
                "signed update is not a Windows executable"
            );
            let installer = temporary.path().join("install.exe");
            fs::write(&installer, &bytes)?;
            let mut command = std::process::Command::new(installer);
            command.args(["/S", "/UPDATE", "/ARGS", ""]);
            // NSIS parses /D= from the raw command line and consumes everything
            // after it. Quoting this argument makes a path with spaces fall back
            // to the installer's default directory. Keep it unquoted and last.
            command.raw_arg(format!(
                "/D={}",
                record
                    .target_executable
                    .parent()
                    .context("application has no parent")?
                    .display()
            ));
            command
        } else if record.format == "msi" {
            ensure!(
                bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
                "signed update is not an MSI package"
            );
            let installer = temporary.path().join("install.msi");
            fs::write(&installer, &bytes)?;
            // Resolve the OS tool independently of inherited PATH/current dir.
            let mut system_directory = [0u16; 32768];
            let length = unsafe {
                windows::Win32::System::SystemInformation::GetSystemDirectoryW(Some(
                    &mut system_directory,
                ))
            } as usize;
            ensure!(
                length > 0 && length < system_directory.len(),
                "could not resolve Windows system directory"
            );
            use std::os::windows::ffi::OsStringExt;
            let msiexec = PathBuf::from(std::ffi::OsString::from_wide(&system_directory[..length]))
                .join("msiexec.exe");
            let mut command = std::process::Command::new(msiexec);
            command
                .arg("/i")
                .arg(installer)
                // MSI conditions treat any nonempty value, including "False",
                // as true. Clear the property so only the guard launches Ryu.
                .args(["/quiet", "/norestart"]);
            command.raw_arg("AUTOLAUNCHAPP=\"\"");
            command.raw_arg(format!(
                "INSTALLDIR=\"{}\"",
                record
                    .target_executable
                    .parent()
                    .context("application has no parent")?
                    .display()
            ));
            command
        } else {
            anyhow::bail!("unsupported Windows updater format");
        };
        command
            .env("RYU_UPDATE_NONCE", &record.nonce)
            .creation_flags(0x08000000);
        let status = command.status()?;
        ensure!(
            status.success(),
            "native installer failed or needs restart: {status}"
        );
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        use tauri_plugin_updater::UpdaterExt;
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let endpoint = format!("http://{}/feed", listener.local_addr()?);
        let feed = serde_json::to_vec(&record.raw_feed)?;
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                let mut request = [0u8; 4096];
                if stream.read(&mut request).is_ok() {
                    let header = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", feed.len());
                    let _ = stream
                        .write_all(header.as_bytes())
                        .and_then(|_| stream.write_all(&feed));
                }
            }
        });
        let mut context = context;
        context.config_mut().app.windows.clear();
        let app = tauri::Builder::default()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)?;
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                let updater = handle
                    .updater_builder()
                    .executable_path(&record.target_executable)
                    .endpoints(vec![endpoint.parse()?])?
                    .version_comparator(|_, _| true)
                    .build()?;
                let update = updater
                    .check()
                    .await?
                    .context("cached updater metadata was not accepted")?;
                ensure!(
                    update.version == record.version && update.signature == record.signature,
                    "cached updater metadata changed"
                );
                update.install(bytes)?;
                Ok::<(), anyhow::Error>(())
            }
            .await;
            if let Err(error) = &result {
                eprintln!("cached installation failed: {error:#}");
            }
            handle.exit(if result.is_ok() { 0 } else { 1 });
        });
        app.run(|_, _| {});
        Ok(())
    }
}

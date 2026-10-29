//! Exercise the real Core maintenance entry point against OS data leases.
use anyhow::{ensure, Context, Result};
use ryu_runtime_install::data_lease::DataLease;
use std::{fs, path::Path, process::Command};

fn run(core: &Path, home: &Path, args: &[&str]) -> Result<std::process::Output> {
    Command::new(core)
        .args(["data-path"])
        .args(args)
        .env("RYU_PROFILE", "dev")
        .env("RYU_KEYCHAIN", "off")
        .env("RYU_DIR", home)
        // Export fails closed without a passphrase; supply one so the proof
        // reaches the data-lease checks it exists to exercise.
        .env(
            "RYU_DATA_ARCHIVE_PASSPHRASE",
            "maintenance proof passphrase",
        )
        .output()
        .context("run actual Core maintenance command")
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    ensure!(
        args.len() == 3,
        "usage: maintenance_cli_proof <Core executable> <recovery cache>"
    );
    let core = Path::new(&args[1]);
    let cache = Path::new(&args[2]);
    let base = tempfile::tempdir()?;
    let source = base.path().join("source");
    let target = base.path().join("target");
    let archive = base.path().join("backup.zip");
    let home = base.path().join("home");
    fs::create_dir_all(&source)?;
    fs::write(source.join("content.txt"), "unchanged")?;
    let source_arg = source.to_str().context("source path")?;
    let target_arg = target.to_str().context("target path")?;
    let archive_arg = archive.to_str().context("archive path")?;
    let mutations = [
        vec!["migrate", "--from", source_arg, "--to", target_arg],
        vec!["import", "--archive", archive_arg, "--to", source_arg],
        vec![
            "copy-profile",
            "--from-profile",
            "dev",
            "--to-profile",
            "beta",
            "--from",
            source_arg,
            "--to",
            target_arg,
        ],
    ];
    let recovery = DataLease::recovery(cache, &[source.clone()])?;
    for command in &mutations {
        let result = run(core, &home, command)?;
        ensure!(
            !result.status.success(),
            "maintenance entered exclusive recovery: {command:?}"
        );
        ensure!(
            String::from_utf8_lossy(&result.stderr)
                .contains("update recovery blocked data maintenance"),
            "unexpected refusal: {:?}",
            result
        );
    }
    let export = ["export", "--from", source_arg, "--out", archive_arg];
    ensure!(
        !run(core, &home, &export)?.status.success(),
        "export entered exclusive recovery"
    );
    ensure!(
        run(core, &home, &["location"])?.status.success(),
        "read-only location blocked"
    );
    ensure!(
        !target.exists() && !archive.exists(),
        "blocked commands wrote output"
    );
    ensure!(
        fs::read_to_string(source.join("content.txt"))? == "unchanged",
        "blocked commands changed source"
    );
    drop(recovery);
    let writer = DataLease::writer(cache, &[source.clone()])?;
    for command in &mutations {
        let result = run(core, &home, command)?;
        ensure!(
            !result.status.success(),
            "maintenance entered live runtime: {command:?}"
        );
        ensure!(
            String::from_utf8_lossy(&result.stderr)
                .contains("data maintenance requires stopped runtimes"),
            "unexpected refusal: {:?}",
            result
        );
    }
    ensure!(
        run(core, &home, &export)?.status.success() && archive.is_file(),
        "online export failed"
    );
    ensure!(
        fs::read(&archive)?.starts_with(b"RYU-DX01"),
        "online export was not encrypted"
    );
    drop(writer);
    ensure!(
        run(core, &home, &mutations[2])?.status.success(),
        "stopped-runtime profile copy failed"
    );
    ensure!(
        fs::read_to_string(target.join("content.txt"))? == "unchanged",
        "profile copy lost content"
    );
    println!(
        "{}",
        serde_json::json!({"exclusiveRecoveryBlocksMaintenance": true, "liveRuntimeBlocksMutations": true, "onlineExportWorks": true, "locationWorksDuringRecovery": true, "blockedCommandsPreserveData": true, "copyWorksAfterRuntimeStops": true})
    );
    Ok(())
}

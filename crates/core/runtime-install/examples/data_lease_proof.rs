//! Real-process proof that a killed runtime releases its data lease.
use anyhow::{ensure, Result};
use ryu_runtime_install::data_lease::DataLease;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{Duration, Instant},
};

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--writer") {
        let base = PathBuf::from(&args[2]);
        let _lease = DataLease::writer(&base.join("cache"), &[base.join("data/nested")])?;
        fs::write(base.join("writer-ready"), "ready")?;
        std::thread::sleep(Duration::from_secs(60));
        return Ok(());
    }
    let base = tempfile::tempdir()?;
    fs::create_dir_all(base.path().join("data/nested"))?;
    let mut writer = Command::new(std::env::current_exe()?)
        .arg("--writer")
        .arg(base.path())
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !base.path().join("writer-ready").exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    ensure!(
        base.path().join("writer-ready").exists(),
        "runtime did not acquire its lease"
    );
    ensure!(
        DataLease::recovery(&base.path().join("cache"), &[base.path().join("data")]).is_err(),
        "live runtime did not exclude checkpoint capture"
    );
    writer.kill()?;
    writer.wait()?;
    let recovery = DataLease::recovery(&base.path().join("cache"), &[base.path().join("data")])?;
    let status = Command::new(std::env::current_exe()?)
        .arg("--writer")
        .arg(base.path())
        .status()?;
    ensure!(
        !status.success(),
        "runtime opened captured data during recovery"
    );
    drop(recovery);
    println!(
        "{}",
        serde_json::json!({"liveWriterBlocksCapture":true,"writerDeathReleasesLease":true,"recoveryBlocksNewWriter":true})
    );
    Ok(())
}

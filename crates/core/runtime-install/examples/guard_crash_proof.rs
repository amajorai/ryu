//! Windows real-process proof: killing the guard kills all provisional writers,
//! and a fresh guard restores the coherent previous app/data checkpoint.
use anyhow::{ensure, Result};
use ryu_runtime_install::{
    recovery::RecoveryCheckpoint,
    supervision::{identify_process, ProcessCommand, SupervisionPlan},
};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--fixture") {
        let root = PathBuf::from(&args[2]);
        match args[3].as_str() {
            "install" => {
                fs::write(root.join("app"), "app-2")?;
                std::thread::sleep(Duration::from_millis(400));
            }
            "app" => {
                ryu_runtime_install::handoff::write_json(
                    &root.join("app-pid"),
                    &std::process::id(),
                )?;
                let mut command = std::process::Command::new(std::env::current_exe()?);
                command.args(["--fixture", root.to_str().unwrap(), "worker"]);
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x08000000);
                }
                let child = command.spawn()?;
                ryu_runtime_install::handoff::write_json(&root.join("worker-pid"), &child.id())?;
                std::thread::sleep(Duration::from_secs(60));
            }
            "worker" => loop {
                fs::write(root.join("data/value"), "uncommitted-writer")?;
                std::thread::sleep(Duration::from_millis(25));
            },
            "previous" => {
                fs::write(root.join("previous-started"), "yes")?;
            }
            _ => anyhow::bail!("unknown fixture"),
        }
        return Ok(());
    }
    ensure!(
        cfg!(windows),
        "this containment proof requires Windows jobs"
    );
    let base = tempfile::tempdir()?;
    fs::write(base.path().join("app"), "app-1")?;
    fs::create_dir(base.path().join("data"))?;
    fs::write(base.path().join("data/value"), "old-data")?;
    let checkpoint = RecoveryCheckpoint::create(
        base.path().join("checkpoint"),
        &[base.path().join("app"), base.path().join("data")],
        "1".into(),
        "2".into(),
        "dev".into(),
    )?;
    let command = |mode: &str| ProcessCommand {
        executable: std::env::current_exe().unwrap(),
        arguments: vec![
            "--fixture".into(),
            base.path().to_string_lossy().into_owned(),
            mode.into(),
        ],
        environment: BTreeMap::new(),
    };
    let plan = SupervisionPlan {
        data_lease_cache: None,
        installer: command("install"),
        rollback_installer: None,
        application: command("app"),
        previous_application: command("previous"),
        nonce: "crash-proof-nonce".into(),
        startup_timeout_seconds: 120,
        installer_timeout_seconds: 5,
    };
    fs::write(
        checkpoint.root().join("supervision-plan.json"),
        serde_json::to_vec(&plan)?,
    )?;
    let root = checkpoint.root().to_path_buf();
    drop(checkpoint);
    let guard = std::env::current_exe()?
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("ryu-update-guard.exe");
    let mut original = std::process::Command::new(&guard).arg(&root).spawn()?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while (!base.path().join("worker-pid").exists()
        || fs::read_to_string(base.path().join("data/value"))
            .ok()
            .as_deref()
            != Some("uncommitted-writer"))
        && Instant::now() < deadline
    {
        if let Some(status) = original.try_wait()? {
            anyhow::bail!("guard exited before writer startup: {status}");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    if !base.path().join("worker-pid").exists() {
        original.kill()?;
        original.wait()?;
        anyhow::bail!("provisional worker did not start within deadline");
    }
    let app_pid: u32 = fs::read_to_string(base.path().join("app-pid"))?.parse()?;
    let worker_pid: u32 = fs::read_to_string(base.path().join("worker-pid"))?.parse()?;
    let killed_guard_pid = original.id();
    original.kill()?;
    original.wait()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while (identify_process(app_pid).is_some() || identify_process(worker_pid).is_some())
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(25));
    }
    ensure!(
        identify_process(app_pid).is_none() && identify_process(worker_pid).is_none(),
        "guard death left provisional writers alive"
    );
    let status = std::process::Command::new(&guard)
        .arg("--recover")
        .arg(&root)
        .status()?;
    ensure!(status.success(), "replacement guard failed recovery");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !base.path().join("previous-started").exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    ensure!(
        fs::read_to_string(base.path().join("app"))? == "app-1"
            && fs::read_to_string(base.path().join("data/value"))? == "old-data",
        "replacement guard did not restore coherent previous state"
    );
    ensure!(
        base.path().join("previous-started").exists(),
        "previous app did not restart"
    );
    println!(
        "{}",
        serde_json::json!({"killed_guard_pid":killed_guard_pid,"app_pid":app_pid,"worker_pid":worker_pid,"writers_stopped_on_guard_death":true,"app":"app-1","data":"old-data","previous_restarted":true})
    );
    Ok(())
}

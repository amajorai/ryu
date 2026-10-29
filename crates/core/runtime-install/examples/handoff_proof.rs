//! Proves that checkpoint capture happens after the old desktop's final write.
use anyhow::{ensure, Context, Result};
use ryu_runtime_install::{
    handoff::{HandoffReady, HandoffRequest},
    startup::PendingRecovery,
    supervision::{identify_process, ProcessCommand, SupervisionOutcome, SupervisionPlan},
};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|argument| argument == "--fixture") {
        let root = PathBuf::from(&args[2]);
        match args[3].as_str() {
            "desktop" | "desktop-crash" | "desktop-blocked" => {
                let namespace = root.join("recovery");
                let handoff = namespace.join("handoffs/update-proof");
                fs::create_dir_all(&handoff)?;
                let writer = if args[3] == "desktop-crash" {
                    let mut command = std::process::Command::new(std::env::current_exe()?);
                    command.args(["--fixture", root.to_str().unwrap(), "writer"]);
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        command.creation_flags(0x08000000);
                    }
                    let child = command.spawn()?;
                    ryu_runtime_install::handoff::write_json(
                        &root.join("writer-pid"),
                        &child.id(),
                    )?;
                    Some(child)
                } else {
                    None
                };
                let command = |mode: &str| ProcessCommand {
                    executable: std::env::current_exe().unwrap(),
                    arguments: vec![
                        "--fixture".into(),
                        root.to_string_lossy().into_owned(),
                        mode.into(),
                    ],
                    environment: BTreeMap::new(),
                };
                let request = HandoffRequest {
                    schema: 1,
                    namespace: namespace.clone(),
                    profiles: vec!["dev".into()],
                    parent: identify_process(std::process::id()).unwrap(),
                    targets: vec![root.join("app"), root.join("data")],
                    previous_version: "1".into(),
                    expected_version: "2".into(),
                    target_profile: "dev".into(),
                    pending: PendingRecovery {
                        schema: 1,
                        transaction: "update-proof".into(),
                        nonce: "handoff-proof-nonce".into(),
                        runtime_required: true,
                        application: root.join("app"),
                    },
                    plan: SupervisionPlan {
                        data_lease_cache: Some(root.join("leases")),
                        installer: command("install"),
                        rollback_installer: None,
                        application: command("fail"),
                        previous_application: command("previous"),
                        nonce: "handoff-proof-nonce".into(),
                        startup_timeout_seconds: 5,
                        installer_timeout_seconds: 5,
                    },
                };
                ryu_runtime_install::handoff::write_json(&handoff.join("request.json"), &request)?;
                let guard = std::env::current_exe()?
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .join(if cfg!(windows) {
                        "ryu-update-guard.exe"
                    } else {
                        "ryu-update-guard"
                    });
                let mut child = std::process::Command::new(guard)
                    .arg("--handoff")
                    .arg(&handoff)
                    .spawn()?;
                let deadline = Instant::now() + Duration::from_secs(10);
                while !handoff.join("ready.json").exists() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
                let ready: HandoffReady =
                    serde_json::from_slice(&fs::read(handoff.join("ready.json"))?)?;
                ensure!(
                    ready.guard.pid == child.id() && ready.nonce == request.plan.nonce,
                    "wrong handoff acknowledgement"
                );
                if let Some(writer) = writer {
                    let receipt: Vec<ryu_runtime_install::supervision::ProcessIdentity> =
                        serde_json::from_slice(&fs::read(handoff.join("old-writers.json"))?)?;
                    ensure!(
                        receipt.iter().any(|process| process.pid == writer.id()),
                        "writer missing from durable receipt"
                    );
                    child.kill()?;
                    child.wait()?;
                    drop(writer); // Deliberately leave the writer after desktop exit.
                    return Ok(());
                }
                ensure!(
                    !namespace.join("transactions/update-proof").exists(),
                    "checkpoint was copied while the desktop was still writing"
                );
                fs::write(root.join("data/value"), "desktop-final-write")?;
                drop(child);
            }
            "install" => {
                fs::write(root.join("installer-started"), "yes")?;
                fs::write(root.join("app"), "new-app")?;
                fs::write(root.join("data/value"), "new-schema")?;
                std::thread::sleep(Duration::from_millis(400));
            }
            "fail" => {
                std::thread::sleep(Duration::from_millis(400));
                std::process::exit(17);
            }
            "previous" => {
                fs::write(root.join("previous-started"), "yes")?;
            }
            "writer" => loop {
                fs::write(root.join("data/value"), "old-desktop-writer")?;
                std::thread::sleep(Duration::from_millis(25));
            },
            _ => anyhow::bail!("unknown fixture"),
        }
        return Ok(());
    }
    let mut evidence = Vec::new();
    for scenario in ["desktop", "desktop-crash", "desktop-blocked"] {
        println!("Running handoff scenario: {scenario}");
        let base = tempfile::tempdir()?;
        fs::write(base.path().join("app"), "old-app")?;
        fs::create_dir(base.path().join("data"))?;
        fs::write(base.path().join("data/value"), "before-desktop-exit")?;
        let blocked_writer = if scenario == "desktop-blocked" {
            Some(ryu_runtime_install::data_lease::DataLease::writer(
                &base.path().join("leases"),
                &[base.path().join("data")],
            )?)
        } else {
            None
        };
        let status = std::process::Command::new(std::env::current_exe()?)
            .args(["--fixture", base.path().to_str().unwrap(), scenario])
            .status()?;
        ensure!(status.success(), "fixture desktop failed");
        if scenario == "desktop-crash" {
            ensure!(
                !base
                    .path()
                    .join("recovery/transactions/update-proof")
                    .exists(),
                "crash was not before checkpoint"
            );
            let guard = std::env::current_exe()?
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join(if cfg!(windows) {
                    "ryu-update-guard.exe"
                } else {
                    "ryu-update-guard"
                });
            let status = std::process::Command::new(guard)
                .arg("--handoff")
                .arg(base.path().join("recovery/handoffs/update-proof"))
                .status()?;
            ensure!(status.success(), "replacement handoff guard failed");
            let writer: u32 = fs::read_to_string(base.path().join("writer-pid"))?
                .trim()
                .parse()?;
            ensure!(
                identify_process(writer).is_none(),
                "pre-checkpoint writer survived recovery"
            );
        }
        let outcome_path = base
            .path()
            .join("recovery/handoffs/update-proof/outcome.json");
        let deadline = Instant::now() + Duration::from_secs(15);
        while (!outcome_path.exists() || !base.path().join("previous-started").exists())
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(50));
        }
        let outcome: SupervisionOutcome =
            serde_json::from_slice(&fs::read(&outcome_path).with_context(|| {
                format!(
                    "scenario {scenario}: durable outcome missing; previous_started={}",
                    base.path().join("previous-started").exists()
                )
            })?)?;
        ensure!(
            matches!(outcome, SupervisionOutcome::Restored { .. }),
            "failed boot was not restored"
        );
        if scenario == "desktop-blocked" {
            ensure!(
                !base.path().join("installer-started").exists(),
                "installer ran despite live captured-data writer"
            );
            ensure!(
                !base
                    .path()
                    .join("recovery/transactions/update-proof")
                    .exists(),
                "blocked capture published a checkpoint"
            );
        }
        ensure!(
            fs::read_to_string(base.path().join("app"))? == "old-app",
            "app was not restored"
        );
        let expected = if scenario == "desktop" || scenario == "desktop-blocked" {
            "desktop-final-write"
        } else {
            "old-desktop-writer"
        };
        ensure!(
            fs::read_to_string(base.path().join("data/value"))? == expected,
            "final desktop write was missing from the checkpoint"
        );
        evidence.push(serde_json::json!({"scenario":scenario,"outcome": outcome, "captured_after_desktop_exit": scenario == "desktop", "writer_stopped_before_reopen": scenario == "desktop-crash", "restored_data": expected, "previous_restarted": base.path().join("previous-started").exists()}));
        drop(blocked_writer);
    }
    println!("{}", serde_json::to_string_pretty(&evidence)?);
    Ok(())
}

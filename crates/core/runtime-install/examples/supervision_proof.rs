//! Actual-process recovery proof. Does not install or alter the user's app/data.
use anyhow::{ensure, Result};
use ryu_runtime_install::{
    recovery::RecoveryCheckpoint,
    supervision::{
        self, ProcessCommand, StartupAcknowledgement, SupervisionOutcome, SupervisionPlan,
    },
};
use std::{collections::BTreeMap, fs, path::PathBuf};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--fixture") {
        let root = PathBuf::from(&args[2]);
        match args[3].as_str() {
            "install-orphan-worker" => {
                fs::write(root.join("app"), "app-2")?;
                let status = std::process::Command::new(std::env::current_exe()?)
                    .args(["--fixture", root.to_str().unwrap(), "launch-writer"])
                    .status()?;
                ensure!(status.success(), "writer launcher failed");
            }
            "launch-writer" => {
                let child = std::process::Command::new(std::env::current_exe()?)
                    .args(["--fixture", root.to_str().unwrap(), "orphan-writer"])
                    .spawn()?;
                ryu_runtime_install::handoff::write_json(&root.join("orphan-pid"), &child.id())?;
            }
            "orphan-writer" => loop {
                fs::write(root.join("data/schema"), "uncommitted-orphan")?;
                std::thread::sleep(std::time::Duration::from_millis(25));
            },
            "install" | "install-receipt-fail" => {
                fs::write(root.join("app"), "app-2")?;
                fs::write(root.join("data/schema"), "schema-2")?;
                std::thread::sleep(std::time::Duration::from_millis(400));
                if args[3] == "install-receipt-fail" {
                    let receipt = root.join("checkpoint/owned-processes.json");
                    if receipt.is_file() {
                        fs::remove_file(&receipt)?;
                    }
                    fs::create_dir(receipt)?;
                }
            }
            "install-fail" | "install-hang" | "rollback-hang" => {
                fs::write(root.join("app"), "partial-app-2")?;
                std::thread::sleep(std::time::Duration::from_millis(400));
                if args[3] == "install-hang" || args[3] == "rollback-hang" {
                    fs::write(
                        root.join("hung-installer-pid"),
                        std::process::id().to_string(),
                    )?;
                    std::thread::sleep(std::time::Duration::from_secs(20));
                }
                std::process::exit(23);
            }
            "boot-fail" => {
                fs::write(root.join("data/migration-created"), "new")?;
                std::thread::sleep(std::time::Duration::from_secs(2));
                std::process::exit(17);
            }
            "boot-ok" | "boot-wrong-version" | "boot-wrong-nonce" | "boot-wrong-pid"
            | "boot-no-renderer" | "boot-no-runtime" => {
                let checkpoint = RecoveryCheckpoint::observe(root.join("checkpoint"))?;
                let pid = std::process::id();
                let mut system = sysinfo::System::new();
                system.refresh_processes_specifics(
                    sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
                    true,
                    sysinfo::ProcessRefreshKind::nothing(),
                );
                let start_time = system
                    .process(sysinfo::Pid::from_u32(pid))
                    .unwrap()
                    .start_time();
                supervision::write_acknowledgement(
                    &checkpoint,
                    &StartupAcknowledgement {
                        version: if args[3] == "boot-wrong-version" {
                            "1"
                        } else {
                            "2"
                        }
                        .into(),
                        nonce: if args[3] == "boot-wrong-nonce" {
                            "stale-nonce"
                        } else {
                            "fixture-nonce"
                        }
                        .into(),
                        pid: if args[3] == "boot-wrong-pid" {
                            pid + 1
                        } else {
                            pid
                        },
                        start_time,
                        renderer_ready: args[3] != "boot-no-renderer",
                        runtime_ready: args[3] != "boot-no-runtime",
                    },
                )?;
                std::thread::sleep(std::time::Duration::from_secs(if args[3] == "boot-ok" {
                    10
                } else {
                    20
                }));
            }
            "previous" => {
                fs::write(root.join("previous-restarted"), "yes")?;
            }
            _ => anyhow::bail!("unknown fixture mode"),
        }
        return Ok(());
    }
    let mut evidence = Vec::new();
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
    ensure!(
        guard.is_file(),
        "build ryu-update-guard alongside this example first"
    );
    for scenario in [
        "boot-fail",
        "boot-ok",
        "install-fail",
        "install-hang",
        "install-orphan-worker",
        "rollback-hang",
        "boot-receipt-fail",
        "boot-wrong-version",
        "boot-wrong-nonce",
        "boot-wrong-pid",
        "boot-no-renderer",
        "boot-no-runtime",
    ] {
        let started = std::time::Instant::now();
        let failure = scenario != "boot-ok";
        let base = tempfile::tempdir()?;
        fs::write(base.path().join("app"), "app-1")?;
        fs::create_dir(base.path().join("data"))?;
        fs::write(base.path().join("data/schema"), "schema-1")?;
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
            rollback_installer: (scenario == "rollback-hang").then(|| command("rollback-hang")),
            installer: command(if scenario.starts_with("install-") {
                scenario
            } else if scenario == "rollback-hang" {
                "install-fail"
            } else if scenario == "boot-receipt-fail" {
                "install-receipt-fail"
            } else {
                "install"
            }),
            application: command(if scenario == "boot-receipt-fail" {
                "boot-fail"
            } else if scenario.starts_with("install-") {
                "boot-ok"
            } else {
                scenario
            }),
            previous_application: command("previous"),
            nonce: "fixture-nonce".into(),
            startup_timeout_seconds: if scenario == "boot-fail" || scenario == "boot-ok" {
                10
            } else {
                1
            },
            installer_timeout_seconds: if scenario == "install-hang" || scenario == "rollback-hang"
            {
                1
            } else {
                5
            },
        };
        let checkpoint_root = checkpoint.root().to_path_buf();
        fs::write(
            checkpoint_root.join("supervision-plan.json"),
            serde_json::to_vec(&plan)?,
        )?;
        drop(checkpoint);
        let status = std::process::Command::new(&guard)
            .arg(&checkpoint_root)
            .status()?;
        let supervisor: serde_json::Value =
            serde_json::from_slice(&fs::read(checkpoint_root.join("supervision-outcome.json"))?)?;
        if scenario == "rollback-hang" {
            ensure!(!status.success(), "hung rollback unexpectedly succeeded");
            ensure!(
                supervisor["error"]
                    .as_str()
                    .is_some_and(|error| error.contains("previous package installer timed out")),
                "wrong rollback failure: {supervisor}"
            );
            let pid: u32 = fs::read_to_string(base.path().join("hung-installer-pid"))?.parse()?;
            ensure!(
                supervision::identify_process(pid).is_none(),
                "hung rollback writer survived"
            );
            ensure!(
                !base.path().join("previous-restarted").exists(),
                "old app reopened before compensation finished"
            );
            ensure!(
                checkpoint_root.join("recovery.json").exists(),
                "checkpoint was lost"
            );
            ensure!(
                started.elapsed().as_secs() < 15,
                "rollback timeout was not bounded"
            );
            evidence.push(serde_json::json!({"scenario": scenario, "supervisor": supervisor, "writer_stopped": true, "checkpoint_retained": true, "elapsed_ms": started.elapsed().as_millis()}));
            continue;
        }
        ensure!(status.success(), "supervisor failed: {supervisor}");
        ensure!(
            supervisor["guard_pid"].as_u64() != Some(std::process::id() as u64),
            "supervisor was not independent"
        );
        let outcome: SupervisionOutcome = serde_json::from_value(supervisor["outcome"].clone())?;
        if let SupervisionOutcome::Restored { reason } = &outcome {
            let expected_reason = match scenario {
                "boot-fail" => "exit code: 17",
                "install-fail" => "exit code: 23",
                "install-hang" => "installer timed out",
                "install-orphan-worker" => "live",
                "boot-receipt-fail" => "updated app ownership receipt failed",
                _ => "did not acknowledge healthy startup",
            };
            ensure!(
                reason.contains(expected_reason),
                "scenario {scenario} recovered for the wrong reason: {supervisor}"
            );
        }
        let app = fs::read_to_string(base.path().join("app"))?;
        let data = fs::read_to_string(base.path().join("data/schema"))?;
        if failure {
            if scenario == "install-orphan-worker" {
                let pid: u32 = fs::read_to_string(base.path().join("orphan-pid"))?
                    .trim()
                    .parse()?;
                ensure!(
                    supervision::identify_process(pid).is_none(),
                    "orphan installer writer survived restore"
                );
            }
            ensure!(
                matches!(outcome, SupervisionOutcome::Restored { .. })
                    && app == "app-1"
                    && data == "schema-1",
                "failed boot did not restore the coherent old state"
            );
            ensure!(
                !base.path().join("data/migration-created").exists(),
                "failed migration data remained selected"
            );
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !base.path().join("previous-restarted").exists()
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            ensure!(
                base.path().join("previous-restarted").exists(),
                "previous app did not restart"
            );
        } else {
            ensure!(
                outcome == SupervisionOutcome::Committed && app == "app-2" && data == "schema-2",
                "healthy boot did not commit: {supervisor}, app={app}, data={data}"
            );
        }
        evidence.push(serde_json::json!({ "scenario": scenario, "supervisor": supervisor, "app": app, "data": data, "elapsed_ms": started.elapsed().as_millis() }));
    }
    println!("{}", serde_json::to_string_pretty(&evidence)?);
    Ok(())
}

//! Prepare an isolated checkpoint for the real native app/guard handshake.
//! Installation bytes are unchanged; this is not a signed installer proof.
use anyhow::{ensure, Context, Result};
use ryu_runtime_install::{
    handoff::write_json,
    recovery::RecoveryCheckpoint,
    startup::{publish_pending, PendingRecovery},
    supervision::{ProcessCommand, SupervisionPlan},
};
use std::{collections::BTreeMap, fs, path::PathBuf};

fn verify_namespace(namespace: &std::path::Path) -> Result<()> {
    let expected =
        PathBuf::from(std::env::var_os("LOCALAPPDATA").context("missing Windows cache root")?)
            .join("ryu-update-recovery/com.ryu.update-proof");
    ensure!(
        namespace == expected,
        "only the private test bundle cache is allowed"
    );
    Ok(())
}

fn verify_data_path(data: &std::path::Path) -> Result<()> {
    ensure!(
        data.is_absolute()
            && data.starts_with(std::env::temp_dir().join("ryu-native-startup-proof")),
        "data must be inside the dedicated temporary proof root"
    );
    ensure!(
        !data
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir)),
        "proof data path traverses a parent"
    );
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--verify-checkpoint") {
        let namespace = PathBuf::from(std::env::var_os("LOCALAPPDATA").context("missing cache")?)
            .join("ryu-update-recovery/com.ryu.update-proof");
        verify_namespace(&namespace)?;
        let root = fs::canonicalize(args.get(2).context("missing checkpoint")?)?;
        ensure!(
            root.parent() == Some(fs::canonicalize(namespace.join("transactions"))?.as_path()),
            "checkpoint is outside the private proof namespace"
        );
        let checkpoint = RecoveryCheckpoint::observe(root)?;
        checkpoint.verify_snapshots()?;
        println!("private checkpoint integrity verified");
        return Ok(());
    }
    if args.get(1).is_some_and(|arg| arg == "--stop-isolated") {
        let data = fs::canonicalize(args.get(2).context("missing isolated data root")?)?;
        let boundary = fs::canonicalize(std::env::temp_dir().join("ryu-native-startup-proof"))?;
        ensure!(
            data.starts_with(&boundary),
            "runtime receipt is outside the private proof root"
        );
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(data.join("state").join("ryu-core.pid"))?)?;
        let pid = receipt["pid"].as_u64().context("receipt has no pid")?;
        let identity = ryu_runtime_install::supervision::identify_process(u32::try_from(pid)?);
        if let Some(identity) = identity {
            ensure!(
                receipt["start_time"].as_u64() == Some(identity.start_time)
                    && fs::canonicalize(
                        receipt["executable"]
                            .as_str()
                            .context("receipt has no executable")?
                    )? == identity.executable,
                "runtime receipt no longer identifies this process"
            );
            if data.join("dev-execution/worker.json").exists() {
                let status = std::process::Command::new(&identity.executable)
                    .arg("--stop-dev-execution")
                    .env("RYU_DIR", &data)
                    .env("RYU_PROFILE", "dev")
                    .env("RYU_KEYCHAIN", "off")
                    .env("RYU_PORT_OFFSET", "23000")
                    .status()?;
                ensure!(status.success(), "isolated worker shutdown failed");
            }
            if ryu_runtime_install::supervision::identify_process(identity.pid).is_some_and(
                |current| {
                    current.start_time == identity.start_time
                        && current.executable == identity.executable
                },
            ) {
                let system = sysinfo::System::new_all();
                if let Some(process) = system.process(sysinfo::Pid::from_u32(identity.pid)) {
                    let killed = process.kill();
                    ensure!(
                        killed
                            || !ryu_runtime_install::supervision::identify_process(identity.pid)
                                .is_some_and(|current| current.start_time == identity.start_time
                                    && current.executable == identity.executable),
                        "isolated facade shutdown failed"
                    );
                }
            }
        }
        return Ok(());
    }
    if args.get(1).is_some_and(|arg| arg == "--clear-terminal") {
        let namespace = PathBuf::from(args.get(2).context("missing namespace")?);
        verify_namespace(&namespace)?;
        let bytes = match fs::read(namespace.join("pending-dev.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let pending: PendingRecovery = serde_json::from_slice(&bytes)?;
        let observer =
            RecoveryCheckpoint::observe(namespace.join("transactions").join(&pending.transaction))?;
        ensure!(
            matches!(
                observer.read()?.phase,
                ryu_runtime_install::recovery::RecoveryPhase::Committed
                    | ryu_runtime_install::recovery::RecoveryPhase::Restored
            ),
            "cannot clear an unfinished proof"
        );
        ryu_runtime_install::startup::admit_startup(
            &namespace,
            "dev",
            "0.4.0",
            &pending.application,
            None,
        )?;
        return Ok(());
    }
    if args.get(1).is_some_and(|arg| arg == "--installer") {
        let data = PathBuf::from(args.get(2).context("missing installer data root")?);
        verify_data_path(&data)?;
        fs::write(data.join("value"), "candidate-data")?;
        return Ok(());
    }
    ensure!(
        args.len() == 6,
        "usage: native_startup_proof <app> <Core> <namespace> <data> <healthy|unhealthy>"
    );
    let application = fs::canonicalize(&args[1])?;
    let core = fs::canonicalize(&args[2])?;
    let namespace = PathBuf::from(&args[3]);
    verify_namespace(&namespace)?;
    ensure!(
        !namespace.join("pending-dev.json").exists(),
        "an earlier private proof still owns admission"
    );
    let data = PathBuf::from(&args[4]);
    verify_data_path(&data)?;
    let packaged = args[5].starts_with("package-");
    let unhealthy = matches!(args[5].as_str(), "unhealthy" | "package-unhealthy");
    let runtime_healthy = args[5] == "runtime-healthy";
    ensure!(
        unhealthy || runtime_healthy || matches!(args[5].as_str(), "healthy" | "package-healthy"),
        "unknown scenario"
    );
    fs::create_dir_all(&data)?;
    fs::write(data.join("value"), "previous-data")?;
    let transaction = format!("native-proof-{}", std::process::id());
    let nonce = format!("private-{transaction}");
    fs::create_dir_all(namespace.join("transactions"))?;
    let mut targets = vec![application.clone(), fs::canonicalize(&data)?];
    if packaged {
        ensure!(
            application.starts_with(fs::canonicalize(
                std::env::temp_dir().join("ryu-native-startup-proof")
            )?),
            "packaged application escaped the private proof root"
        );
        targets[0] = application
            .parent()
            .context("application has no directory")?
            .to_owned();
        for name in ["APPDATA", "LOCALAPPDATA"] {
            let root = PathBuf::from(std::env::var_os(name).context("missing app-data root")?)
                .join("com.ryu.update-proof");
            targets.push(root);
        }
    }
    let checkpoint = RecoveryCheckpoint::create(
        namespace.join("transactions").join(&transaction),
        &targets,
        "0.4.0".into(),
        if packaged { "0.4.1" } else { "0.4.0" }.into(),
        "dev".into(),
    )?;
    let mut environment = BTreeMap::from([
        ("RYU_PROFILE".into(), "dev".into()),
        ("RYU_KEYCHAIN".into(), "off".into()),
        ("RYU_DIR".into(), data.to_string_lossy().into_owned()),
        ("RYU_PORT_OFFSET".into(), "23000".into()),
        ("RYU_CORE_BIN".into(), core.to_string_lossy().into_owned()),
        (
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS".into(),
            "--remote-debugging-port=9275".into(),
        ),
    ]);
    if runtime_healthy {
        let gateway = fs::canonicalize(
            core.parent()
                .context("Core has no directory")?
                .join("ryu-gateway.exe"),
        )?;
        environment.insert(
            "RYU_GATEWAY_BIN".into(),
            gateway.to_string_lossy().into_owned(),
        );
    }
    let previous_application = ProcessCommand {
        executable: application.clone(),
        arguments: vec![],
        environment: environment.clone(),
    };
    environment.insert("RYU_UPDATE_NONCE".into(), nonce.clone());
    if unhealthy {
        environment.insert(
            "RYU_CORE_BIN".into(),
            data.join("missing-core.exe").to_string_lossy().into_owned(),
        );
    }
    let mut plan = SupervisionPlan {
        data_lease_cache: Some(
            namespace
                .parent()
                .context("namespace has no cache")?
                .to_owned(),
        ),
        installer: ProcessCommand {
            executable: std::env::current_exe()?,
            arguments: vec!["--installer".into(), data.to_string_lossy().into_owned()],
            environment: BTreeMap::new(),
        },
        rollback_installer: None,
        application: ProcessCommand {
            executable: application.clone(),
            arguments: vec![],
            environment,
        },
        previous_application,
        nonce: nonce.clone(),
        startup_timeout_seconds: if unhealthy { 30 } else { 120 },
        installer_timeout_seconds: 30,
    };
    if packaged {
        let worker = fs::canonicalize(
            std::env::var_os("RYU_PROOF_CACHED_WORKER").context("missing private cached worker")?,
        )?;
        let command = |name: &str| -> Result<ProcessCommand> {
            let manifest =
                fs::canonicalize(std::env::var_os(name).context("missing package manifest")?)?;
            ensure!(
                manifest.starts_with(fs::canonicalize(namespace.join("handoffs"))?),
                "package manifest escaped private cache"
            );
            Ok(ProcessCommand {
                executable: worker.clone(),
                arguments: vec![
                    "--ryu-install-cached".into(),
                    manifest.to_string_lossy().into_owned(),
                ],
                environment: BTreeMap::from([
                    ("RYU_PROFILE".into(), "dev".into()),
                    ("RYU_KEYCHAIN".into(), "off".into()),
                    ("RYU_DIR".into(), data.to_string_lossy().into_owned()),
                ]),
            })
        };
        plan.installer = command("RYU_PROOF_INSTALL_MANIFEST")?;
        plan.rollback_installer = Some(command("RYU_PROOF_ROLLBACK_MANIFEST")?);
        plan.installer_timeout_seconds = 120;
    }
    write_json(&checkpoint.root().join("supervision-plan.json"), &plan)?;
    publish_pending(
        &namespace,
        "dev",
        &PendingRecovery {
            schema: 1,
            transaction,
            nonce,
            runtime_required: unhealthy || runtime_healthy,
            application,
        },
    )?;
    println!(
        "{}",
        serde_json::json!({"checkpoint": checkpoint.root(), "data": data, "scenario": args[5]})
    );
    Ok(())
}

//! Invoke the shipping supervisor executable, rather than substituting its CLI parser.
use ryu_runtime_install::recovery::RecoveryCheckpoint;
use std::{fs, process::Command};

#[test]
fn relative_checkpoint_is_rejected_without_changing_local_records() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("user-record"), b"preserve me").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_ryu-update-guard"))
        .current_dir(directory.path())
        .arg("checkpoint")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("expected one absolute checkpoint path"));
    assert_eq!(
        fs::read(directory.path().join("user-record")).unwrap(),
        b"preserve me"
    );
    assert!(!directory.path().join("checkpoint").exists());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn corrupt_supervision_plan_leaves_checkpoint_and_user_data_recoverable() {
    let directory = tempfile::tempdir().unwrap();
    let data = directory.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::write(data.join("user-record"), b"preserve me").unwrap();
    fs::create_dir(directory.path().join("transactions")).unwrap();
    let checkpoint = RecoveryCheckpoint::create(
        directory.path().join("transactions/update-test"),
        std::slice::from_ref(&data),
        "1".into(),
        "2".into(),
        "dev".into(),
    )
    .unwrap();
    let checkpoint_root = checkpoint.root().to_owned();
    let original_journal = fs::read(checkpoint_root.join("recovery.json")).unwrap();
    fs::write(checkpoint_root.join("supervision-plan.json"), b"{").unwrap();
    drop(checkpoint);
    let output = Command::new(env!("CARGO_BIN_EXE_ryu-update-guard"))
        .arg(&checkpoint_root)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(error.contains("update supervision stopped"));
    assert!(
        error.contains("EOF while parsing"),
        "guard did not reach the malformed plan: {error}"
    );
    assert_eq!(fs::read(data.join("user-record")).unwrap(), b"preserve me");
    assert_eq!(
        fs::read(checkpoint_root.join("recovery.json")).unwrap(),
        original_journal
    );
    let reopened = RecoveryCheckpoint::open(checkpoint_root.clone()).unwrap();
    reopened.verify_snapshots().unwrap();
    let journal = reopened.read().unwrap();
    assert_eq!(journal.previous_version, "1");
    assert_eq!(journal.expected_version, "2");
    assert_eq!(journal.profile, "dev");
    assert_eq!(journal.roots.len(), 1);
    assert_eq!(journal.roots[0].target, fs::canonicalize(&data).unwrap());
    assert_eq!(
        fs::read(checkpoint_root.join("snapshot-0/user-record")).unwrap(),
        b"preserve me"
    );
    assert!(!checkpoint_root.join("supervision-outcome.json").exists());
}

/// A checkpoint whose plan is malformed, so a guard that gets past the
/// transaction lock stops with a parse error instead of supervising.
fn checkpoint_with_malformed_plan(directory: &std::path::Path) -> std::path::PathBuf {
    let data = directory.join("data");
    fs::create_dir(&data).unwrap();
    fs::create_dir(directory.join("transactions")).unwrap();
    let checkpoint = RecoveryCheckpoint::create(
        directory.join("transactions/update-test"),
        std::slice::from_ref(&data),
        "1".into(),
        "2".into(),
        "dev".into(),
    )
    .unwrap();
    let root = checkpoint.root().to_owned();
    fs::write(root.join("supervision-plan.json"), b"{").unwrap();
    root
}

/// Hold the transaction lock through a separate open file description, the
/// way a process forked by another thread holds Core's lease until it execs.
/// Blocking: the parallel cases here fork too, and one of their children can
/// briefly hold this checkpoint's dropped lease in exactly that way.
fn hold_transaction_lock(root: &std::path::Path) -> fs::File {
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("recovery.lock"))
        .unwrap();
    fs4::FileExt::lock_exclusive(&lock).unwrap();
    lock
}

#[test]
fn a_transaction_lock_released_moments_after_launch_does_not_stop_the_guard() {
    let directory = tempfile::tempdir().unwrap();
    let root = checkpoint_with_malformed_plan(directory.path());
    let lock = hold_transaction_lock(&root);
    let guard = Command::new(env!("CARGO_BIN_EXE_ryu-update-guard"))
        .arg(&root)
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    drop(lock);
    let output = guard.wait_with_output().unwrap();
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(
        error.contains("EOF while parsing"),
        "a lock held only briefly stopped the update: {error}"
    );
}

#[test]
fn a_transaction_lock_held_by_another_supervisor_still_refuses_the_guard() {
    let directory = tempfile::tempdir().unwrap();
    let root = checkpoint_with_malformed_plan(directory.path());
    let _lock = hold_transaction_lock(&root);
    let output = Command::new(env!("CARGO_BIN_EXE_ryu-update-guard"))
        .arg(&root)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(
        error.contains("another recovery supervisor owns this transaction"),
        "{error}"
    );
    assert!(!error.contains("EOF while parsing"), "{error}");
}

#[test]
fn argument_protocol_errors_stop_before_any_handoff_or_recovery_record_changes() {
    let directory = tempfile::tempdir().unwrap();
    let handoff = directory.path().join("handoff");
    fs::create_dir(&handoff).unwrap();
    fs::write(handoff.join("request.json"), b"{\"schema\":1}").unwrap();
    let cases: [(Vec<std::ffi::OsString>, &str); 4] = [
        (vec![], "missing checkpoint path"),
        (vec!["--recover".into()], "missing recovery checkpoint path"),
        (vec!["--handoff".into()], "missing handoff path"),
        (
            vec![
                "--handoff".into(),
                handoff.clone().into_os_string(),
                "extra".into(),
            ],
            "unexpected handoff arguments",
        ),
    ];
    for (arguments, expected) in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_ryu-update-guard"))
            .current_dir(directory.path())
            .args(&arguments)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{arguments:?}");
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(
            error.starts_with("update supervision stopped: ") && error.contains(expected),
            "{arguments:?}: {error}"
        );
    }
    assert_eq!(
        fs::read(handoff.join("request.json")).unwrap(),
        b"{\"schema\":1}"
    );
    assert_eq!(fs::read_dir(&handoff).unwrap().count(), 1);
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

/// Drive the shipping guard through installation, startup health and crash
/// recovery with real OS processes. `/bin/sh` scripts stand in only for the
/// external platform installer and the updated/previous applications.
#[cfg(unix)]
mod supervised_processes {
    use ryu_runtime_install::{
        handoff::{cancel_handoff, HandoffReady, HandoffRequest},
        recovery::{RecoveryCheckpoint, RecoveryPhase},
        startup::{admit_startup, publish_pending, PendingRecovery},
        supervision::{
            identify_process, write_acknowledgement, ProcessCommand, ProcessIdentity,
            StartupAcknowledgement, SupervisionPlan,
        },
    };
    use std::{
        collections::BTreeMap,
        ffi::OsStr,
        fs,
        io::Read,
        os::fd::AsRawFd,
        os::unix::process::ExitStatusExt,
        path::{Path, PathBuf},
        process::{Child, Command, ExitStatus, Stdio},
        time::{Duration, Instant},
    };

    const NONCE: &str = "cli-supervision-nonce";

    /// `$1` is always the lifeline; further paths follow as `$2`, `$3`, ...
    fn shell(lifeline: &Path, body: &str, paths: &[&Path]) -> ProcessCommand {
        let mut arguments = vec!["-c".to_owned(), body.to_owned(), "sh".to_owned()];
        arguments.push(lifeline.display().to_string());
        arguments.extend(paths.iter().map(|path| path.display().to_string()));
        ProcessCommand {
            executable: "/bin/sh".into(),
            arguments,
            environment: BTreeMap::new(),
        }
    }

    struct Transaction {
        home: tempfile::TempDir,
        data: PathBuf,
        root: PathBuf,
    }

    impl Transaction {
        /// Checkpoint user data the way Desktop does before handing off.
        fn prepare() -> Self {
            let home = tempfile::tempdir().unwrap();
            let data = home.path().join("data");
            fs::create_dir(&data).unwrap();
            fs::write(data.join("user-record"), b"v1 user data").unwrap();
            // Fixture processes loop only while this file exists, so a failed
            // assertion cannot leak a writer beyond the TempDir's removal.
            fs::write(home.path().join("lifeline"), b"").unwrap();
            fs::create_dir(home.path().join("transactions")).unwrap();
            let checkpoint = RecoveryCheckpoint::create(
                home.path().join("transactions/update-test"),
                std::slice::from_ref(&data),
                "1".into(),
                "2".into(),
                "dev".into(),
            )
            .unwrap();
            let root = checkpoint.root().to_owned();
            drop(checkpoint);
            Self { home, data, root }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.home.path().join(name)
        }

        fn script(&self, body: &str, paths: &[&Path]) -> ProcessCommand {
            shell(&self.path("lifeline"), body, paths)
        }

        fn marker(&self, name: &str) -> ProcessCommand {
            self.script(r#"printf "$$" > "$2""#, &[&self.path(name)])
        }

        fn save(&self, installer: ProcessCommand, application: ProcessCommand, startup: u64) {
            self.write_plan(&SupervisionPlan {
                data_lease_cache: None,
                installer,
                rollback_installer: None,
                application,
                previous_application: self.marker("previous-launched"),
                nonce: NONCE.into(),
                startup_timeout_seconds: startup,
                installer_timeout_seconds: 20,
            });
        }

        /// A failing forward installer, so the guard must run the previous
        /// package's installer before it restores the checkpointed data.
        fn save_compensated(&self, rollback: ProcessCommand, previous: ProcessCommand) {
            self.write_plan(&SupervisionPlan {
                data_lease_cache: None,
                installer: self.script(
                    r#"printf migrated > "$2"; exit 7"#,
                    &[&self.data.join("user-record")],
                ),
                rollback_installer: Some(rollback),
                application: self.marker("updated-launched"),
                previous_application: previous,
                nonce: NONCE.into(),
                startup_timeout_seconds: 5,
                installer_timeout_seconds: 20,
            });
        }

        fn write_plan(&self, plan: &SupervisionPlan) {
            fs::write(
                self.root.join("supervision-plan.json"),
                serde_json::to_vec(plan).unwrap(),
            )
            .unwrap();
        }

        fn phase(&self) -> RecoveryPhase {
            RecoveryCheckpoint::observe(self.root.clone())
                .unwrap()
                .read()
                .unwrap()
                .phase
        }

        fn evidence(&self) -> serde_json::Value {
            serde_json::from_slice(&fs::read(self.root.join("supervision-outcome.json")).unwrap())
                .unwrap()
        }

        fn assert_user_data_restored(&self) {
            let names: Vec<_> = fs::read_dir(&self.data)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            assert_eq!(names, ["user-record"], "restored data has foreign entries");
            assert_eq!(
                fs::read(self.data.join("user-record")).unwrap(),
                b"v1 user data"
            );
        }

        /// A writer that survived restoration would recreate its file here.
        fn assert_restoration_stays_quiet(&self) {
            self.assert_user_data_restored();
            std::thread::sleep(Duration::from_millis(400));
            self.assert_user_data_restored();
        }
    }

    fn launch_guard(arguments: &[&OsStr]) -> Child {
        Command::new(env!("CARGO_BIN_EXE_ryu-update-guard"))
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    fn finish(mut guard: Child) -> (ExitStatus, String) {
        let deadline = Instant::now() + Duration::from_secs(60);
        let status = loop {
            if let Some(status) = guard.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                guard.kill().unwrap();
                guard.wait().unwrap();
                panic!("update guard exceeded its bounded test window");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let mut stderr = String::new();
        guard
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        (status, stderr)
    }

    fn eventually(what: &str, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !condition() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn stopped(identity: &ProcessIdentity) -> bool {
        identify_process(identity.pid).is_none_or(|actual| actual.start_time != identity.start_time)
    }

    /// An updated-app fixture that publishes its PID, then runs until released.
    fn running_application(transaction: &Transaction) -> (ProcessCommand, PathBuf) {
        let pid_file = transaction.path("updated-pid");
        let application = transaction.script(
            r#"printf "$$" > "$2.tmp" && mv "$2.tmp" "$2"; while [ -e "$1" ]; do sleep 0.05; done"#,
            &[&pid_file],
        );
        (application, pid_file)
    }

    fn launched_identity(guard: &mut Child, pid_file: &Path) -> ProcessIdentity {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !pid_file.exists() {
            if let Some(status) = guard.try_wait().unwrap() {
                let mut stderr = String::new();
                guard
                    .stderr
                    .take()
                    .unwrap()
                    .read_to_string(&mut stderr)
                    .unwrap();
                panic!("guard stopped before launching the update ({status}): {stderr}");
            }
            assert!(
                Instant::now() < deadline,
                "updated application did not start"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let pid = fs::read_to_string(pid_file).unwrap().parse().unwrap();
        identify_process(pid).expect("updated application identity")
    }

    fn acknowledge(transaction: &Transaction, identity: &ProcessIdentity) {
        // Desktop publishes health through an observer while the guard holds the lease.
        let observer = RecoveryCheckpoint::observe(transaction.root.clone()).unwrap();
        write_acknowledgement(
            &observer,
            &StartupAcknowledgement {
                version: "2".into(),
                nonce: NONCE.into(),
                pid: identity.pid,
                start_time: identity.start_time,
                renderer_ready: true,
                runtime_ready: true,
            },
        )
        .unwrap();
    }

    #[test]
    fn failed_installer_restores_user_data_and_relaunches_only_the_previous_app() {
        let transaction = Transaction::prepare();
        let installer = transaction.script(
            r#"printf migrated > "$2"; printf partial > "$3"; exit 7"#,
            &[
                &transaction.data.join("user-record"),
                &transaction.data.join("partial-migration"),
            ],
        );
        transaction.save(installer, transaction.marker("updated-launched"), 5);
        let guard = launch_guard(&[transaction.root.as_os_str()]);
        let guard_pid = guard.id();
        let (status, stderr) = finish(guard);
        assert!(status.success(), "guard failed: {stderr}");
        let evidence = transaction.evidence();
        assert_eq!(evidence["guard_pid"], guard_pid);
        assert_eq!(
            evidence["outcome"]["Restored"]["reason"],
            "installer exited with exit status: 7"
        );
        assert_eq!(transaction.phase(), RecoveryPhase::Restored);
        transaction.assert_user_data_restored();
        let owned: Vec<ProcessIdentity> = serde_json::from_slice(
            &fs::read(transaction.root.join("owned-processes.json")).unwrap(),
        )
        .unwrap();
        let shell = fs::canonicalize("/bin/sh").unwrap();
        assert!(
            owned.iter().any(|process| process.executable == shell),
            "installer ownership receipt was not durable: {owned:?}"
        );
        eventually("previous application relaunch", || {
            transaction.path("previous-launched").exists()
        });
        assert!(!transaction.path("updated-launched").exists());
    }

    #[test]
    fn installer_exit_with_a_live_group_worker_stops_it_before_restoring_user_data() {
        let transaction = Transaction::prepare();
        let installer = transaction.script(
            r#"(while [ -e "$1" ]; do printf x >> "$2"; sleep 0.05; done) & printf migrated > "$3"; exit 0"#,
            &[
                &transaction.data.join("worker-log"),
                &transaction.data.join("user-record"),
            ],
        );
        transaction.save(installer, transaction.marker("updated-launched"), 5);
        let (status, stderr) = finish(launch_guard(&[transaction.root.as_os_str()]));
        assert!(status.success(), "guard failed: {stderr}");
        assert_eq!(
            transaction.evidence()["outcome"]["Restored"]["reason"],
            "installer exited with live contained workers"
        );
        assert_eq!(transaction.phase(), RecoveryPhase::Restored);
        transaction.assert_restoration_stays_quiet();
        eventually("previous application relaunch", || {
            transaction.path("previous-launched").exists()
        });
        assert!(!transaction.path("updated-launched").exists());
    }

    #[test]
    fn matching_startup_acknowledgement_commits_and_releases_the_updated_app() {
        let transaction = Transaction::prepare();
        let installer = transaction.script(
            r#"printf migrated > "$2""#,
            &[&transaction.data.join("user-record")],
        );
        let (application, pid_file) = running_application(&transaction);
        transaction.save(installer, application, 20);
        let mut guard = launch_guard(&[transaction.root.as_os_str()]);
        let updated = launched_identity(&mut guard, &pid_file);
        assert_eq!(transaction.phase(), RecoveryPhase::AwaitingHealth);
        acknowledge(&transaction, &updated);
        let (status, stderr) = finish(guard);
        assert!(status.success(), "guard failed: {stderr}");
        assert_eq!(transaction.evidence()["outcome"], "Committed");
        assert_eq!(transaction.phase(), RecoveryPhase::Committed);
        assert_eq!(
            fs::read(transaction.data.join("user-record")).unwrap(),
            b"migrated"
        );
        // Commit releases containment: the healthy app outlives its guard.
        assert!(!stopped(&updated), "committed application was stopped");
        assert!(!transaction.path("previous-launched").exists());
        fs::remove_file(transaction.path("lifeline")).unwrap();
        eventually("released application exit", || stopped(&updated));
    }

    #[test]
    fn acknowledgement_naming_another_live_process_cannot_commit_the_update() {
        let transaction = Transaction::prepare();
        let installer = transaction.script(
            r#"printf migrated > "$2""#,
            &[&transaction.data.join("user-record")],
        );
        let (application, pid_file) = running_application(&transaction);
        transaction.save(installer, application, 2);
        let mut guard = launch_guard(&[transaction.root.as_os_str()]);
        let updated = launched_identity(&mut guard, &pid_file);
        // Correct nonce and release, but this genuine live identity is not the app.
        let foreign = identify_process(std::process::id()).unwrap();
        acknowledge(&transaction, &foreign);
        let (status, stderr) = finish(guard);
        assert!(status.success(), "guard failed: {stderr}");
        assert_eq!(
            transaction.evidence()["outcome"]["Restored"]["reason"],
            "updated app did not acknowledge healthy startup"
        );
        assert_eq!(transaction.phase(), RecoveryPhase::Restored);
        assert!(stopped(&updated), "unhealthy application kept running");
        assert!(!stopped(&foreign));
        transaction.assert_restoration_stays_quiet();
        eventually("previous application relaunch", || {
            transaction.path("previous-launched").exists()
        });
    }

    #[test]
    fn updated_app_crashing_at_launch_with_a_live_worker_is_rolled_back() {
        let transaction = Transaction::prepare();
        let installer = transaction.script(
            r#"printf migrated > "$2""#,
            &[&transaction.data.join("user-record")],
        );
        // A helper outlives the crashed app inside its contained process group.
        let application = transaction.script(
            r#"(while [ -e "$1" ]; do printf x >> "$2"; sleep 0.05; done) & exit 3"#,
            &[&transaction.data.join("helper-log")],
        );
        transaction.save(installer, application, 20);
        let (status, stderr) = finish(launch_guard(&[transaction.root.as_os_str()]));
        assert!(status.success(), "guard failed: {stderr}");
        assert_eq!(
            transaction.evidence()["outcome"]["Restored"]["reason"],
            "updated app exited before health acknowledgement: exit status: 3"
        );
        assert_eq!(transaction.phase(), RecoveryPhase::Restored);
        transaction.assert_restoration_stays_quiet();
        eventually("previous application relaunch", || {
            transaction.path("previous-launched").exists()
        });
    }

    /// A shell binary replaced after it was launched. It stays reachable only
    /// through this test's open descriptor, so `/proc/<pid>/exe` of anything it
    /// runs names a deleted file and no process-identity check can match it.
    fn replaced_shell(transaction: &Transaction) -> (fs::File, PathBuf) {
        let copy = transaction.path("replaced-sh");
        fs::copy(fs::canonicalize("/bin/sh").unwrap(), &copy).unwrap();
        let open = fs::File::open(&copy).unwrap();
        fs::remove_file(&copy).unwrap();
        let path = PathBuf::from(format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            open.as_raw_fd()
        ));
        (open, path)
    }

    fn recover_after_refusal(transaction: &Transaction) {
        let guard = launch_guard(&[OsStr::new("--recover"), transaction.root.as_os_str()]);
        let (status, stderr) = finish(guard);
        assert!(status.success(), "recovery guard failed: {stderr}");
        assert_eq!(
            transaction.evidence()["outcome"]["Restored"]["reason"],
            "recovery guard interrupted before commit"
        );
        assert_eq!(transaction.phase(), RecoveryPhase::Restored);
        transaction.assert_restoration_stays_quiet();
        eventually("previous application relaunch", || {
            transaction.path("previous-launched").exists()
        });
        assert!(!transaction.path("updated-launched").exists());
    }

    #[test]
    fn previous_installer_worker_is_stopped_through_its_unreaped_leader_and_the_checkpoint_kept() {
        let transaction = Transaction::prepare();
        let (_replaced, helper) = replaced_shell(&transaction);
        let log = transaction.data.join("previous-installer-log");
        let runs = transaction.path("compensation-runs");
        // The first compensation exits as soon as its helper runs. No identity
        // matches the helper, so only the group its exited leader still anchors
        // can stop it. A retried compensation leaves no helper.
        let rollback = transaction.script(
            r#"printf run >> "$5"
if [ ! -e "$4" ]; then
  "$2" -c ': > "$3"; while [ -e "$1" ]; do printf x >> "$2"; sleep 0.05; done' helper "$1" "$3" "$4" &
  while [ ! -e "$4" ]; do sleep 0.01; done
fi"#,
            &[&helper, &log, &transaction.path("helper-ready"), &runs],
        );
        transaction.save_compensated(rollback, transaction.marker("previous-launched"));
        let (status, stderr) = finish(launch_guard(&[transaction.root.as_os_str()]));
        assert_eq!(status.code(), Some(1), "{stderr}");
        let refusal = "previous installer exited with live contained workers; checkpoint retained";
        assert!(stderr.contains(refusal), "{stderr}");
        assert_eq!(transaction.evidence()["error"], refusal);
        let written = fs::read(&log).unwrap();
        assert!(
            !written.is_empty(),
            "the helper never outlived its installer"
        );
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(
            fs::read(&log).unwrap(),
            written,
            "the previous installer's helper kept writing after the guard stopped"
        );
        // Unverified compensation restores nothing and relaunches nothing.
        assert_eq!(transaction.phase(), RecoveryPhase::Installing);
        assert_eq!(
            fs::read(transaction.data.join("user-record")).unwrap(),
            b"migrated"
        );
        assert!(!transaction.path("previous-launched").exists());
        RecoveryCheckpoint::open(transaction.root.clone())
            .unwrap()
            .verify_snapshots()
            .unwrap();
        // The next start's recovery reruns compensation, then restores.
        recover_after_refusal(&transaction);
        assert_eq!(fs::read_to_string(&runs).unwrap(), "runrun");
    }

    #[test]
    fn updated_app_whose_identity_never_verifies_is_refused_within_one_bounded_window() {
        let transaction = Transaction::prepare();
        let (_replaced, shell) = replaced_shell(&transaction);
        let installer = transaction.script(
            r#"printf migrated > "$2""#,
            &[&transaction.data.join("user-record")],
        );
        let heartbeat = transaction.path("unverified-heartbeat");
        let mut application = transaction.script(
            r#"while [ -e "$1" ]; do printf x >> "$2"; sleep 0.05; done"#,
            &[&heartbeat],
        );
        application.executable = shell;
        transaction.save(installer, application, 20);
        let started = Instant::now();
        let (status, stderr) = finish(launch_guard(&[transaction.root.as_os_str()]));
        let elapsed = started.elapsed();
        assert_eq!(status.code(), Some(1), "{stderr}");
        let refusal = "cannot verify the updated app process identity";
        assert!(stderr.contains(refusal), "{stderr}");
        assert_eq!(transaction.evidence()["error"], refusal);
        // One bounded identity window (about 2 s), not one per outer retry.
        assert!(
            elapsed < Duration::from_secs(15),
            "identity refusal took {elapsed:?}"
        );
        assert_eq!(transaction.phase(), RecoveryPhase::AwaitingHealth);
        // The app really ran, and its contained group stopped with the guard.
        let beats = fs::read(&heartbeat).unwrap();
        assert!(!beats.is_empty(), "the unverifiable app never ran");
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(
            fs::read(&heartbeat).unwrap(),
            beats,
            "the unverifiable app kept running"
        );
        recover_after_refusal(&transaction);
    }

    fn interrupt_installation(transaction: &Transaction, owned: &[ProcessIdentity]) {
        let checkpoint = RecoveryCheckpoint::open(transaction.root.clone()).unwrap();
        checkpoint.begin_installation().unwrap();
        fs::write(transaction.data.join("user-record"), b"half migrated").unwrap();
        fs::write(
            transaction.root.join("owned-processes.json"),
            serde_json::to_vec(owned).unwrap(),
        )
        .unwrap();
        drop(checkpoint);
        transaction.save(
            transaction.marker("installer-replayed"),
            transaction.marker("updated-launched"),
            5,
        );
    }

    fn assert_interrupted_recovery(transaction: &Transaction) {
        let guard = launch_guard(&[OsStr::new("--recover"), transaction.root.as_os_str()]);
        let (status, stderr) = finish(guard);
        assert!(status.success(), "recovery guard failed: {stderr}");
        assert_eq!(
            transaction.evidence()["outcome"]["Restored"]["reason"],
            "recovery guard interrupted before commit"
        );
        assert_eq!(transaction.phase(), RecoveryPhase::Restored);
        eventually("previous application relaunch", || {
            transaction.path("previous-launched").exists()
        });
        assert!(!transaction.path("installer-replayed").exists());
        assert!(!transaction.path("updated-launched").exists());
    }

    #[test]
    fn recovery_guard_stops_the_recorded_live_writer_before_restoring_user_data() {
        let transaction = Transaction::prepare();
        let log = transaction.data.join("writer-log");
        let mut writer = Command::new("/bin/sh")
            .args([
                "-c",
                r#"while [ -e "$1" ]; do printf x >> "$2"; sleep 0.05; done"#,
                "sh",
            ])
            .arg(transaction.path("lifeline"))
            .arg(&log)
            .spawn()
            .unwrap();
        eventually("interrupted writer activity", || log.exists());
        let identity = identify_process(writer.id()).unwrap();
        interrupt_installation(&transaction, &[identity]);
        assert_interrupted_recovery(&transaction);
        let status = writer.wait().unwrap();
        assert_eq!(status.signal(), Some(9), "recorded writer was not stopped");
        transaction.assert_restoration_stays_quiet();
    }

    #[test]
    fn recovery_guard_never_signals_a_reused_pid_with_another_start_time() {
        let transaction = Transaction::prepare();
        let mut unrelated = Command::new("/bin/sh")
            .args(["-c", r#"while [ -e "$1" ]; do sleep 0.05; done"#, "sh"])
            .arg(transaction.path("lifeline"))
            .spawn()
            .unwrap();
        let actual = identify_process(unrelated.id()).unwrap();
        // The receipt names an earlier process that once held this PID.
        let stale = ProcessIdentity {
            start_time: actual.start_time - 5,
            ..actual.clone()
        };
        interrupt_installation(&transaction, &[stale]);
        assert_interrupted_recovery(&transaction);
        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "unrelated process was signalled"
        );
        assert!(!stopped(&actual));
        transaction.assert_user_data_restored();
        fs::remove_file(transaction.path("lifeline")).unwrap();
        assert!(unrelated.wait().unwrap().success());
    }

    // Desktop -> guard handoff (`--handoff <directory>`): the guard must refuse
    // malformed or contested requests before it fences startup, signals the
    // desktop or captures data, and must stop old desktop writers before capture.

    /// A live desktop: it can start a helper that appends to user data and
    /// outlives the desktop, then runs until the test publishes `release`.
    struct Desktop {
        _home: tempfile::TempDir,
        root: PathBuf,
        namespace: PathBuf,
        data: PathBuf,
        process: Child,
        identity: ProcessIdentity,
        writer: Option<u32>,
    }

    impl Desktop {
        fn launch(with_writer: bool) -> Self {
            let home = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(home.path()).unwrap();
            let data = root.join("data");
            fs::create_dir(&data).unwrap();
            fs::write(data.join("user-record"), b"v1 user data").unwrap();
            fs::write(root.join("lifeline"), b"").unwrap();
            let namespace = root.join("recovery");
            fs::create_dir_all(namespace.join("handoffs")).unwrap();
            let writer_pid = root.join("writer-pid");
            let mut process = Command::new("/bin/sh")
                .args([
                    "-c",
                    // The helper appends without pausing, numbering each line, and
                    // then mirrors that number outside the captured data, so any
                    // capture taken while it still runs misses mirrored appends.
                    r#"if [ "$4" = writer ]; then /bin/sh -c 'printf "$$" > "$2.tmp" && mv "$2.tmp" "$2"; n=0; while [ -e "$1" ]; do n=$((n + 1)); printf "%s\n" "$n" >> "$3"; printf "%s\n" "$n" >> "$4"; done' writer "$1" "$5" "$6" "$7" & fi
printf ready > "$3.tmp" && mv "$3.tmp" "$3"
while [ -e "$1" ] && [ ! -e "$2" ]; do sleep 0.05; done"#,
                    "desktop",
                ])
                .arg(root.join("lifeline"))
                .arg(root.join("release"))
                .arg(root.join("desktop-ready"))
                .arg(if with_writer { "writer" } else { "none" })
                .arg(&writer_pid)
                .arg(data.join("desktop-log"))
                .arg(root.join("writer-progress"))
                // The guard SIGKILLs the helper; keep shell job notices out of
                // the test output.
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            eventually("desktop start", || {
                root.join("desktop-ready").exists() && (!with_writer || writer_pid.exists())
            });
            let identity = identify_process(process.id()).expect("desktop identity");
            assert!(process.try_wait().unwrap().is_none());
            let writer =
                with_writer.then(|| fs::read_to_string(&writer_pid).unwrap().parse().unwrap());
            Self {
                _home: home,
                root,
                namespace,
                data,
                process,
                identity,
                writer,
            }
        }

        fn command(&self, body: &str, paths: &[&Path]) -> ProcessCommand {
            shell(&self.root.join("lifeline"), body, paths)
        }

        fn marker(&self, name: &str) -> ProcessCommand {
            self.command(r#"printf "$$" > "$2""#, &[&self.root.join(name)])
        }

        /// Any launch of these commands leaves a durable marker file.
        fn plan(&self, installer: ProcessCommand, application: ProcessCommand) -> SupervisionPlan {
            SupervisionPlan {
                data_lease_cache: None,
                installer,
                rollback_installer: None,
                application,
                previous_application: self.marker("previous-launched"),
                nonce: NONCE.into(),
                startup_timeout_seconds: 5,
                installer_timeout_seconds: 20,
            }
        }

        fn request(
            &self,
            transaction: &str,
            profiles: &[&str],
            plan: SupervisionPlan,
        ) -> HandoffRequest {
            HandoffRequest {
                schema: 1,
                namespace: self.namespace.clone(),
                profiles: profiles
                    .iter()
                    .map(|profile| (*profile).to_owned())
                    .collect(),
                parent: self.identity.clone(),
                targets: vec![self.data.clone()],
                previous_version: "1".into(),
                expected_version: "2".into(),
                target_profile: profiles[0].to_owned(),
                pending: PendingRecovery {
                    schema: 1,
                    transaction: transaction.into(),
                    nonce: NONCE.into(),
                    runtime_required: false,
                    application: self.root.join("app"),
                },
                plan,
            }
        }

        fn submit(&self, directory_name: &str, bytes: &[u8]) -> PathBuf {
            let directory = self.namespace.join("handoffs").join(directory_name);
            fs::create_dir(&directory).unwrap();
            fs::write(directory.join("request.json"), bytes).unwrap();
            directory
        }

        fn marker_bytes(&self, profile: &str) -> Option<Vec<u8>> {
            fs::read(self.namespace.join(format!("pending-{profile}.json"))).ok()
        }

        fn assert_still_running(&mut self) {
            assert!(
                self.process.try_wait().unwrap().is_none(),
                "the guard signalled a desktop it never accepted"
            );
            assert!(!stopped(&self.identity));
        }

        fn assert_data_unchanged(&self) {
            let mut names: Vec<_> = fs::read_dir(&self.data)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            names.sort();
            assert_eq!(names, ["user-record"]);
            assert_eq!(
                fs::read(self.data.join("user-record")).unwrap(),
                b"v1 user data"
            );
            for launched in ["installer-ran", "updated-launched", "previous-launched"] {
                assert!(
                    !self.root.join(launched).exists(),
                    "{launched} after refusal"
                );
            }
        }
    }

    impl Drop for Desktop {
        fn drop(&mut self) {
            let _ = fs::remove_file(self.root.join("lifeline"));
            if self.process.try_wait().ok().flatten().is_none() {
                let _ = self.process.kill();
                let _ = self.process.wait();
            }
        }
    }

    fn entries(directory: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The length of a log of consecutive numbered lines `1\n2\n...`.
    fn numbered(bytes: &[u8], what: &str) -> u64 {
        let text = std::str::from_utf8(bytes).unwrap();
        let lines = text
            .strip_suffix('\n')
            .unwrap_or_else(|| panic!("{what} is empty or ends mid-append"));
        let mut count = 0;
        for line in lines.split('\n') {
            count += 1;
            assert_eq!(line.parse::<u64>().ok(), Some(count), "{what} line {count}");
        }
        count
    }

    fn refused_handoff(directory: &Path) -> String {
        let (status, stderr) = finish(launch_guard(&[
            OsStr::new("--handoff"),
            directory.as_os_str(),
        ]));
        assert_eq!(status.code(), Some(1), "{stderr}");
        assert!(
            stderr.starts_with("update supervision stopped: "),
            "{stderr}"
        );
        stderr
    }

    #[test]
    fn handoff_protocol_refusals_leave_the_live_desktop_fences_and_data_untouched() {
        let mut desktop = Desktop::launch(false);
        let plan = desktop.plan(
            desktop.marker("installer-ran"),
            desktop.marker("updated-launched"),
        );
        let variant = |transaction: &str, change: &dyn Fn(&mut HandoffRequest)| {
            let mut request = desktop.request(transaction, &["dev"], plan.clone());
            change(&mut request);
            serde_json::to_vec(&request).unwrap()
        };
        let mut oversized = variant("oversized", &|_| ());
        oversized.resize(1024 * 1024 + 1, b' ');
        let cases = [
            (
                "schema",
                variant("schema", &|request| request.schema = 2),
                "invalid update handoff",
            ),
            (
                "nonce",
                variant("nonce", &|request| {
                    request.plan.nonce = "replayed-nonce".into()
                }),
                "handoff nonce mismatch",
            ),
            (
                "unfenced",
                variant("unfenced", &|request| {
                    request.target_profile = "nightly".into()
                }),
                "target profile is not fenced",
            ),
            (
                "relative",
                variant("relative", &|request| request.targets = vec!["data".into()]),
                "handoff paths must be absolute",
            ),
            // A valid request whose directory names another transaction.
            (
                "escaped",
                variant("update-other", &|_| ()),
                "handoff escaped its namespace",
            ),
            (
                "oversized",
                oversized,
                "metadata is not a regular file within its byte limit",
            ),
        ];
        for (name, bytes, expected) in cases {
            let directory = desktop.submit(name, &bytes);
            let stderr = refused_handoff(&directory);
            assert!(stderr.contains(expected), "{name}: {stderr}");
            assert_eq!(entries(&directory), ["request.json"], "{name}");
            assert_eq!(fs::read(directory.join("request.json")).unwrap(), bytes);
            desktop.assert_still_running();
        }
        // Only the application-wide update lock may exist: no startup fence,
        // checkpoint or acknowledgement was published for any request.
        let namespace = entries(&desktop.namespace);
        assert!(
            namespace
                .iter()
                .all(|name| name == "handoffs" || name == "update.lock"),
            "{namespace:?}"
        );
        desktop.assert_data_unchanged();
    }

    #[test]
    fn refused_handoff_conserves_another_updates_fence_and_desktop_cleanup_releases_only_its_own() {
        let mut desktop = Desktop::launch(false);
        fs::create_dir(desktop.namespace.join("transactions")).unwrap();
        // Another, still unfinished update owns the nightly profile.
        drop(
            RecoveryCheckpoint::create(
                desktop.namespace.join("transactions/update-foreign"),
                std::slice::from_ref(&desktop.data),
                "1".into(),
                "3".into(),
                "nightly".into(),
            )
            .unwrap(),
        );
        let foreign = PendingRecovery {
            schema: 1,
            transaction: "update-foreign".into(),
            nonce: "foreign-nonce".into(),
            runtime_required: true,
            application: desktop.root.join("app"),
        };
        publish_pending(&desktop.namespace, "nightly", &foreign).unwrap();
        let foreign_marker = desktop.marker_bytes("nightly").unwrap();
        let request = desktop.request(
            "update-a",
            &["dev", "nightly"],
            desktop.plan(
                desktop.marker("installer-ran"),
                desktop.marker("updated-launched"),
            ),
        );
        let directory = desktop.submit("update-a", &serde_json::to_vec(&request).unwrap());
        let stderr = refused_handoff(&directory);
        assert!(
            stderr.contains("another update still owns this profile's startup fence"),
            "{stderr}"
        );
        desktop.assert_still_running();
        assert_eq!(desktop.marker_bytes("nightly").unwrap(), foreign_marker);
        // The earlier profile's fence stays until Desktop releases its handoff.
        let own: PendingRecovery =
            serde_json::from_slice(&desktop.marker_bytes("dev").unwrap()).unwrap();
        assert_eq!(
            (own.transaction.as_str(), own.nonce.as_str()),
            ("update-a", NONCE)
        );
        assert_eq!(entries(&directory), ["handoff.lock", "request.json"]);
        assert_eq!(
            entries(&desktop.namespace.join("transactions")),
            ["update-foreign"]
        );
        assert_eq!(
            RecoveryCheckpoint::observe(desktop.namespace.join("transactions/update-foreign"))
                .unwrap()
                .read()
                .unwrap()
                .phase,
            RecoveryPhase::Prepared
        );
        // Desktop's failed-accept cleanup removes only this update's fence and
        // reports, rather than deletes, the marker another update owns.
        let cleanup = cancel_handoff(&request).unwrap_err();
        assert!(
            format!("{cleanup:#}").contains("a different update now owns the pending marker"),
            "{cleanup:#}"
        );
        assert_eq!(desktop.marker_bytes("dev"), None);
        assert_eq!(desktop.marker_bytes("nightly").unwrap(), foreign_marker);
        let app = desktop.root.join("app");
        assert!(admit_startup(&desktop.namespace, "dev", "1", &app, None)
            .unwrap()
            .is_none());
        let blocked = admit_startup(&desktop.namespace, "nightly", "1", &app, None).unwrap_err();
        assert!(
            format!("{blocked:#}").contains("has not released startup"),
            "{blocked:#}"
        );
        desktop.assert_data_unchanged();
    }

    #[test]
    fn accepted_handoff_excludes_a_second_update_and_stops_the_orphaned_desktop_writer_before_capture(
    ) {
        let mut desktop = Desktop::launch(true);
        let writer = desktop.writer.unwrap();
        let installer = desktop.command(
            r#"printf migrated > "$2"; printf partial > "$3""#,
            &[
                &desktop.data.join("user-record"),
                &desktop.data.join("partial-migration"),
            ],
        );
        let crash = desktop.command("exit 3", &[]);
        let request = desktop.request("update-a", &["dev"], desktop.plan(installer, crash));
        let directory = desktop.submit("update-a", &serde_json::to_vec(&request).unwrap());
        let mut guard = launch_guard(&[OsStr::new("--handoff"), directory.as_os_str()]);
        eventually("handoff acknowledgement", || {
            directory.join("ready.json").exists()
        });
        let ready: HandoffReady =
            serde_json::from_slice(&fs::read(directory.join("ready.json")).unwrap()).unwrap();
        assert_eq!((ready.guard.pid, ready.nonce.as_str()), (guard.id(), NONCE));
        // The writer receipt is durable before readiness and names the helper.
        let receipt: Vec<ProcessIdentity> =
            serde_json::from_slice(&fs::read(directory.join("old-writers.json")).unwrap()).unwrap();
        assert!(receipt
            .iter()
            .any(|process| process.pid == desktop.identity.pid));
        let writer = receipt
            .iter()
            .find(|process| process.pid == writer)
            .expect("live desktop helper missing from the old-writer receipt")
            .clone();
        let own: PendingRecovery =
            serde_json::from_slice(&desktop.marker_bytes("dev").unwrap()).unwrap();
        assert_eq!(own.transaction, "update-a");
        assert!(!desktop.namespace.join("transactions").exists());

        // A second update for the same application is refused while A runs.
        let second = desktop.request(
            "update-b",
            &["dev"],
            desktop.plan(
                desktop.marker("installer-ran"),
                desktop.marker("updated-launched"),
            ),
        );
        let contested = desktop.submit("update-b", &serde_json::to_vec(&second).unwrap());
        let stderr = refused_handoff(&contested);
        assert!(
            stderr.contains("another update already owns this application"),
            "{stderr}"
        );
        assert_eq!(entries(&contested), ["request.json"]);
        let own: PendingRecovery =
            serde_json::from_slice(&desktop.marker_bytes("dev").unwrap()).unwrap();
        assert_eq!(own.transaction, "update-a");
        assert!(
            guard.try_wait().unwrap().is_none(),
            "accepted guard stopped"
        );
        assert!(
            !stopped(&writer),
            "helper stopped before the desktop exited"
        );

        // The desktop exits, but its helper keeps writing until the guard stops it.
        fs::write(desktop.root.join("release"), b"").unwrap();
        assert!(desktop.process.wait().unwrap().success());
        let (status, stderr) = finish(guard);
        assert!(status.success(), "guard failed: {stderr}");
        let outcome: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join("outcome.json")).unwrap()).unwrap();
        assert_eq!(
            outcome["Restored"]["reason"],
            "updated app exited before health acknowledgement: exit status: 3"
        );
        assert!(
            stopped(&writer),
            "orphaned desktop writer survived the handoff"
        );
        let checkpoint = desktop.namespace.join("transactions/update-a");
        assert_eq!(
            RecoveryCheckpoint::observe(checkpoint)
                .unwrap()
                .read()
                .unwrap()
                .phase,
            RecoveryPhase::Restored
        );
        // Restoration returns the data captured after the writer stopped, and
        // nothing appends to it afterwards.
        let restored = || {
            assert_eq!(
                entries(&desktop.data),
                ["desktop-log", "user-record"],
                "migration residue survived restoration"
            );
            assert_eq!(
                fs::read(desktop.data.join("user-record")).unwrap(),
                b"v1 user data"
            );
            fs::read(desktop.data.join("desktop-log")).unwrap()
        };
        let captured = restored();
        // The writer mirrors each number only after appending it, so a capture
        // taken after the stop holds every mirrored append (plus at most the
        // one the stop interrupted). An earlier capture would hold fewer.
        let appended = numbered(&captured, "captured desktop-log");
        let mirrored = numbered(
            &fs::read(desktop.root.join("writer-progress")).unwrap(),
            "writer progress",
        );
        assert!(
            appended == mirrored || appended == mirrored + 1,
            "captured {appended} appends of the {mirrored} the writer made: capture preceded the stop"
        );
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(
            restored(),
            captured,
            "a desktop writer appended after restore"
        );
        assert_eq!(
            desktop.marker_bytes("dev"),
            None,
            "startup fence not released"
        );
        eventually("previous application relaunch", || {
            desktop.root.join("previous-launched").exists()
        });
    }
}

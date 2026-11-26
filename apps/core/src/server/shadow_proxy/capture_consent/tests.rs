use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const NOW: &str = "2026-11-18T12:00:00Z";

fn no_env(_: &str) -> Option<String> {
    None
}

fn update(kind: &str, enabled: bool) -> Update {
    Update {
        kind: kind.to_owned(),
        enabled,
    }
}

fn decided(pairs: &[(&str, bool)]) -> Stored {
    Stored::Decided(
        pairs
            .iter()
            .map(|(kind, enabled)| {
                (
                    (*kind).to_owned(),
                    Decision {
                        enabled: *enabled,
                        decided_at: Some(NOW.to_owned()),
                    },
                )
            })
            .collect(),
    )
}

fn enabled_kinds(body: &serde_json::Value) -> Vec<&'static str> {
    KINDS
        .into_iter()
        .filter(|kind| body["kinds"][kind]["enabled"] == true)
        .collect()
}

/// A fake Shadow: it counts restarts and stops and never starts a process.
struct FakeShadow {
    running: AtomicBool,
    restart_ok: bool,
    stop_ok: bool,
    restarts: AtomicUsize,
    stops: AtomicUsize,
}

impl FakeShadow {
    fn new(running: bool, restart_ok: bool, stop_ok: bool) -> Self {
        Self {
            running: AtomicBool::new(running),
            restart_ok,
            stop_ok,
            restarts: AtomicUsize::new(0),
            stops: AtomicUsize::new(0),
        }
    }
}

#[async_trait::async_trait]
impl ShadowControl for FakeShadow {
    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    async fn restart(&self) -> anyhow::Result<()> {
        self.restarts.fetch_add(1, Ordering::SeqCst);
        if self.restart_ok {
            Ok(())
        } else {
            anyhow::bail!("restart refused")
        }
    }

    async fn stop(&self) -> anyhow::Result<()> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        if self.stop_ok {
            self.running.store(false, Ordering::SeqCst);
            Ok(())
        } else {
            anyhow::bail!("stop refused")
        }
    }
}

#[test]
fn a_profile_without_a_record_has_every_kind_off() {
    let directory = tempfile::tempdir().unwrap();
    let stored = read_record(&record_path(directory.path()));
    assert_eq!(stored, Stored::Missing);
    let body = response_json(
        &stored,
        configured_kinds(no_env),
        directory.path(),
        false,
        None,
    );
    assert_eq!(body["recordState"], "missing");
    assert!(enabled_kinds(&body).is_empty());
    for kind in KINDS {
        assert_eq!(body["kinds"][kind]["decided"], false);
        assert_eq!(body["kinds"][kind]["configured"], false);
        assert!(body["kinds"][kind]["decidedAt"].is_null());
    }
    assert!(body.get("applied").is_none());
    // Reading the state writes nothing.
    assert!(!record_path(directory.path()).exists());
}

#[test]
fn one_update_decides_one_kind_and_survives_a_round_trip() {
    let directory = tempfile::tempdir().unwrap();
    let kinds = updated(Stored::Missing, &update("microphone", true), NOW).unwrap();
    assert_eq!(kinds.len(), 1);
    write_record(directory.path(), &kinds).unwrap();

    let text = std::fs::read_to_string(record_path(directory.path())).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(json["kinds"]["microphone"]["enabled"], true);
    assert_eq!(json["kinds"]["microphone"]["decidedAt"], NOW);

    let stored = read_record(&record_path(directory.path()));
    let body = response_json(
        &stored,
        configured_kinds(no_env),
        directory.path(),
        true,
        Some(Applied::Restarted),
    );
    assert_eq!(enabled_kinds(&body), vec!["microphone"]);
    assert_eq!(body["kinds"]["microphone"]["decidedAt"], NOW);
    assert_eq!(body["kinds"]["screen"]["decided"], false);
    assert_eq!(body["applied"], "restarted");
    assert_eq!(body["shadowRunning"], true);
    // No temp file is left beside the record.
    let names: Vec<_> = std::fs::read_dir(directory.path())
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from(RECORD_FILE)]);
}

#[test]
fn each_kind_is_switched_alone() {
    let mut stored = Stored::Missing;
    for kind in KINDS {
        let kinds = updated(stored, &update(kind, true), NOW).unwrap();
        stored = Stored::Decided(kinds);
    }
    let kinds = updated(stored, &update("input", false), NOW).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let body = response_json(
        &Stored::Decided(kinds),
        configured_kinds(no_env),
        directory.path(),
        false,
        None,
    );
    assert_eq!(
        enabled_kinds(&body),
        vec!["screen", "microphone", "activity"]
    );
}

#[test]
fn off_in_the_record_beats_the_environment_list() {
    let configured = configured_kinds(|name| {
        (name == "SHADOW_CAPTURE_KINDS").then(|| " Screen, input ,camera".to_owned())
    });
    assert_eq!(configured, [true, false, true, false]);
    let directory = tempfile::tempdir().unwrap();
    let body = response_json(
        &decided(&[("screen", false)]),
        configured,
        directory.path(),
        false,
        None,
    );
    // Screen was turned off by the user and stays off. Input has no decision,
    // so the environment list turns it on.
    assert_eq!(enabled_kinds(&body), vec!["input"]);
    assert_eq!(body["kinds"]["screen"]["configured"], true);
    assert_eq!(body["kinds"]["screen"]["decided"], true);
    assert_eq!(body["kinds"]["input"]["decided"], false);

    let second = configured_kinds(|name| {
        (name == "RYU_SHADOW_CAPTURE_KINDS").then(|| "activity".to_owned())
    });
    assert_eq!(second, [false, false, false, true]);
    assert_eq!(configured_kinds(no_env), [false; 4]);
}

#[test]
fn an_unusable_record_is_all_off_and_is_replaced_with_explicit_decisions() {
    let directory = tempfile::tempdir().unwrap();
    for text in [
        "not json",
        r#"{"version":2,"kinds":{"screen":{"enabled":true}}}"#,
        r#"{"kinds":{"screen":{"enabled":true}}}"#,
    ] {
        std::fs::write(record_path(directory.path()), text).unwrap();
        let stored = read_record(&record_path(directory.path()));
        assert_eq!(stored, Stored::Unusable, "{text}");
        let body = response_json(&stored, [true; 4], directory.path(), false, None);
        assert_eq!(body["recordState"], "unusable");
        assert!(enabled_kinds(&body).is_empty(), "{text}");
    }

    // Turning one kind on does not let the environment list turn on the rest.
    let kinds = updated(Stored::Unusable, &update("screen", true), NOW).unwrap();
    let body = response_json(
        &Stored::Decided(kinds),
        [true; 4],
        directory.path(),
        false,
        None,
    );
    assert_eq!(enabled_kinds(&body), vec!["screen"]);
}

#[test]
fn the_request_names_one_known_kind() {
    assert!(updated(Stored::Missing, &update("camera", true), NOW).is_err());
    assert!(updated(Stored::Missing, &update("", true), NOW).is_err());
    assert!(serde_json::from_str::<Update>(r#"{"kind":"screen","enabled":true}"#).is_ok());
    assert!(serde_json::from_str::<Update>(r#"{"kind":"screen"}"#).is_err());
    assert!(serde_json::from_str::<Update>(r#"{"kind":"screen","enabled":"yes"}"#).is_err());
    assert!(
        serde_json::from_str::<Update>(r#"{"kind":"screen","enabled":true,"all":true}"#).is_err()
    );
    assert!(serde_json::from_str::<Update>(r#"{"kinds":["screen"],"enabled":true}"#).is_err());
}

#[test]
fn only_this_device_turns_a_kind_on() {
    assert!(change_allowed(true, true));
    assert!(!change_allowed(true, false));
    // Turning a kind off is always accepted.
    assert!(change_allowed(false, true));
    assert!(change_allowed(false, false));
}

#[test]
fn storage_names_the_folders_of_each_kind() {
    let directory = tempfile::tempdir().unwrap();
    let storage = storage_json(directory.path());
    let audio = directory.path().join("media").join("audio");
    assert_eq!(storage["microphone"][0], audio.display().to_string());
    assert_eq!(storage["dataDir"], directory.path().display().to_string());
    for kind in KINDS {
        assert!(!storage[kind].as_array().unwrap().is_empty(), "{kind}");
    }
}

#[tokio::test]
async fn a_stopped_shadow_is_never_started_by_a_change() {
    let shadow = FakeShadow::new(false, true, true);
    assert_eq!(apply(&shadow).await, Applied::NotRunning);
    assert_eq!(shadow.restarts.load(Ordering::SeqCst), 0);
    assert_eq!(shadow.stops.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_running_shadow_restarts_to_read_the_new_record() {
    let shadow = FakeShadow::new(true, true, true);
    assert_eq!(apply(&shadow).await, Applied::Restarted);
    assert_eq!(shadow.restarts.load(Ordering::SeqCst), 1);
    assert_eq!(shadow.stops.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_shadow_that_cannot_restart_is_stopped() {
    let shadow = FakeShadow::new(true, false, true);
    assert_eq!(apply(&shadow).await, Applied::Stopped);
    assert_eq!(shadow.stops.load(Ordering::SeqCst), 1);
    assert!(!shadow.is_running());

    let stuck = FakeShadow::new(true, false, false);
    assert_eq!(apply(&stuck).await, Applied::Failed);
    assert!(stuck.is_running());
}

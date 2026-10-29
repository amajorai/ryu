use std::path::PathBuf;

use super::*;
use crate::WorkspaceAccess;

#[test]
fn binary_override_wins_and_apptainer_is_preferred() {
    assert_eq!(
        resolve_binary(Some("/opt/bin/singularity".to_owned()), |_| false).unwrap(),
        "/opt/bin/singularity"
    );
    assert_eq!(resolve_binary(None, |_| true).unwrap(), "apptainer");
    assert_eq!(
        resolve_binary(None, |name| name == "singularity").unwrap(),
        "singularity"
    );
}

#[test]
fn missing_cli_is_an_actionable_error() {
    let err = resolve_binary(None, |_| false).unwrap_err().to_string();
    assert!(err.contains("apptainer"), "{err}");
    assert!(err.contains(ENV_SINGULARITY_BINARY), "{err}");
}

#[test]
fn default_caps_are_contained_and_offline() {
    let flags = caps_to_flags(&SandboxCapabilities::default()).unwrap();
    assert_eq!(
        flags,
        [
            "--containall",
            "--no-privs",
            "--no-mount",
            NO_MOUNT,
            "--net",
            "--network",
            "none"
        ]
    );
}

#[test]
fn network_grant_drops_network_isolation_only() {
    let caps = SandboxCapabilities {
        network: true,
        ..SandboxCapabilities::default()
    };
    assert_eq!(
        caps_to_flags(&caps).unwrap(),
        ["--containall", "--no-privs", "--no-mount", NO_MOUNT]
    );
}

#[test]
fn mounts_follow_effective_access() {
    let mut caps = SandboxCapabilities::default();
    caps.fs_read_paths.insert(PathBuf::from("/data/in"));
    caps.fs_write_paths.insert(PathBuf::from("/data/out"));
    let flags = caps_to_flags(&caps).unwrap();
    assert!(flags.ends_with(&[
        "--bind".to_owned(),
        "/data/in:/data/in:ro".to_owned(),
        "--bind".to_owned(),
        "/data/out:/data/out:rw".to_owned(),
    ]));

    caps.workspace_access = WorkspaceAccess::ReadOnly;
    let flags = caps_to_flags(&caps).unwrap();
    assert!(flags.contains(&"/data/out:/data/out:ro".to_owned()));

    caps.workspace_access = WorkspaceAccess::None;
    assert!(!caps_to_flags(&caps).unwrap().contains(&"--bind".to_owned()));
}

#[test]
fn inexpressible_bind_paths_are_rejected() {
    for bad in ["/a:b", "/a,b", "relative/path"] {
        let mut caps = SandboxCapabilities::default();
        caps.fs_read_paths.insert(PathBuf::from(bad));
        assert!(caps_to_flags(&caps).is_err(), "{bad}");
    }
}

#[test]
fn exec_and_instance_argv() {
    let spec = ExecSpec::new("sh", vec!["-c".to_owned(), "echo hi".to_owned()]);
    assert_eq!(
        exec_argv(&spec.capabilities, "img.sif", &spec).unwrap(),
        [
            "exec",
            "--containall",
            "--no-privs",
            "--no-mount",
            NO_MOUNT,
            "--net",
            "--network",
            "none",
            "img.sif",
            "sh",
            "-c",
            "echo hi"
        ]
    );
    assert_eq!(
        instance_start_argv(&SandboxCapabilities::default(), "img.sif", "ryu-ws-ab").unwrap(),
        [
            "instance",
            "start",
            "--containall",
            "--no-privs",
            "--no-mount",
            NO_MOUNT,
            "--net",
            "--network",
            "none",
            "img.sif",
            "ryu-ws-ab"
        ]
    );
    assert_eq!(
        instance_exec_argv("ryu-ws-ab", &spec),
        [
            "exec",
            "--cleanenv",
            "--no-privs",
            "instance://ryu-ws-ab",
            "sh",
            "-c",
            "echo hi"
        ]
    );
}

#[test]
fn launcher_env_keeps_only_the_allowlist() {
    let host = |key: &str| -> Option<std::ffi::OsString> {
        match key {
            "PATH" => Some("/usr/bin".into()),
            "HOME" => Some("/home/ryu".into()),
            "OPENAI_API_KEY"
            | "RYU_MASTER_KEY"
            | "APPTAINER_BIND"
            | "APPTAINERENV_SECRET"
            | "SINGULARITY_BINDPATH" => Some("leak".into()),
            _ => None,
        }
    };
    assert_eq!(
        launcher_env(host),
        [
            ("PATH", std::ffi::OsString::from("/usr/bin")),
            ("HOME", std::ffi::OsString::from("/home/ryu")),
        ]
    );
    for blocked in [
        "APPTAINER_BIND",
        "APPTAINER_BINDPATH",
        "SINGULARITY_BIND",
        "SINGULARITY_BINDPATH",
    ] {
        assert!(!LAUNCHER_ENV_ALLOWLIST.contains(&blocked), "{blocked}");
    }
    assert!(LAUNCHER_ENV_ALLOWLIST
        .iter()
        .all(|key| !key.starts_with("APPTAINERENV_") && !key.starts_with("SINGULARITYENV_")));
}

#[test]
fn only_backend_owned_instances_are_accepted() {
    assert!(instance_name(&WorkspaceId("ryu-ws-0123abcd".to_owned())).is_ok());
    for foreign in ["", "ryu-ws-", "other", "ryu-ws-../x", "ryu-ws-ab cd"] {
        assert!(
            instance_name(&WorkspaceId(foreign.to_owned())).is_err(),
            "{foreign}"
        );
    }
}

#[tokio::test]
async fn foreign_workspace_ids_fail_before_any_process_runs() {
    let sandbox = SingularitySandbox::new();
    let id = WorkspaceId("/etc".to_owned());
    assert!(sandbox.destroy_workspace(&id).await.is_err());
    assert!(sandbox
        .exec_in_workspace(&id, ExecSpec::new("true", vec![]))
        .await
        .is_err());
}

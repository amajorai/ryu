use super::*;

#[test]
fn installer_runs_without_scripts_and_with_a_scrubbed_environment() {
    let inherited = [
        ("PATH", "/usr/bin"),
        ("HOME", "/home/someone"),
        ("RYU_TOKEN", "secret"),
        ("OPENAI_API_KEY", "secret"),
        ("HTTPS_PROXY", "http://proxy:3128"),
        ("npm_config_registry", "https://registry.example"),
        ("NPM_CONFIG_CAFILE", "/etc/ca.pem"),
    ]
    .map(|(name, value)| {
        (
            std::ffi::OsString::from(name),
            std::ffi::OsString::from(value),
        )
    });
    let command = npm_install_command(Path::new("/prefix"), "pkg@latest", inherited);

    let args: Vec<_> = command.get_args().collect();
    assert!(args.contains(&std::ffi::OsStr::new("--ignore-scripts")));
    let mut names: Vec<_> = command
        .get_envs()
        .filter(|(_, value)| value.is_some())
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "HOME",
            "HTTPS_PROXY",
            "NPM_CONFIG_CAFILE",
            "PATH",
            "npm_config_registry"
        ]
    );

    // The environment is cleared, not just left unextended: a variable the
    // test process itself carries does not reach the child.
    #[cfg(unix)]
    {
        let Some(cargo_var) = std::env::var_os("CARGO_MANIFEST_DIR") else {
            return;
        };
        let mut env_probe = std::process::Command::new("env");
        scrub_installer_env(
            &mut env_probe,
            [(
                std::ffi::OsString::from("RYU_TOKEN"),
                std::ffi::OsString::from("secret"),
            )],
        );
        let Ok(output) = env_probe.output() else {
            return;
        };
        let printed = String::from_utf8_lossy(&output.stdout);
        assert!(!printed.contains("RYU_TOKEN"));
        assert!(!printed.contains(&*cargo_var.to_string_lossy()));
    }
}

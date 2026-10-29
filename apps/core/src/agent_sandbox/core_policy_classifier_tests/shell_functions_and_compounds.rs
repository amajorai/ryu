use super::*;

#[test]
fn shell_functions_aliases_and_compound_commands_cannot_hide_codex() {
    for (command, args) in [
        ("sh", &["-c", "{ npx -y @zed-industries/codex-acp; }"][..]),
        ("bash", &["-c", "launch() { codex-acp --acp; }; launch"]),
        (
            "bash",
            &[
                "-c",
                "function launch { npx @agentclientprotocol/codex-acp; }; launch",
            ],
        ),
        ("sh", &["-c", "if true; then codex-acp; fi"]),
        ("sh", &["-c", "while :; do codex-acp --acp; done"]),
        ("sh", &["-c", "! codex-acp"]),
        // A trap action is shell code the wrapper runs when the signal fires.
        (
            "bash",
            &["-c", "trap 'npx -y @zed-industries/codex-acp' EXIT"],
        ),
        ("sh", &["-c", "trap -- 'codex-acp --acp' INT TERM; sleep 1"]),
        ("sh", &["-c", r#"trap "$AGENT" EXIT"#]),
        (
            "bash",
            &[
                "-c",
                "shopt -s expand_aliases\nalias launch='npx -y @zed-industries/codex-acp'\nlaunch",
            ],
        ),
        ("zsh", &["-c", "alias -g AGENT='codex-acp --acp'; AGENT"]),
        (
            "pwsh",
            &["-Command", "Set-Alias launch codex-acp; launch --acp"],
        ),
        (
            "pwsh",
            &[
                "-Command",
                "New-Alias -Name launch -Value codex-acp; launch",
            ],
        ),
        (
            "pwsh",
            &[
                "-Command",
                "function Start-Agent { npx -y @zed-industries/codex-acp }; Start-Agent",
            ],
        ),
        ("pwsh", &["-Command", "& { codex-acp --acp }"]),
        ("pwsh", &["-Command", "Invoke-Expression 'codex-acp --acp'"]),
        // A program or package produced by command substitution is only
        // known at launch.
        ("sh", &["-c", "$(printf codex-acp) --acp"]),
        ("sh", &["-c", "`echo codex-acp` --acp"]),
        ("sh", &["-c", r#"npx -y "$(cat /srv/agent/package)""#]),
        // Only an unquoted `)` closes `$(…)`: a quoted or escaped one inside it
        // cannot end the substitution early and hide the command after `;`.
        (
            "sh",
            &[
                "-c",
                r#"echo $(echo ")") ; npx -y @zed-industries/codex-acp"#,
            ],
        ),
        ("sh", &["-c", r#"echo $(echo ')') ; codex-acp --acp"#]),
        ("sh", &["-c", r"echo $(echo \)) ; codex-acp --acp"]),
        (
            "bash",
            &[
                "-c",
                r#"ready="$(printf '%s' "$(echo ")")")"; npx -y @zed-industries/codex-acp"#,
            ],
        ),
        // A `)` inside `${…}` belongs to the expansion and does not end the
        // `$(…)` around it either (bash and dash both start Codex here).
        (
            "sh",
            &[
                "-c",
                r#"echo "$(echo ${x:-)} '"')"; npx -y @zed-industries/codex-acp # '"#,
            ],
        ),
        (
            "bash",
            &[
                "-c",
                r#"echo $(echo ${x:-(} ${y:-)}) ; codex-acp --acp # )"#,
            ],
        ),
        (
            "sh",
            &[
                "-c",
                r#"echo "$(echo ${x:-(}) y "; npx -y @zed-industries/codex-acp # ")""#,
            ],
        ),
        // `case` patterns end in `)` too, so a `case` inside `$(…)` cannot be
        // delimited here and counts as Codex.
        (
            "sh",
            &[
                "-c",
                "echo $(case x in x) npx -y @fixture/native-acp ;; esac)",
            ],
        ),
        // A quote or substitution that is never closed cannot be read.
        ("sh", &["-c", "echo $(date ; npx -y @fixture/native-acp"]),
        ("sh", &["-c", "echo `date ; npx -y @fixture/native-acp"]),
        ("sh", &["-c", "echo 'open ; npx -y @fixture/native-acp"]),
        ("sh", &["-c", r#"echo "open ; npx -y @fixture/native-acp"#]),
        (
            "pwsh",
            &["-Command", "Write-Output 'open; npx -y @fixture/native-acp"],
        ),
    ] {
        assert_confined(declared(command, args));
    }
    for (command, args) in [
        (
            "sh",
            &["-c", "launch() { npx -y @fixture/native-acp; }; launch"][..],
        ),
        (
            "bash",
            &["-c", "alias ll='ls -l'; npx -y @fixture/native-acp"],
        ),
        ("pwsh", &["-Command", "Set-Alias launch native-acp; launch"]),
        (
            "sh",
            &[
                "-c",
                "if [ -f /srv/ready ]; then npx -y @fixture/native-acp; fi",
            ],
        ),
        (
            "sh",
            &["-c", r#"echo "$(date)"; npx -y @fixture/native-acp"#],
        ),
        // A trap action is read as code: here it only prints, resets or lists.
        (
            "sh",
            &[
                "-c",
                "trap 'echo codex-acp stopped' EXIT; trap - INT; trap; trap -p; npx -y @fixture/native-acp",
            ],
        ),
        // Balanced quoting inside a substitution, a comment, and PowerShell's
        // backtick-escaped quotes are read as written.
        (
            "sh",
            &["-c", r#"echo "$(echo ")")"; npx -y @fixture/native-acp"#],
        ),
        (
            "sh",
            &[
                "-c",
                "# don't start codex-acp here\nnpx -y @fixture/native-acp",
            ],
        ),
        (
            "pwsh",
            &[
                "-Command",
                "Write-Host `\"ready`\"; npx -y @fixture/native-acp # codex-acp",
            ],
        ),
    ] {
        assert_unconfined(declared(command, args));
    }
}

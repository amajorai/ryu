use super::*;

#[test]
fn launchers_interpreters_and_powershell_script_blocks_are_read_through() {
    for (command, args) in [
        // PowerShell script blocks, `Start-Process` and cmd.exe `start`.
        (
            "pwsh",
            &[
                "-Command",
                "1 | ForEach-Object { npx -y @zed-industries/codex-acp }",
            ][..],
        ),
        (
            "pwsh",
            &["-Command", "Invoke-Command -ScriptBlock {codex-acp --acp}"],
        ),
        (
            "pwsh",
            &[
                "-Command",
                "Start-Process npx -ArgumentList '-y','@zed-industries/codex-acp'",
            ],
        ),
        (
            "pwsh",
            &[
                "-Command",
                "Start-Process -FilePath npx -ArgumentList '-y', '@zed-industries/codex-acp' -NoNewWindow -Wait",
            ],
        ),
        (
            "powershell",
            &["-Command", "saps -Wait -FilePath:codex-acp"],
        ),
        ("cmd", &["/c", "start npx -y @zed-industries/codex-acp"]),
        (
            "cmd",
            &["/c", r#"start "agent" /b /wait npx -y @zed-industries/codex-acp"#],
        ),
        // Launch prefixes run the command that follows their options.
        ("timeout", &["10", "npx", "-y", "@zed-industries/codex-acp"]),
        ("timeout", &["-k", "5", "--foreground", "60", "codex-acp"]),
        (
            "sudo",
            &["-u", "agent", "-E", "npx", "-y", "@zed-industries/codex-acp"],
        ),
        // With -s or -i, sudo hands the words to a shell.
        (
            "sudo",
            &["-s", "true; npx -y @zed-industries/codex-acp --cwd /srv"],
        ),
        ("doas", &["-u", "agent", "codex-acp"]),
        ("setsid", &["-f", "npx", "-y", "@zed-industries/codex-acp"]),
        (
            "stdbuf",
            &["-o0", "-eL", "npx", "-y", "@zed-industries/codex-acp"],
        ),
        ("stdbuf", &["--output=L", "codex-acp"]),
        (
            "nice",
            &[
                "-n", "5", "ionice", "-c", "3", "taskset", "0x3", "chrt", "-o", "0", "unbuffer",
                "caffeinate", "-i", "nohup", "codex-acp",
            ],
        ),
        // Unknown options might take the next word, so both readings count.
        ("sudo", &["--custom-flag", "codex-acp"]),
        ("sudo", &["--custom-flag", "agent", "codex-acp"]),
        // xargs appends words from standard input: the package is unknown.
        ("xargs", &["npx", "-y"]),
        ("xargs", &["-I{}", "npx", "-y", "{}"]),
        (
            "sh",
            &["-c", "echo @zed-industries/codex-acp | xargs -n1 npx -y"],
        ),
        // watch runs its command through `sh -c`; script runs `-c` or a trailing command.
        ("sh", &["-c", "watch npx -y @zed-industries/codex-acp"]),
        (
            "watch",
            &["-n", "5", "true; npx -y @zed-industries/codex-acp --cwd /srv"],
        ),
        (
            "watch",
            &["-n", "5", "-x", "npx", "-y", "@zed-industries/codex-acp"],
        ),
        (
            "script",
            &["-qc", "npx -y @zed-industries/codex-acp", "/dev/null"],
        ),
        ("script", &["--command", "codex-acp --acp", "/dev/null"]),
        (
            "script",
            &["-q", "/dev/null", "npx", "-y", "@zed-industries/codex-acp"],
        ),
        // Without a command, script runs an interactive shell on standard input.
        ("script", &["-q", "/dev/null"]),
        // Inline interpreter programs and programs read from standard input.
        (
            "python3",
            &[
                "-c",
                "import os; os.system('npx -y @zed-industries/codex-acp')",
            ],
        ),
        ("python", &["-Ic", "print('ready')"]),
        ("py", &["-3", "-"]),
        (
            "node",
            &[
                "-e",
                "require('child_process').spawn('npx', ['-y', '@zed-industries/codex-acp'])",
            ],
        ),
        ("node", &["--print", "1"]),
        ("bun", &["--smol", "-e", "Bun.spawn(['npx', 'codex-acp'])"]),
        // Deno runs npm: and jsr: specifiers and package tasks.
        ("deno", &["run", "-A", "npm:@zed-industries/codex-acp"]),
        ("deno", &["run", "--allow-all", "npm:@openai/codex@latest"]),
        ("deno", &["-A", "npm:@agentclientprotocol/codex-acp"]),
        ("deno", &["eval", "console.log(1)"]),
        ("deno", &["task", "acp"]),
        // A valued global option may come before the subcommand, attached or
        // not, and an unknown option there is read both ways.
        ("deno", &["-L", "debug", "run", "npm:@zed-industries/codex-acp"]),
        (
            "deno",
            &["-L", "info", "run", "-A", "npm:@zed-industries/codex-acp"],
        ),
        ("deno", &["--log-level", "info", "task", "x"]),
        ("deno", &["-L", "debug", "task", "acp"]),
        (
            "deno",
            &["--log-level=debug", "run", "npm:@zed-industries/codex-acp"],
        ),
        ("deno", &["-Ldebug", "run", "npm:@openai/codex@latest"]),
        (
            "deno",
            &["--future-flag", "value", "run", "npm:@zed-industries/codex-acp"],
        ),
    ] {
        assert_confined(declared(command, args));
    }
    for (command, args) in [
        (
            "timeout",
            &[
                "10",
                "npx",
                "-y",
                "@fixture/native-acp",
                "--name",
                "codex-acp",
            ][..],
        ),
        ("sudo", &["-u", "agent", "npx", "-y", "@fixture/native-acp"]),
        ("xargs", &["npx", "-y", "@fixture/native-acp"]),
        ("cmd", &["/c", "start /b npx -y @fixture/native-acp"]),
        (
            "pwsh",
            &[
                "-Command",
                "Start-Process npx -ArgumentList '-y','@fixture/native-acp','codex-acp'",
            ],
        ),
        (
            "pwsh",
            &[
                "-Command",
                "1..3 | ForEach-Object { Write-Output $_ }; npx -y @fixture/native-acp",
            ],
        ),
        (
            "script",
            &["-qc", "npx -y @fixture/native-acp", "/dev/null"],
        ),
        ("python3", &["/work/agent.py", "--model", "codex-acp"]),
        ("python3", &["-u", "-m", "native_acp", "-c", "codex-acp"]),
        ("node", &["--version"]),
        (
            "deno",
            &["run", "-A", "npm:@fixture/native-acp", "codex-acp"],
        ),
        ("deno", &["run", "-A", "/work/agent.ts", "codex-acp"]),
        ("deno", &["-L", "debug", "run", "-A", "/work/agent.ts"]),
        // Asking an interpreter for its version or help runs no program.
        ("python3", &["--version"]),
        ("python", &["-V"]),
        ("deno", &["--version"]),
        ("deno", &["-L", "info", "--version"]),
    ] {
        assert_unconfined(declared(command, args));
    }
}

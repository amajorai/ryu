use super::*;

#[test]
fn shell_script_files_standard_input_and_sourced_files_fail_closed() {
    let script = r"C:\agents\start.ps1";
    for (command, args) in [
        // A shell given a script file runs commands this classifier cannot read.
        ("sh", &["/opt/agents/start-agent.sh"][..]),
        ("bash", &["-e", "./launch", "--acp"]),
        ("/bin/zsh", &["-l", "agent.zsh"]),
        // With no command string a shell reads its commands from standard input.
        ("/bin/sh", &["-s"]),
        ("bash", &[]),
        ("cmd.exe", &["/q"]),
        ("pwsh", &["-NoProfile", "-Command", "-"]),
        ("pwsh", &["-NoProfile"]),
        // PowerShell `-File`, its prefixes, and PowerShell 7's positional file.
        ("pwsh", &["-NoProfile", "-File", script]),
        (
            "powershell.exe",
            &["-ExecutionPolicy", "Bypass", "-f", script],
        ),
        ("pwsh", &["-fil", script]),
        ("pwsh", &["-ExecutionPolicy", "Bypass", script]),
        // A sourced file runs in the shell itself.
        (
            "sh",
            &["-c", ". ./agent-env.sh && npx -y @fixture/native-acp"],
        ),
        ("bash", &["-c", "source ~/.agent/env; native-acp --acp"]),
        ("pwsh", &["-Command", ". ./profile.ps1; native-acp"]),
        // The Codex launch-settings guard admits any program whose file name
        // contains `codex`, so the classifier must treat it as Codex too.
        ("/opt/bin/codex-acp.sh", &[]),
        ("/opt/bin/codex-wrapper", &["--acp"]),
        (r"C:\tools\codex-acp-x86_64-pc-windows-msvc.exe", &[]),
        ("sh", &["-c", "exec /opt/bin/codex-acp.sh --acp"]),
    ] {
        assert_confined(declared(command, args));
    }
    for (command, args) in [
        // An inline command line is read, not assumed.
        ("sh", &["-c", "npx -y @fixture/native-acp"][..]),
        (
            "pwsh",
            &[
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "npx -y @fixture/native-acp",
            ],
        ),
        // A declared program is identified by its own name, script or binary.
        ("/opt/agents/start-agent.sh", &[]),
        ("node", &["/work/launcher.js", "--acp"]),
    ] {
        assert_unconfined(declared(command, args));
    }
}

#[test]
fn package_scripts_fail_closed_because_their_bodies_are_not_inspected() {
    for (command, args) in [
        ("npm", &["run", "acp"][..]),
        ("npm", &["start"]),
        ("npm", &["test"]),
        ("npm", &["--prefix", "/srv/agent", "run-script", "acp"]),
        ("npm", &["-w", "agent", "run", "acp", "--", "--stdio"]),
        ("npm.cmd", &["restart"]),
        ("pnpm", &["run", "acp"]),
        ("pnpm", &["acp"]),
        ("pnpm", &["--filter", "agent", "start"]),
        ("yarn", &["acp"]),
        ("yarn", &["run", "acp"]),
        ("yarn", &["workspace", "agent", "acp"]),
        ("bun", &["run", "acp"]),
        ("bun", &["acp"]),
        ("cmd", &["/c", "npm run acp"]),
        ("sh", &["-c", "cd /srv/agent && npm start"]),
        ("npx", &["-c", "npm run acp"]),
    ] {
        assert_confined(declared(command, args));
    }
    for (command, args) in [
        // Package execution is still classified by the package it runs.
        ("npm", &["view", "@zed-industries/codex-acp"][..]),
        ("npm", &["exec", "--", "@fixture/native-acp"]),
        ("pnpm", &["dlx", "@fixture/native-acp"]),
        ("yarn", &["dlx", "@fixture/native-acp"]),
        ("bun", &["x", "@fixture/native-acp"]),
        ("bunx", &["@fixture/native-acp", "codex-acp"]),
        // `bun <file>` runs that file, as Node does.
        ("bun", &["/work/native-acp/index.ts", "codex-acp"]),
    ] {
        assert_unconfined(declared(command, args));
    }
}

#[test]
fn env_split_strings_are_classified_by_the_command_they_spell() {
    for (command, args) in [
        ("env", &["-S", "npx -y codex-acp"][..]),
        (
            "env",
            &[
                "-S",
                "npx --prefer-offline",
                "@agentclientprotocol/codex-acp",
            ],
        ),
        (
            "/usr/bin/env",
            &["--split-string=CODEX_HOME=/accounts/a npx -y codex-acp"],
        ),
        ("env", &["--split-string", "codex --acp"]),
        ("env", &["-iS", "codex-acp --acp"]),
        ("env", &["-Scodex-acp --acp"]),
        ("env", &["-S", "-u OPENAI_API_KEY npx -y codex-acp"]),
        ("env", &["-S", r#"npx -y "@zed-industries/codex-acp""#]),
        // A package env expands at launch cannot be ruled out.
        ("env", &["-S", "npx -y ${AGENT_PACKAGE}"]),
        ("sh", &["-c", "env -S 'npx -y codex-acp'"]),
    ] {
        assert_confined(declared(command, args));
    }
    for (command, args) in [
        (
            "env",
            &["-S", "npx -y @fixture/native-acp --name codex-acp"][..],
        ),
        ("env", &["-S", "node /work/native.js", "codex-acp"]),
        ("env", &["-S", "native-acp", "--model", "codex"]),
    ] {
        assert_unconfined(declared(command, args));
    }
}

#[test]
fn powershell_encoded_and_abbreviated_commands_are_decoded_and_classified() {
    let codex = encoded("npx -y @zed-industries/codex-acp");
    let other = encoded("npx -y @fixture/native-acp --name codex-acp");
    let with_bom = encoded("\u{feff}codex-acp --acp");
    let multi_line = encoded("$ErrorActionPreference = 'Stop'\r\nnpx -y codex-acp\r\n");
    let nested = format!("powershell -NoProfile -enc {codex}");
    for (command, args) in [
        (
            "pwsh",
            vec!["-NoProfile", "-EncodedCommand", codex.as_str()],
        ),
        ("powershell.exe", vec!["-enc", codex.as_str()]),
        ("pwsh", vec!["-e", with_bom.as_str()]),
        ("pwsh", vec!["-ec", multi_line.as_str()]),
        ("powershell", vec!["/EncodedCommand", codex.as_str()]),
        ("pwsh", vec!["--encodedcommand", codex.as_str()]),
        // An encoded block that cannot be decoded cannot be ruled out.
        ("pwsh", vec!["-EncodedCommand", "not base64!"]),
        ("pwsh", vec!["-EncodedCommand", "AAAA"]),
        ("pwsh", vec!["-NoProfile", "-EncodedCommand"]),
        ("cmd", vec!["/c", nested.as_str()]),
        // Unambiguous parameter prefixes and Windows PowerShell's implicit command.
        (
            "pwsh",
            vec!["-NoProfile", "-Comm", "npx -y @zed-industries/codex-acp"],
        ),
        (
            "powershell",
            vec![
                "-ExecutionPolicy",
                "Bypass",
                "npx",
                "-y",
                "@zed-industries/codex-acp",
            ],
        ),
    ] {
        assert_confined(declared(command, &args));
    }
    for (command, args) in [
        (
            "pwsh",
            vec!["-NoProfile", "-EncodedCommand", other.as_str()],
        ),
        ("powershell.exe", vec!["-enc", other.as_str()]),
        (
            "pwsh",
            vec![
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "npx -y @fixture/native-acp",
            ],
        ),
    ] {
        assert_unconfined(declared(command, &args));
    }
}

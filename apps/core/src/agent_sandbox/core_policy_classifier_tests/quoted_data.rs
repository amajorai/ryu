use super::*;

/// Text the shell reads as data (a here-document body, an ANSI-C or
/// PowerShell here-string, a typographically quoted string) must not shift
/// the reader's quoting, or the commands after it would be read as one quoted
/// word. Each launch below runs Codex after such text, and the comment at its
/// end would rebalance a reader that went out of step.
#[test]
fn quoted_data_cannot_shift_the_reader_off_the_commands_after_it() {
    for (command, args) in [
        // A here-document body is data up to its delimiter line.
        (
            "sh",
            &[
                "-c",
                "cat <<EOF\n\"\nEOF\nnpx -y @zed-industries/codex-acp --cwd /srv # \"",
            ][..],
        ),
        (
            "bash",
            &[
                "-c",
                "cat <<-'END' >/dev/null\n\t'\n\tEND\nnpx -y @zed-industries/codex-acp --cwd /srv # '",
            ],
        ),
        (
            "sh",
            &[
                "-c",
                "cat <<A <<\"B\"\n'\nA\n\"\nB\nnpx -y @zed-industries/codex-acp --cwd /srv # '",
            ],
        ),
        // An unquoted delimiter expands the body, so its substitutions run.
        (
            "sh",
            &[
                "-c",
                "cat <<EOF\nready $(npx -y @zed-industries/codex-acp)\nEOF",
            ],
        ),
        ("bash", &["-c", "cat <<EOF\n`codex-acp --acp`\nEOF"]),
        // A here-document that never meets its delimiter, or a `<<` inside
        // parentheses (a shift in `(( … ))`, or a subshell's here-document),
        // cannot be read.
        ("sh", &["-c", "cat <<EOF\n$(codex-acp --acp)"]),
        (
            "bash",
            &[
                "-c",
                "(( shift = 1 << 2 ))\nnpx -y @zed-industries/codex-acp\n2",
            ],
        ),
        // `<<` inside `$[…]` or `${…}` is text, not a here-document.
        (
            "bash",
            &[
                "-c",
                "echo $[1<<X]\nnpx -y @zed-industries/codex-acp\nX]",
            ],
        ),
        (
            "bash",
            &[
                "-c",
                "echo ${x/<<}\nnpx -y @zed-industries/codex-acp\n}",
            ],
        ),
        // bash's `$'…'` takes `\'` as a quote; other shells end the string
        // there. Both readings are checked.
        (
            "bash",
            &[
                "-c",
                r"echo $'it\'s' ; npx -y @zed-industries/codex-acp --cwd /srv # '",
            ],
        ),
        (
            "sh",
            &[
                "-c",
                r"echo $'a\' ; npx -y @zed-industries/codex-acp --cwd /srv # '",
            ],
        ),
        (
            "sh",
            &[
                "-c",
                r"echo $'it\'s' ; npx -y @zed-industries/codex-acp --cwd /srv # '",
            ],
        ),
        // fish takes `\'` inside `'…'` as a quote.
        (
            "fish",
            &[
                "-c",
                r"echo 'x\'' ; npx -y @zed-industries/codex-acp --cwd /srv # '",
            ],
        ),
        // An escape in `$'…'` spells a character only known once decoded.
        ("bash", &["-c", r"$'\x63odex-acp' --acp"]),
        ("bash", &["-c", r"npx -y $'@zed-industries/\143odex-acp'"]),
        // PowerShell here-strings end only at a line starting with the quote
        // and `@`, and a double-quoted one runs its subexpressions.
        (
            "pwsh",
            &[
                "-Command",
                "Write-Output @\"\nsay \"hi\n\"@\nnpx -y @zed-industries/codex-acp --cwd /srv # \"",
            ],
        ),
        (
            "pwsh",
            &[
                "-Command",
                "Write-Output @'\nit's\n'@\nnpx -y @zed-industries/codex-acp --cwd /srv # '",
            ],
        ),
        (
            "pwsh",
            &[
                "-Command",
                "Write-Output @\"\n$(npx -y @zed-industries/codex-acp)\n\"@",
            ],
        ),
        ("pwsh", &["-Command", "Write-Output @\"\nnever closed"]),
        // PowerShell reads typographic quotes as quotes and dashes as `-`.
        (
            "pwsh",
            &[
                "-Command",
                "Write-Output \u{2018}x\"\u{2019}; npx -y @zed-industries/codex-acp --cwd /srv # \"",
            ],
        ),
        (
            "pwsh",
            &[
                "-Command",
                "Start-Process \u{2013}FilePath npx \u{2013}ArgumentList '-y','@zed-industries/codex-acp'",
            ],
        ),
        // A `case` after `then` inside `$(…)` cannot be delimited either.
        (
            "sh",
            &[
                "-c",
                "echo $(if :; then case x in x) npx -y @fixture/native-acp ;; esac; fi)",
            ],
        ),
        // An interpreter given no program runs the one on standard input.
        ("python3", &[]),
        ("python3", &["-u"]),
        ("node", &[]),
        ("node", &["--no-warnings"]),
        ("deno", &[]),
        (
            "sh",
            &[
                "-c",
                "printf '%s' \"$PROGRAM\" | node --no-warnings",
            ],
        ),
        // `node --run` runs a package.json script.
        ("node", &["--run", "acp"]),
        ("node", &["--run", "acp", "--", "--port", "8080"]),
        // A here-document that never meets its delimiter counts as Codex.
        ("sh", &["-c", "cat <<EOF\nnpx -y @fixture/native-acp"]),
    ] {
        assert_confined(declared(command, args));
    }
    for (command, args) in [
        // Read in step: the commands after the data are the fixture agent.
        (
            "sh",
            &["-c", "cat <<EOF\n\"\nEOF\nnpx -y @fixture/native-acp # \""][..],
        ),
        // `<<-` strips leading tabs, so the indented delimiter ends the body.
        (
            "sh",
            &[
                "-c",
                "cat <<-END\n\tbody\n\tEND\nnpx -y @fixture/native-acp",
            ],
        ),
        // A quoted delimiter leaves the body unexpanded: it is only data.
        (
            "sh",
            &[
                "-c",
                "cat <<'EOF'\n$(npx -y @zed-industries/codex-acp)\nEOF\nnpx -y @fixture/native-acp",
            ],
        ),
        (
            "bash",
            &["-c", r"echo $'it\'s' ; npx -y @fixture/native-acp"],
        ),
        (
            "bash",
            &["-c", "cat <<< \"codex-acp\"; npx -y @fixture/native-acp"],
        ),
        (
            "pwsh",
            &[
                "-Command",
                "Write-Output @'\nnpx -y @zed-industries/codex-acp\n'@\nnpx -y @fixture/native-acp",
            ],
        ),
        (
            "pwsh",
            &[
                "-Command",
                "Write-Output \u{201C}codex-acp\u{201D}; npx -y @fixture/native-acp",
            ],
        ),
    ] {
        assert_unconfined(declared(command, args));
    }
}

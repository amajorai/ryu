//! Pure detection for permanent file and directory deletion attempts.
//!
//! This crate deliberately has no filesystem or process side effects. The same
//! classifier is used by the Gateway scanner, Core's local preflight, the ACP
//! host, MCP dispatch, and the Ryu-managed Codex hook. Keeping the high-risk
//! vocabulary in one dependency prevents a fail-open transport fallback from
//! silently becoming a deletion bypass.

use regex::Regex;
use std::sync::OnceLock;

const MAX_NESTED_SHELL_DEPTH: usize = 4;

/// Detect a command that would permanently remove a file or directory.
///
/// The return value is a stable rule id suitable for audit messages. This is a
/// conservative detector: a false positive blocks a command for review, while a
/// false negative could remove user data. Unknown shell syntax is not decoded,
/// but common literal nested wrappers are recursively inspected.
pub fn detect_command(command: &str) -> Option<&'static str> {
    for segment in split_shell_segments(command) {
        if let Some(rule) = detect_segment(&segment, 0) {
            return Some(rule);
        }
    }

    // If quoting or shell syntax was too complex to tokenize, still inspect the
    // raw script for the language APIs and PowerShell deletion verbs. This is the
    // safe direction for malformed or unusual tool-call strings.
    detect_deletion_api(command).or_else(|| detect_catastrophic_operation(command))
}

/// Detect an explicit file deletion in an `apply_patch` payload.
pub fn patch_deletes_file(patch: &str) -> bool {
    let mut lines = patch.lines();
    while let Some(line) = lines.next() {
        let normalized = line.trim().to_ascii_lowercase();
        if normalized.starts_with("*** delete file:")
            || normalized == "deleted file mode"
            || normalized.starts_with("deleted file mode ")
        {
            return true;
        }

        // Unified diffs represent a deleted file with `/dev/null` as the new
        // side. Require the preceding old-file header so a random string in a
        // hunk does not become a deletion verdict.
        if normalized.starts_with("--- ") {
            if let Some(next) = lines.next() {
                if next
                    .trim()
                    .to_ascii_lowercase()
                    .starts_with("+++ /dev/null")
                {
                    return true;
                }
            }
        }
    }
    false
}

/// Detect a filesystem-shaped MCP tool whose action would permanently remove
/// a path. A tool named `trash` is intentionally not classified here: the
/// recoverability of a third-party tool still requires its own trust review.
pub fn is_filesystem_delete_tool(tool_name: &str) -> bool {
    let normalized = tool_name.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    let parts = normalized
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let deletion = parts.iter().any(|part| {
        matches!(
            *part,
            "delete" | "deletes" | "deletion" | "remove" | "removes" | "unlink" | "rmdir" | "shred"
        )
    }) || parts
        .iter()
        .any(|part| part.starts_with("delete") || part.starts_with("remove"));
    if !deletion {
        return false;
    }

    let filesystem = normalized.contains("filesystem")
        || parts.iter().any(|part| {
            matches!(
                *part,
                "fs" | "file" | "files" | "directory" | "dir" | "path"
            )
        });
    filesystem
}

fn split_shell_segments(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;

    for character in command.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            current.push(character);
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            ';' | '|' | '&' | '\n' if !(single_quote || double_quote) => {
                if !current.trim().is_empty() {
                    segments.push(current.trim().to_owned());
                }
                current.clear();
                continue;
            }
            _ => current.push(character),
        }
    }

    if !current.trim().is_empty() {
        segments.push(current.trim().to_owned());
    }
    if segments.is_empty() {
        vec![command.to_owned()]
    } else {
        segments
    }
}

fn detect_segment(segment: &str, depth: usize) -> Option<&'static str> {
    let words = match shell_words::split(segment) {
        Ok(words) => words,
        Err(_) => return detect_unparsed_command(segment),
    };
    if words.is_empty() {
        return None;
    }

    for (index, word) in words.iter().enumerate() {
        let base = executable_basename(word);
        match base.as_str() {
            "rm" | "unlink" | "rmdir" | "shred" | "del" | "erase" | "rd" => {
                return Some("direct_delete_command");
            }
            "find"
                if words[index + 1..]
                    .iter()
                    .any(|item| item == "-delete" || item == "--delete") =>
            {
                return Some("find_delete");
            }
            "rsync"
                if words[index + 1..]
                    .iter()
                    .any(|item| item == "--delete" || item.starts_with("--delete-")) =>
            {
                return Some("rsync_delete");
            }
            "git" => {
                if let Some(rule) = detect_git(&words[index + 1..]) {
                    return Some(rule);
                }
            }
            "remove-item" | "remove-itemproperty" => {
                return Some("powershell_delete_command");
            }
            _ => {}
        }

        if depth < MAX_NESTED_SHELL_DEPTH {
            if let Some(script) = nested_shell_script(&words, index, base.as_str()) {
                if script == "__ryu_encoded_command__" {
                    return Some("encoded_shell_command");
                }
                if script.contains('$') || script.contains('`') {
                    return Some("dynamic_shell_wrapper");
                }
                if let Some(rule) = detect_segment(script, depth + 1) {
                    return Some(rule);
                }
            }
        }
    }

    detect_catastrophic_operation(segment)
        .or_else(|| detect_deletion_api(segment))
        .or_else(|| detect_unparsed_command(segment))
}

fn executable_basename(word: &str) -> String {
    let path = word.rsplit(['/', '\\']).next().unwrap_or(word);
    path.strip_suffix(".exe")
        .or_else(|| path.strip_suffix(".cmd"))
        .or_else(|| path.strip_suffix(".bat"))
        .unwrap_or(path)
        .to_ascii_lowercase()
}

fn nested_shell_script<'a>(words: &'a [String], index: usize, base: &str) -> Option<&'a str> {
    let is_posix_shell = matches!(base, "bash" | "sh" | "zsh" | "ksh" | "dash");
    let is_cmd_shell = base == "cmd";
    let is_powershell = matches!(base, "powershell" | "pwsh");
    if !(is_posix_shell || is_cmd_shell || is_powershell) {
        return None;
    }

    let flag_index = words[index + 1..].iter().position(|word| {
        if is_cmd_shell {
            matches!(word.as_str(), "/c" | "/k")
        } else if is_powershell {
            matches!(
                word.to_ascii_lowercase().as_str(),
                "-command" | "-c" | "-encodedcommand"
            )
        } else {
            word.starts_with('-') && word.contains('c')
        }
    })?;
    let script_index = index + 1 + flag_index + 1;
    let script = words.get(script_index)?.as_str();
    if words[index + 1 + flag_index].eq_ignore_ascii_case("-encodedcommand") {
        // Encoded PowerShell cannot be safely inspected here. The caller should
        // treat this as a deletion-risk wrapper rather than trusting its text.
        return Some("__ryu_encoded_command__");
    }
    Some(script)
}

fn detect_git(words: &[String]) -> Option<&'static str> {
    let mut sub_index = 0;
    while sub_index < words.len() {
        let word = &words[sub_index];
        if matches!(
            word.as_str(),
            "-C" | "--git-dir"
                | "--work-tree"
                | "--namespace"
                | "--exec-path"
                | "--config-env"
                | "-c"
        ) {
            sub_index += 2;
            continue;
        }
        if word.starts_with("--") && word.contains('=') {
            sub_index += 1;
            continue;
        }
        if !word.starts_with('-') {
            break;
        }
        sub_index += 1;
    }
    let subcommand = words.get(sub_index)?;
    if subcommand.starts_with('-') {
        return None;
    }
    let rest = &words[sub_index + 1..];
    match subcommand.as_str() {
        "clean" => Some("git_clean"),
        "reset"
            if rest
                .iter()
                .any(|word| word == "--hard" || word.starts_with("--hard=")) =>
        {
            Some("git_reset_hard")
        }
        "checkout"
            if rest
                .iter()
                .any(|word| word == "--" || word == "." || word == "./" || word == "*") =>
        {
            Some("git_bulk_checkout")
        }
        "restore"
            if rest
                .iter()
                .any(|word| word == "--" || word == "." || word == "./" || word == "*") =>
        {
            Some("git_bulk_restore")
        }
        _ => None,
    }
}

fn detect_deletion_api(text: &str) -> Option<&'static str> {
    let patterns = deletion_api_patterns();
    patterns
        .iter()
        .find(|(_, pattern)| pattern.is_match(text))
        .map(|(rule, _)| *rule)
}

/// Detect operations that can destroy a host even when they do not use a file
/// deletion verb. These are execution-only hard stops: a normal message that
/// discusses `dd` or `reboot` is not passed to this classifier by the callers.
fn detect_catastrophic_operation(text: &str) -> Option<&'static str> {
    static PATTERNS: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            [
                (
                    "raw_disk_write",
                    r"(?i)\bdd\b[^\n;&|]*\bof\s*(?:=\s*)?/dev/",
                ),
                (
                    "filesystem_format",
                    r"(?i)\bmkfs(?:\.[a-z0-9_-]+)?\b[^\n;&|]*/dev/",
                ),
                (
                    "partition_table_write",
                    r"(?i)\b(?:wipefs|blkdiscard|fdisk|sfdisk|parted|partprobe|gpart)\b[^\n;&|]*/dev/",
                ),
                (
                    "diskutil_erase",
                    r"(?i)\bdiskutil\s+(?:eraseDisk|partitionDisk)\b",
                ),
                (
                    "windows_disk_format",
                    r"(?i)\bformat\s+[a-z]:",
                ),
                (
                    "powershell_disk_destructive",
                    r"(?i)\b(?:clear-disk|initialize-disk|remove-partition|format-volume)\b",
                ),
                (
                    "host_power_control",
                    r"(?i)(?:^|[\s;|&])(?:shutdown|reboot|halt|poweroff)\b|\bsystemctl\s+(?:reboot|poweroff|halt)\b",
                ),
            ]
            .into_iter()
            .filter_map(|(rule, pattern)| Regex::new(pattern).ok().map(|compiled| (rule, compiled)))
            .collect()
        })
        .iter()
        .find(|(_, pattern)| pattern.is_match(text))
        .map(|(rule, _)| *rule)
}

fn detect_unparsed_command(text: &str) -> Option<&'static str> {
    static PATTERNS: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            [
                (
                    "direct_delete_command",
                    r"(?i)\b(?:rm|unlink|rmdir|shred|del|erase|rd)(?:\.exe)?\b",
                ),
                ("find_delete", r"(?i)\bfind\b[^\n;&|]*\s--?delete\b"),
                (
                    "rsync_delete",
                    r"(?i)\brsync\b[^\n;&|]*\s--delete(?:[=\s-]|$)",
                ),
                ("git_clean", r"(?i)\bgit\b[^\n;&|]*\bclean\b"),
                (
                    "git_reset_hard",
                    r"(?i)\bgit\b[^\n;&|]*\breset\b[^\n;&|]*--hard\b",
                ),
                (
                    "git_bulk_checkout",
                    r"(?i)\bgit\b[^\n;&|]*\bcheckout\b[^\n;&|]*--(?:\s|$)",
                ),
                (
                    "git_bulk_restore",
                    r"(?i)\bgit\b[^\n;&|]*\brestore\b[^\n;&|]*(?:--|\.|\*|\.\/)\b?",
                ),
            ]
            .into_iter()
            .filter_map(|(rule, pattern)| Regex::new(pattern).ok().map(|compiled| (rule, compiled)))
            .collect()
        })
        .iter()
        .find(|(_, pattern)| pattern.is_match(text))
        .map(|(rule, _)| *rule)
}

fn deletion_api_patterns() -> &'static [(&'static str, Regex)] {
    static PATTERNS: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            [
                (
                    "script_delete_api",
                    r"(?i)(?:\b(?:os|shutil|path|pathlib|fs|file|dir|fileutils|deno)\s*(?:\.|::)\s*(?:remove|unlink|rmdir|rmtree|rm|rmsync|unlinksync|rmdirsync|delete|rm_rf)\s*\(|\.(?:unlink|rmdir)\s*\(|\b(?:unlink|rmdir)\s*\()",
                ),
                (
                    "powershell_delete_command",
                    r"(?i)\b(?:remove-item|remove-itemproperty)\b",
                ),
                (
                    "embedded_command_field",
                    r#"(?i)\b(?:cmd|command|script|shellcommand)\s*[:=]\s*[\"']\s*(?:rm|unlink|rmdir|shred|find\b[^\n]*-delete|rsync\b[^\n]*--delete|git\s+(?:clean|reset\s+--hard|checkout\s+--|restore\s+\.))\b"#,
                ),
            ]
            .into_iter()
            .filter_map(|(rule, pattern)| Regex::new(pattern).ok().map(|compiled| (rule, compiled)))
            .collect()
        })
        .as_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_deletion_commands_are_detected() {
        for command in [
            "rm",
            "rm -rf ./tmp",
            "unlink file",
            "rmdir dir",
            "shred file",
            "del file.txt",
            "erase file.txt",
            "rd /s directory",
        ] {
            assert_eq!(
                detect_command(command),
                Some("direct_delete_command"),
                "{command}"
            );
        }
    }

    #[test]
    fn catastrophic_host_operations_are_detected() {
        for command in [
            "dd if=/dev/zero of=/dev/nvme0n1",
            "mkfs.ext4 /dev/sda1",
            "wipefs --all /dev/disk0",
            "blkdiscard /dev/vda",
            "fdisk /dev/mmcblk0",
            "diskutil eraseDisk APFS RYU disk0",
            "format C:",
            "Clear-Disk -Number 0",
            "systemctl reboot",
        ] {
            assert!(detect_command(command).is_some(), "{command}");
        }
        assert_eq!(detect_command("dd if=/dev/zero of=./image"), None);
    }

    #[test]
    fn nested_shell_deletion_is_detected() {
        for command in [
            "bash -c 'rm -rf ./tmp'",
            "bash -lc \"find ./tmp -delete\"",
            "zsh -c 'python3 -c \"import os; os.unlink(\\\"x\\\")\"'",
            "cmd /c \"del file.txt\"",
            "git -C /tmp/project clean -fd",
            "git -c core.hooksPath=/tmp/hooks reset --hard HEAD",
        ] {
            assert!(detect_command(command).is_some(), "{command}");
        }
        assert_eq!(
            detect_command("bash -c \"$COMMAND\""),
            Some("dynamic_shell_wrapper")
        );
        assert_eq!(
            detect_command("powershell -EncodedCommand ZQBtAHB0AHk="),
            Some("encoded_shell_command")
        );
        assert_eq!(
            detect_command("bash -lc 'rm -rf ./unclosed"),
            Some("direct_delete_command")
        );
    }

    #[test]
    fn compound_and_git_deletion_is_detected() {
        assert_eq!(
            detect_command("echo ok && rsync -a --delete ./a ./b"),
            Some("rsync_delete")
        );
        assert_eq!(detect_command("git clean -fd"), Some("git_clean"));
        assert_eq!(
            detect_command("git reset --hard HEAD"),
            Some("git_reset_hard")
        );
        assert_eq!(
            detect_command("git checkout -- ."),
            Some("git_bulk_checkout")
        );
        assert_eq!(detect_command("git restore ."), Some("git_bulk_restore"));
    }

    #[test]
    fn script_apis_and_find_delete_are_detected() {
        for command in [
            "find ./tmp -type f -delete",
            "python3 -c 'import shutil; shutil.rmtree(\\\"x\\\")'",
            "node -e 'fs.rmSync(\\\"x\\\")'",
            "ruby -e 'FileUtils.rm_rf(\\\"x\\\")'",
            "powershell -Command 'Remove-Item file.txt'",
            r#"await tools.exec_command({cmd: "rm"})"#,
        ] {
            assert!(detect_command(command).is_some(), "{command}");
        }
    }

    #[test]
    fn recoverable_trash_commands_are_not_classified() {
        for command in [
            "/usr/bin/trash /tmp/file",
            "gio trash /tmp/file",
            "trash-put /tmp/file",
        ] {
            assert_eq!(detect_command(command), None, "{command}");
        }
    }

    #[test]
    fn patch_and_filesystem_tool_detection_is_narrow() {
        assert!(patch_deletes_file("*** Delete File: src/old.ts\n"));
        assert!(patch_deletes_file("--- a/src/old.ts\n+++ /dev/null\n"));
        assert!(!patch_deletes_file("*** Update File: src/app.ts\n"));

        assert!(is_filesystem_delete_tool("mcp__filesystem__delete_file"));
        assert!(is_filesystem_delete_tool(
            "mcp__filesystem__deleteDirectory"
        ));
        assert!(is_filesystem_delete_tool("fs.remove_directory"));
        assert!(is_filesystem_delete_tool("mcp__files__unlink"));
        assert!(!is_filesystem_delete_tool("calendar.delete_event"));
        assert!(!is_filesystem_delete_tool("mcp__filesystem__trash"));
    }
}

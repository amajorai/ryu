//! The coded failures `read_project_file_binary` and
//! `write_project_file_binary` hand to the webview.
//!
//! Same rule as `fs_command_error.rs` and `update_error.rs`: the native layer
//! never words a user-facing sentence. These commands reject with a plain
//! `code[:detail]` string, so existing callers that render `String(error)` keep
//! working while the webview maps the code to one whole translated sentence
//! (`apps/desktop/src/lib/desktop-command-error-messages.ts`). The detail is the
//! raw technical cause (OS or decoder text), shown only as secondary text.
//! Codes are wire names, so renaming one is a breaking change there.

/// The file (or the replacement content) exceeds the editor's size bound.
pub const FILE_TOO_LARGE: &str = "file_too_large";
/// The file could not be opened, read or written (OS text in the detail).
pub const IO: &str = "io";
/// The replacement content is not valid base64 (decoder text in the detail).
pub const INVALID_CONTENT: &str = "invalid_content";

/// `file_too_large`.
pub fn file_too_large() -> String {
    FILE_TOO_LARGE.to_owned()
}

/// `io:<raw OS error>`.
pub fn io(error: &std::io::Error) -> String {
    coded(IO, error)
}

/// `invalid_content:<raw decoder error>`.
pub fn invalid_content(error: &impl std::fmt::Display) -> String {
    coded(INVALID_CONTENT, error)
}

fn coded(code: &str, detail: &impl std::fmt::Display) -> String {
    format!("{code}:{detail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_wire_names() {
        assert_eq!(file_too_large(), "file_too_large");
        let missing = std::io::Error::new(std::io::ErrorKind::NotFound, "gone");
        assert_eq!(io(&missing), "io:gone");
        assert_eq!(invalid_content(&"bad byte"), "invalid_content:bad byte");
    }

    #[test]
    fn the_code_is_everything_before_the_first_colon() {
        let error = std::io::Error::other("C:\\path: denied");
        let coded = io(&error);
        assert_eq!(coded.split_once(':'), Some(("io", "C:\\path: denied")));
    }
}

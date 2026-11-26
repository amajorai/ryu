//! Direct skill install from a source reference (issue #462).
//!
//! Resolves a single user-supplied `source` string into a fetch strategy, pulls
//! the repository (or reads a local path), walks the common container layouts to
//! locate every `SKILL.md`, and copies the **entire** skill directory into the
//! universal Agent Skills location `~/.claude/skills/<name>/`. Copying the whole
//! directory (not just SKILL.md) is deliberate: it beats the upstream skills CLI's
//! SKILL.md-only bug, so bundled resources (references, scripts, assets) come along.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): resolving + installing a skill is
//! "what runs", so it lives in Core. The Gateway still governs egress at chat time.
//!
//! ## The six source forms
//!
//! | Form                                                | Strategy                         |
//! |-----------------------------------------------------|----------------------------------|
//! | `owner/repo`                                        | tarball (github codeload)        |
//! | `https://github.com/owner/repo`                     | tarball (github codeload)        |
//! | `https://github.com/owner/repo/tree/<ref>/<subdir>` | tarball at `<ref>`, scoped subdir|
//! | `https://gitlab.com/owner/repo` (and subgroups)     | tarball (gitlab archive)         |
//! | `git@host:owner/repo.git`                            | `git clone --depth 1`            |
//! | `/abs/path` or `./rel/path` (existing dir)          | local copy                       |
//!
//! Remote https tarball hosts go through the same SSRF guard the rest of Core uses
//! before any fetch. Remote sources are fetched only through Core's pinned,
//! redirect-rechecking client. Unsupported remote Git clone forms fail closed;
//! a `git` child process cannot inherit Core's DNS pin and would reopen the SSRF
//! window after the initial screen.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::skills_catalog::InstallResult;
use crate::win_process::NoWindow;

// One module, split over files by responsibility. Each part is spliced in
// here, so every item keeps its path, its visibility and its order.
include!("from_source/source.rs");
include!("from_source/locate.rs");
include!("from_source/install_dir.rs");

#[cfg(test)]
mod tests {
    use super::*;

    include!("from_source/tests/parse_and_install.rs");
    include!("from_source/tests/unattended.rs");
}

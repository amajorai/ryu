pub mod ghost;
pub mod island;
pub mod llmfit;
mod orphan;
pub mod restate;
mod satellite_downloader;
pub mod screenpipe;
pub mod shadow;
mod supervised_child;
pub mod ytdlp;

pub use ghost::GhostManager;
pub use llmfit::LlmFit;
pub use restate::RestateManager;
pub use screenpipe::ScreenpipeSidecar;
pub use shadow::ShadowManager;

/// The version string recorded when a tool binary cannot report its own.
///
/// Tool archives are fetched from each satellite's `releases/latest`, so this is
/// literally what was installed; it is simply not semver, so update checks treat
/// the install as version-unknown.
pub(crate) const UNKNOWN_TOOL_VERSION: &str = "latest";

/// The [`crate::update::platform_tag`] slugs the Ghost and Shadow satellite release
/// workflows publish `<bin>-<slug>.tar.gz|.zip` archives for.
///
/// This must match the `plat:` matrix that `tools/mirror-satellite.sh` (kind
/// `rust-archive`) generates into `amajorai/{ghost,shadow}`;
/// `tools/satellite-binary-contract.test.mjs` fails when the two lists drift. A host
/// outside this list has no archive to download, so the downloaders report that
/// directly instead of fetching a URL that can only 404.
pub(crate) const SATELLITE_ARCHIVE_PLATFORMS: &[&str] = &[
    "linux-x86_64",
    "macos-aarch64",
    "macos-x86_64",
    "windows-x86_64",
];

/// Why `platform` cannot install `tool` from its satellite release, or `None` when
/// the satellite publishes an archive for it.
///
/// Only consulted when the operator has not set `override_env` (a full archive URL),
/// because that override exists to cover exactly these platforms.
pub(crate) fn unpublished_satellite_platform(
    tool: &str,
    repo: &str,
    override_env: &str,
    platform: &str,
) -> Option<String> {
    if SATELLITE_ARCHIVE_PLATFORMS.contains(&platform) {
        return None;
    }
    Some(format!(
        "{tool} has no prebuilt release for this platform ({platform}): \
         github.com/{repo} publishes archives only for {}. Set {override_env} to a \
         self-built archive URL for {platform}, or build {tool} from source \
         (github.com/{repo}).",
        SATELLITE_ARCHIVE_PLATFORMS.join(", ")
    ))
}

/// Ask a freshly installed tool binary for its version.
///
/// `args` is the version invocation the binary supports (`["version"]` for
/// Ghost's subcommand, `["--version"]` for a clap `version` flag). The last
/// whitespace-separated token of the first output line is taken, with a leading
/// `v` stripped, and kept only if it parses as semver. Anything else (a binary
/// that predates the flag, a hang, unexpected output) falls back to
/// [`UNKNOWN_TOOL_VERSION`] rather than recording a guess.
pub(crate) async fn probe_tool_version(bin: &std::path::Path, args: &[&str]) -> String {
    let run = tokio::process::Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let Ok(Ok(output)) = tokio::time::timeout(std::time::Duration::from_secs(5), run).await else {
        return UNKNOWN_TOOL_VERSION.to_owned();
    };
    if !output.status.success() {
        return UNKNOWN_TOOL_VERSION.to_owned();
    }
    parse_tool_version(&String::from_utf8_lossy(&output.stdout))
        .unwrap_or_else(|| UNKNOWN_TOOL_VERSION.to_owned())
}

fn parse_tool_version(stdout: &str) -> Option<String> {
    let token = stdout.lines().next()?.split_whitespace().last()?;
    let token = token.strip_prefix('v').unwrap_or(token);
    semver::Version::parse(token).ok().map(|v| v.to_string())
}

#[cfg(test)]
mod version_probe_tests {
    use super::parse_tool_version;

    #[test]
    fn parses_clap_style_version_lines() {
        assert_eq!(
            parse_tool_version("ghost 0.4.1\n").as_deref(),
            Some("0.4.1")
        );
        assert_eq!(
            parse_tool_version("shadow v1.2.3-beta.1").as_deref(),
            Some("1.2.3-beta.1")
        );
    }

    #[test]
    fn rejects_output_that_is_not_a_version() {
        assert_eq!(parse_tool_version(""), None);
        assert_eq!(
            parse_tool_version("error: unexpected argument '--version'"),
            None
        );
    }
}

#[cfg(test)]
mod satellite_platform_tests {
    use super::{unpublished_satellite_platform, SATELLITE_ARCHIVE_PLATFORMS};

    #[test]
    fn published_platforms_are_platform_tag_shaped() {
        // Every entry must be something `update::platform_tag()` can actually return
        // (`std::env::consts::{OS, ARCH}` joined by `-`), or the entry is dead.
        for slug in SATELLITE_ARCHIVE_PLATFORMS {
            let (os, arch) = slug.split_once('-').expect("os-arch slug");
            assert!(["linux", "macos", "windows"].contains(&os), "{slug}");
            assert!(["x86_64", "aarch64"].contains(&arch), "{slug}");
        }
    }

    #[test]
    fn published_platform_is_not_reported() {
        for slug in SATELLITE_ARCHIVE_PLATFORMS {
            assert_eq!(
                unpublished_satellite_platform(
                    "ghost",
                    "amajorai/ghost",
                    "RYU_GHOST_RELEASE_URL",
                    slug
                ),
                None,
                "{slug}"
            );
        }
    }

    #[test]
    fn unpublished_platform_names_the_platform_and_the_override() {
        let msg = unpublished_satellite_platform(
            "shadow",
            "amajorai/shadow",
            "RYU_SHADOW_RELEASE_URL",
            "linux-aarch64",
        )
        .expect("linux-aarch64 is not published");
        assert!(msg.contains("linux-aarch64"), "{msg}");
        assert!(msg.contains("RYU_SHADOW_RELEASE_URL"), "{msg}");
        assert!(msg.contains("amajorai/shadow"), "{msg}");
        assert!(
            msg.contains("macos-x86_64"),
            "lists what IS published: {msg}"
        );
    }
}

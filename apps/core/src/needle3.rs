//! Core's Needle 3 selector for unified tool and Agent Skill discovery.
//!
//! Needle 3 is the default model-assisted ranker. This module pins the Needle 3
//! runtime and its separately shipped weights; selection, C ABI loading and the
//! lazy, checksum-verified downloads are shared with Needle 2 in
//! [`crate::needle`].

use std::sync::Arc;

use crate::needle::{NeedleRuntime, NeedleSelector, NeedleState, NeedleWeights};

static RUNTIME: NeedleRuntime = NeedleRuntime {
    label: "Needle 3",
    name: "needle3",
    repo: "Cactus-Compute/needle3",
    revision: "b274efcb211a9eef48c9a88da4b43bd569696a39",
    engine_version: "3.0.1",
    library_env_keys: &["RYU_NEEDLE3_LIB_PATH"],
    wheel_library_stem: "libneedle3",
    wheel_sha256: expected_wheel_sha256,
    weights: Some(NeedleWeights {
        env_key: "RYU_NEEDLE3_WEIGHTS_PATH",
        file_name: "needle3.cact",
        sha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38",
    }),
    state: NeedleState::new(),
};

/// Install Core's process-wide DownloadCenter before any catalog search can
/// lazily fetch the Needle runtime. Idempotent to keep test/bootstrap wiring
/// harmless when called more than once.
pub fn install_downloads(downloads: crate::downloads::DownloadCenter) {
    RUNTIME.install_downloads(downloads);
}

/// Return the shared Core Needle 3 selector.
pub fn selector() -> Arc<NeedleSelector> {
    RUNTIME.selector()
}

fn expected_wheel_sha256(platform: &str) -> Option<&'static str> {
    match platform {
        "macosx_11_0_arm64" => {
            Some("17c2b9ff3c3f1238e0a26385cfda0780d120cda390594d7fc7e5b7f2a970ce95")
        }
        "macosx_11_0_x86_64" => {
            Some("dc55a60b6803fbfd73fa50c09803df54bb47155dcdec74e5988c21838d5cc070")
        }
        "manylinux2014_aarch64" => {
            Some("0e6f0d04e42ac16f34661c7eaab027c87e1fdac294b3dbdb6ca5c9d0597398ab")
        }
        "manylinux2014_x86_64" => {
            Some("d23df1d0babeb7323dcaf860dfaf833bbd7d2229b205f691c05c9cbc6d3d3653")
        }
        "musllinux_1_2_aarch64" => {
            Some("89ae29fb3f3dabd46e374581bd87f71b7d044a95b9bd65ede2b42688ade632f0")
        }
        "musllinux_1_2_x86_64" => {
            Some("1a3558242d7f252255efff3258fc81b2d47ea74eace862fda60f16fe684caa53")
        }
        "win_amd64" => Some("3c012603a6bc5d7f36aa26da3d0819a8fa226dd40c7f242013b5e214a51168c7"),
        "win_arm64" => Some("cadcd8ff7f18b47046c547cbc450dabe607c197db2855eb6497d615ff551db0f"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use ryu_tool_registry::ToolSelector;

    use super::*;
    use crate::needle::test_support::{calendar_create, web_research_skill, web_search};

    fn current_thread_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
    }

    // A chat turn ranks tools through this selector. With automatic local
    // downloads off, a missing runtime must refuse before any download (and
    // before creating its cache dir) so ranking falls back to BM25.
    #[test]
    fn skip_local_stack_refuses_the_lazy_download() {
        crate::sidecar::onboarding::with_skip_local_stack_env(Some("1"), || {
            let runtime = current_thread_runtime();
            let library = runtime
                .block_on(RUNTIME.ensure_default_library())
                .expect_err("the runtime is not fetched while skipped");
            assert!(
                library.contains("RYU_SKIP_LOCAL_STACK_INSTALL"),
                "{library}"
            );
            let weights = runtime
                .block_on(RUNTIME.ensure_default_weights())
                .expect_err("weights are not fetched while skipped");
            assert!(
                weights.contains("RYU_SKIP_LOCAL_STACK_INSTALL"),
                "{weights}"
            );
        });
    }

    #[test]
    fn default_still_attempts_the_lazy_download() {
        crate::sidecar::onboarding::with_skip_local_stack_env(None, || {
            // Unit tests install no DownloadCenter unless an opt-in live test
            // did, so this normally fails later, at the download itself.
            if let Err(error) = current_thread_runtime().block_on(RUNTIME.ensure_default_library())
            {
                assert!(!error.contains("RYU_SKIP_LOCAL_STACK_INSTALL"), "{error}");
            }
        });
    }

    #[test]
    fn platform_wheel_is_pinned() {
        let platform = crate::needle::platform_tag().expect("test host has a Needle 3 wheel");
        let digest = expected_wheel_sha256(platform).expect("platform digest");
        assert_eq!(digest.len(), 64);
        assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn configured_runtime_selects_a_relevant_catalog_entry() {
        let Some(path) = std::env::var_os("RYU_NEEDLE3_LIB_PATH") else {
            return;
        };
        if std::env::var_os("RYU_NEEDLE3_WEIGHTS_PATH").is_none() {
            return;
        }
        assert!(
            Path::new(&path).is_file(),
            "configured Needle 3 library exists"
        );

        let candidates = vec![web_search(), calendar_create()];
        let selected = NeedleSelector::new(&RUNTIME)
            .select("search the web for the latest Rust news", &candidates)
            .await
            .expect("configured runtime returns a selection");
        assert_eq!(selected.first().map(String::as_str), Some("exa.search"));
    }

    #[tokio::test]
    async fn configured_runtime_selects_a_relevant_skill_entry() {
        let Some(path) = std::env::var_os("RYU_NEEDLE3_LIB_PATH") else {
            return;
        };
        if std::env::var_os("RYU_NEEDLE3_WEIGHTS_PATH").is_none() {
            return;
        }
        assert!(
            Path::new(&path).is_file(),
            "configured Needle 3 library exists"
        );

        let candidates = vec![web_research_skill(), calendar_create()];
        let selected = NeedleSelector::new(&RUNTIME)
            .select(
                "use a step-by-step web research workflow with source checking",
                &candidates,
            )
            .await
            .expect("configured runtime returns a skill selection");
        assert_eq!(
            selected.first().map(String::as_str),
            Some("skills.web-research")
        );
    }

    #[tokio::test]
    async fn default_runtime_can_download_and_select_when_enabled() {
        if std::env::var_os("RYU_NEEDLE3_AUTO_TEST").as_deref() != Some(std::ffi::OsStr::new("1")) {
            return;
        }
        assert!(RUNTIME
            .explicit_library_path()
            .expect("explicit path check")
            .is_none());
        assert!(RUNTIME
            .explicit_weights_path()
            .expect("explicit weights path check")
            .is_none());
        crate::downloads::install();
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        downloads.load().await;
        install_downloads(downloads);

        let selected = NeedleSelector::new(&RUNTIME)
            .select("search the web for current Rust news", &[web_search()])
            .await
            .expect("default runtime downloads and returns a selection");
        assert_eq!(selected, vec!["exa.search"]);
    }
}

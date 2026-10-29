//! Fixed GitHub.com control-plane origin. The focused harness replaces this
//! host port; production never accepts a caller URL or environment override.
pub(super) fn base_url() -> String {
    "https://api.github.com".to_owned()
}

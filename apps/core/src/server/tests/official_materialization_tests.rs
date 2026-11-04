use crate::server::should_skip_official_package_materialization;

#[test]
fn skips_only_when_manifest_and_lifecycle_record_both_exist() {
    assert!(should_skip_official_package_materialization(true, true));
    assert!(!should_skip_official_package_materialization(true, false));
    assert!(!should_skip_official_package_materialization(false, true));
    assert!(!should_skip_official_package_materialization(false, false));
}

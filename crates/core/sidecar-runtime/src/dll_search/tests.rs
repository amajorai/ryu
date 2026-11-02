use super::link_arg::dependent_load_flag_link_arg;
use super::*;

#[test]
fn msvc_windows_binaries_link_with_the_system32_dependent_load_flag() {
    assert_eq!(
        dependent_load_flag_link_arg("windows", "msvc").as_deref(),
        Some("/DEPENDENTLOADFLAG:0x800")
    );
}

#[test]
fn targets_whose_linker_lacks_the_flag_get_no_link_argument() {
    // GNU ld rejects `/DEPENDENTLOADFLAG`; non-Windows targets have no PE loader.
    assert_eq!(dependent_load_flag_link_arg("windows", "gnu"), None);
    assert_eq!(dependent_load_flag_link_arg("linux", "gnu"), None);
    assert_eq!(dependent_load_flag_link_arg("macos", ""), None);
    assert_eq!(dependent_load_flag_link_arg("", "msvc"), None);
}

#[test]
fn the_link_flag_and_the_runtime_policy_both_mean_system32_only() {
    assert_eq!(DEPENDENT_LOAD_FLAG_SYSTEM32, LOAD_LIBRARY_SEARCH_SYSTEM32);
    assert_eq!(LOAD_LIBRARY_SEARCH_SYSTEM32, 0x800);
    // A managed native library may pull its own co-located dependencies, but
    // never the application directory, the current directory, or PATH.
    assert_eq!(MANAGED_LIBRARY_LOAD_FLAGS, 0x100 | 0x800);
}

#[cfg(not(windows))]
#[test]
fn hardening_is_a_reported_no_op_off_windows() {
    assert_eq!(
        harden_dll_search().unwrap(),
        DllSearchHardening::NotApplicable
    );
}

#[cfg(windows)]
#[test]
fn hardening_applies_on_windows() {
    assert_eq!(harden_dll_search().unwrap(), DllSearchHardening::Applied);
}

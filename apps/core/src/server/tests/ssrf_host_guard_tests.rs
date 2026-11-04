use crate::server::screen_guarded_hostname;

#[test]
fn allows_normal_https_hosts() {
    assert!(screen_guarded_hostname("example.com").is_ok());
    assert!(screen_guarded_hostname("huggingface.co").is_ok());
    assert!(screen_guarded_hostname("sub.domain.example.org").is_ok());
    // Trailing-dot FQDN still allowed.
    assert!(screen_guarded_hostname("example.com.").is_ok());
    // Uppercase host is normalized, not rejected.
    assert!(screen_guarded_hostname("EXAMPLE.COM").is_ok());
}

#[test]
fn blocks_cloud_metadata_hosts() {
    assert!(screen_guarded_hostname("metadata").is_err());
    assert!(screen_guarded_hostname("metadata.google.internal").is_err());
    assert!(screen_guarded_hostname("METADATA.GOOGLE.INTERNAL").is_err());
    assert!(screen_guarded_hostname("metadata.goog").is_err());
    assert!(screen_guarded_hostname("foo.metadata.google.internal").is_err());
    assert!(screen_guarded_hostname("metadata.google.internal.").is_err());
    // A host that merely contains the word but isn't a suffix match is fine.
    assert!(screen_guarded_hostname("metadata-service.example.com").is_ok());
}

#[test]
fn blocks_non_ascii_and_homograph_hosts() {
    // Cyrillic 'а' homograph of ascii 'a'.
    assert!(screen_guarded_hostname("ex\u{0430}mple.com").is_err());
    // Zero-width joiner / bidi control embedded.
    assert!(screen_guarded_hostname("examp\u{200d}le.com").is_err());
    assert!(screen_guarded_hostname("ex\u{202e}ample.com").is_err());
    // Raw unicode label.
    assert!(screen_guarded_hostname(
        "\u{043f}\u{0440}\u{0438}\u{043c}\u{0435}\u{0440}.\u{0440}\u{0444}"
    )
    .is_err());
}

#[test]
fn blocks_control_and_whitespace_hosts() {
    assert!(screen_guarded_hostname("exa mple.com").is_err());
    assert!(screen_guarded_hostname("example.com\n").is_err());
    assert!(screen_guarded_hostname("example\t.com").is_err());
    assert!(screen_guarded_hostname("example.com\0").is_err());
    assert!(screen_guarded_hostname("").is_err());
}

#[test]
fn ip_literals_pass_through_for_later_ip_screen() {
    // IP literals are screened by is_blocked_ip after resolution, not here.
    assert!(screen_guarded_hostname("93.184.216.34").is_ok());
    assert!(screen_guarded_hostname("[2606:2800:220:1:248:1893:25c8:1946]").is_ok());
}

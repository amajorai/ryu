#[test]
fn default_site_identity_names_the_ryu_app() {
    assert_eq!(super::openrouter_site_url(), "https://ryuhq.com");
    assert_eq!(super::openrouter_site_name(), "Ryu");
}

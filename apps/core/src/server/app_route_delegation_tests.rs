use super::*;

const KEY: &str = "node-token-for-tests-0123456789abcdef";
const NODE: &str = "local:/tmp/ryu";

fn claims(user: Option<&str>, iat: u64, exp: u64) -> Claims {
    Claims {
        plugin: "@ryu/example".to_owned(),
        prefix: "/items/i1".to_owned(),
        methods: vec!["PUT".to_owned(), "GET".to_owned()],
        user: user.map(str::to_owned),
        org: None,
        node: NODE.to_owned(),
        iat,
        exp,
        jti: "j1".to_owned(),
    }
}

fn check(token: &str, sub_path: &str, method: &str, now: u64) -> Result<Claims, DelegationRefusal> {
    verify_with(
        token,
        KEY,
        "@ryu/example",
        sub_path,
        method,
        NODE,
        None,
        now,
    )
}

#[test]
fn a_delegation_admits_its_own_app_prefix_and_methods() {
    let token = sign_with(&claims(Some("member-1"), 1_000, 4_600), KEY).unwrap();
    assert!(token.starts_with(TOKEN_PREFIX));
    let ok = check(&token, "/items/i1/chunks/3", "PUT", 2_000).unwrap();
    assert_eq!(ok.user.as_deref(), Some("member-1"));
    assert!(check(&token, "/items/i1", "get", 2_000).is_ok());
}

#[test]
fn a_delegation_never_reaches_outside_what_it_names() {
    let token = sign_with(&claims(Some("member-1"), 1_000, 4_600), KEY).unwrap();
    assert_eq!(
        check(&token, "/items/i10/chunks/3", "PUT", 2_000),
        Err(DelegationRefusal::OutsidePrefix)
    );
    assert_eq!(
        check(&token, "/items", "GET", 2_000),
        Err(DelegationRefusal::OutsidePrefix)
    );
    assert_eq!(
        check(&token, "/items/i1", "DELETE", 2_000),
        Err(DelegationRefusal::MethodNotAllowed)
    );
    assert_eq!(
        verify_with(
            &token,
            KEY,
            "@ryu/other",
            "/items/i1",
            "PUT",
            NODE,
            None,
            2_000
        ),
        Err(DelegationRefusal::WrongApp)
    );
    assert_eq!(
        verify_with(
            &token,
            KEY,
            "@ryu/example",
            "/items/i1",
            "PUT",
            "node-2",
            None,
            2_000
        ),
        Err(DelegationRefusal::WrongNode)
    );
    assert_eq!(
        verify_with(
            &token,
            KEY,
            "@ryu/example",
            "/items/i1",
            "PUT",
            NODE,
            Some("org-1"),
            2_000
        ),
        Err(DelegationRefusal::WrongNode)
    );
}

#[test]
fn an_expired_forged_or_overlong_delegation_is_refused() {
    let token = sign_with(&claims(None, 1_000, 4_600), KEY).unwrap();
    assert_eq!(
        check(&token, "/items/i1", "PUT", 4_600),
        Err(DelegationRefusal::Expired)
    );
    assert_eq!(
        verify_with(
            &token,
            "another-key",
            "@ryu/example",
            "/items/i1",
            "PUT",
            NODE,
            None,
            2_000
        ),
        Err(DelegationRefusal::BadSignature)
    );
    let overlong = sign_with(&claims(None, 1_000, 1_000 + MAX_TTL_SECONDS + 1), KEY).unwrap();
    assert_eq!(
        check(&overlong, "/items/i1", "PUT", 2_000),
        Err(DelegationRefusal::Expired)
    );
    let future = sign_with(&claims(None, 9_000, 9_600), KEY).unwrap();
    assert_eq!(
        check(&future, "/items/i1", "PUT", 2_000),
        Err(DelegationRefusal::Expired)
    );

    // A tampered claims segment no longer matches its signature.
    let mut tampered = claims(Some("member-2"), 1_000, 4_600);
    tampered.prefix = "/".to_owned();
    let forged_segment = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&tampered).unwrap());
    let signature = token.rsplit_once('.').unwrap().1;
    let forged = format!("{TOKEN_PREFIX}{forged_segment}.{signature}");
    assert_eq!(
        check(&forged, "/items/i1", "PUT", 2_000),
        Err(DelegationRefusal::BadSignature)
    );
    assert_eq!(
        check("not-a-delegation", "/x", "GET", 2_000),
        Err(DelegationRefusal::Malformed)
    );
}

#[test]
fn prefixes_are_literal_and_methods_are_known() {
    for valid in ["/items", "/items/i1", "/recaps/0b8e-1f_2.x", "/a/@b~c"] {
        assert!(prefix_is_valid(valid), "{valid}");
    }
    for invalid in [
        "",
        "/",
        "items",
        "/items/",
        "//items",
        "/items/../admin",
        "/items/./x",
        "/items/:id",
        "/items/*rest",
        "/items?x=1",
        "/items#x",
        "/a%2Fb",
        "/a b",
        "/a\\b",
    ] {
        assert!(!prefix_is_valid(invalid), "{invalid}");
    }
    assert_eq!(
        normalize_methods(&["put".to_owned(), "PUT".to_owned(), "get".to_owned()]),
        Some(vec!["PUT".to_owned(), "GET".to_owned()])
    );
    assert_eq!(normalize_methods(&["TRACE".to_owned()]), None);
    assert_eq!(normalize_methods(&[]), None);
}

#[test]
fn declared_patterns_reach_a_prefix_through_params_and_rest() {
    assert!(pattern_reaches_prefix(
        "/items/:id/chunks/:seq",
        "/items/i1"
    ));
    assert!(pattern_reaches_prefix("/items/:id", "/items/i1"));
    assert!(pattern_reaches_prefix("/files/*rest", "/files/a/b"));
    assert!(!pattern_reaches_prefix("/items", "/items/i1"));
    assert!(!pattern_reaches_prefix("/other/:id", "/items/i1"));
    assert!(path_within_prefix("/items/i1", "/items/i1"));
    assert!(!path_within_prefix("/items/i1x", "/items/i1"));
}

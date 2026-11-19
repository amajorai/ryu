use super::*;

#[tokio::test]
async fn routes_public_by_design_need_no_credential_expose_no_key_and_create_nothing() {
    if !in_isolated_process(
        module_path!(),
        "routes_public_by_design_need_no_credential_expose_no_key_and_create_nothing",
    ) {
        return;
    }
    let fixture = Fixture::new().await;
    for path in PUBLIC_BY_DESIGN {
        let before = fingerprint(fixture.store).await;
        let reply = fixture.call("GET", path, &[], None).await;
        assert!(
            reply.status == StatusCode::OK || reply.status == StatusCode::NOT_FOUND,
            "{path}: {} {}",
            reply.status,
            reply.text
        );
        assert!(
            !reply.text.contains("PRIVATE KEY"),
            "{path}: {}",
            reply.text
        );
        assert!(!reply.text.contains("\"d\":"), "{path}: {}", reply.text);
        let after = fingerprint(fixture.store).await;
        assert_eq!(
            changed_tables(&before, &after),
            Vec::<String>::new(),
            "{path}: an anonymous read changed vault state"
        );
    }
}

#[tokio::test]
async fn anonymous_posts_answer_without_credentials_or_state_changes() {
    if !in_isolated_process(
        module_path!(),
        "anonymous_posts_answer_without_credentials_or_state_changes",
    ) {
        return;
    }
    let fixture = Fixture::new().await;
    for (path, body) in ANONYMOUS_POSTS {
        let before = fingerprint(fixture.store).await;
        let reply = fixture.call("POST", path, &[], Some(body)).await;
        if path.ends_with("/verify") {
            assert_eq!(
                reply.status,
                StatusCode::FORBIDDEN,
                "{path}: {}",
                reply.text
            );
            assert!(
                reply.text.contains("OTP not found"),
                "{path}: {}",
                reply.text
            );
        } else {
            // An OCSP `malformedRequest` status, never JSON.
            assert_eq!(reply.status, StatusCode::OK, "{path}: {}", reply.text);
            assert_eq!(reply.text.as_bytes(), [0x30, 0x03, 0x0a, 0x01, 0x01]);
        }
        assert!(
            !reply.text.contains("PRIVATE KEY"),
            "{path}: {}",
            reply.text
        );
        let after = fingerprint(fixture.store).await;
        assert_eq!(
            changed_tables(&before, &after),
            Vec::<String>::new(),
            "{path}: an anonymous call changed vault state"
        );
    }
}

#[test]
fn vault_public_routes_merges_exactly_the_routers_this_file_scans() {
    let mod_source = &crate::server::tests::source_text::server_source();
    assert_eq!(merged_public_router_modules(mod_source).len(), 7);
    check_public_router_merges(mod_source).unwrap();
}

#[test]
fn the_merge_check_notices_a_router_added_dropped_or_renamed() {
    let mod_source = &crate::server::tests::source_text::server_source();
    let crypto = ".merge(vault_crypto_api::public_routes())";
    assert_eq!(mod_source.matches(crypto).count(), 1);
    let added = mod_source.replace(
        crypto,
        &format!("{crypto}\n        .merge(vault_new_api::public_routes())"),
    );
    let dropped = mod_source.replace(crypto, "");
    let renamed = mod_source.replace(crypto, ".merge(vault_crypto_v2_api::public_routes())");
    let anonymous = mod_source.replace(crypto, &format!("{crypto}\n        .merge(Router::new())"));
    for (label, mutated) in [
        ("added", added),
        ("dropped", dropped),
        ("renamed", renamed),
        ("anonymous", anonymous),
    ] {
        let error = check_public_router_merges(&mutated)
            .expect_err(&format!("a {label} merge went unnoticed"));
        assert!(error.contains("scan the new router"), "{label}: {error}");
    }
}

/// A route added to a public vault router must be classified here, so it
/// cannot join the public side without a refusal case.
#[test]
fn every_public_vault_route_is_classified_in_this_file() {
    let routers = public_routers();
    let mut classified: Vec<&str> = ROUTES.iter().map(|route| route.pattern).collect();
    classified.extend(LOGIN_PATHS);
    classified.extend(COMPAT_LOGIN_PATHS);
    classified.extend(WRAP_PATHS);
    classified.extend(PUBLIC_BY_DESIGN);
    classified.extend(ANONYMOUS_POSTS.iter().map(|(path, _)| *path));

    for router in routers {
        let start = router
            .source
            .find(router.function)
            .unwrap_or_else(|| panic!("{} is missing", router.function));
        let rest = &router.source[start..];
        let body = &rest[..rest.find("\n}\n").expect("the end of the router")];
        let mut registered = 0;
        for (index, _) in body.match_indices(".route(") {
            registered += 1;
            let after = body[index + ".route(".len()..].trim_start();
            let path = if let Some(quoted) = after.strip_prefix('"') {
                Some(quoted[..quoted.find('"').expect("a closing quote")].to_owned())
            } else if after.starts_with("CA_PATH") {
                Some(CA_PATH.to_owned())
            } else {
                None
            };
            if let Some(path) = path {
                assert!(
                    classified
                        .iter()
                        .any(|candidate| classifies(&path, candidate)),
                    "{path} is a public vault route with no refusal case in this file"
                );
            }
        }
        assert_eq!(
            registered, router.routes,
            "the public router in `{}` changed; classify the new route in this file",
            router.function
        );
    }
}

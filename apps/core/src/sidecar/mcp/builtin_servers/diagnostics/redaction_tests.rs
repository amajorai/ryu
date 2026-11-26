//! Redaction of credentials, personal data and opaque blobs.
//!
//! Every made-up credential is built at run time, so no literal in this file
//! has the shape of a real one.

use serde_json::json;

use super::*;

/// A token body: 32 characters of lower case and digits.
fn body() -> String {
    "fake0123".repeat(4)
}

fn no_homes(text: &str) -> String {
    redact_text_with_homes(text, &[])
}

/// `text` holds `private` before redaction and not after.
fn assert_removed(text: &str, private: &str) {
    assert!(text.contains(private), "the sample must hold `{private}`");
    let out = no_homes(text);
    assert!(!out.contains(private), "`{private}` survived in `{out}`");
}

#[test]
fn credentials_in_headers_are_removed() {
    let secret = body();
    assert_removed(&format!("Authorization: Bearer {secret}"), &secret);
    assert_removed(&format!("authorization: Basic {secret}"), &secret);
    assert_removed(&format!("Proxy-Authorization: Digest {secret}"), &secret);
    assert_removed(&format!("\"Authorization\": \"{secret}\""), &secret);
    assert_removed(&format!("Cookie: session={secret}; theme=dark"), &secret);
    assert_removed(&format!("Set-Cookie: sid={secret}; HttpOnly"), &secret);
    // The whole cookie line goes, not only the first pair.
    assert!(!no_homes("Cookie: a=fakeone; b=faketwo").contains("faketwo"));
}

#[test]
fn bearer_and_basic_credentials_are_removed_anywhere_in_a_line() {
    let secret = body();
    assert_removed(
        &format!("upstream said 401 for bearer {secret} today"),
        &secret,
    );
    assert_removed(&format!("sent Basic {secret}"), &secret);
}

#[test]
fn provider_and_ryu_token_shapes_are_removed() {
    let secret = body();
    for prefix in [
        "sk-",
        "ghp_",
        "gho_",
        "github_pat_",
        "xoxb-",
        "hf_",
        "glpat-",
        "npm_",
        "ryu_",
        "gwadm_",
    ] {
        let token = format!("{prefix}{secret}");
        let out = no_homes(&format!("the call used {token} and failed"));
        assert!(!out.contains(&secret), "{prefix} token survived in `{out}`");
        assert!(out.starts_with("the call used "), "{out}");
        assert!(out.ends_with(" and failed"), "{out}");
    }
    let aws = format!("AKIA{}", "FAKE0123".repeat(2));
    assert_removed(&format!("key id {aws}"), &aws);
}

#[test]
fn a_json_web_token_is_removed() {
    let part = "fakePart0123";
    let jwt = format!("eyJ{part}.{part}.{part}");
    assert_removed(&format!("the session was {jwt}"), &jwt);
}

#[test]
fn a_private_key_block_is_removed_even_when_it_is_cut_off() {
    let key = "fakekeymaterial";
    let whole = format!("-----BEGIN RSA PRIVATE KEY-----\n{key}\n-----END RSA PRIVATE KEY-----");
    assert_removed(&format!("read {whole} from disk"), key);
    let cut_off = format!("-----BEGIN PRIVATE KEY-----\n{key}");
    assert_removed(&cut_off, key);
}

#[test]
fn credentials_in_a_url_are_removed() {
    let secret = body();
    let out = no_homes(&format!(
        "GET https://fakeuser:{secret}@example.test/v1 failed"
    ));
    assert!(!out.contains(&secret), "{out}");
    assert!(!out.contains("fakeuser"), "{out}");
    assert!(out.contains("example.test/v1"), "{out}");
    for name in [
        "token",
        "api_key",
        "access_token",
        "signature",
        "code",
        "password",
    ] {
        let url = format!("https://example.test/cb?page=2&{name}={secret}&next=1");
        let out = no_homes(&url);
        assert!(!out.contains(&secret), "{name} survived in `{out}`");
        assert!(out.contains("page=2"), "{out}");
    }
}

#[test]
fn a_value_behind_a_secret_name_is_removed() {
    for sample in [
        "password=hunter2fake",
        "PASSWORD: hunter2fake",
        "OPENAI_API_KEY=hunter2fake",
        "x-ryu-node-token: hunter2fake",
        "client_secret = hunter2fake",
        "\"api_key\": \"hunter2fake\"",
        "{\\\"refresh_token\\\":\\\"hunter2fake\\\"}",
        "passphrase='hunter2fake'",
        "vault_value=hunter2fake",
        "secret: \"hunter2fake with spaces\"",
    ] {
        let out = no_homes(sample);
        assert!(!out.contains("hunter2fake"), "`{sample}` became `{out}`");
    }
}

#[test]
fn counters_and_plain_words_are_kept() {
    for plain in [
        "max_tokens=4096",
        "The Gateway is not answering Core.",
        "3 of 12 background services are running.",
        "Turn Safe Mode off in Settings and restart Ryu.",
        "tool web.search ended with status 500",
    ] {
        assert_eq!(no_homes(plain), plain);
    }
}

#[test]
fn a_secret_passed_as_a_command_line_flag_is_removed() {
    for sample in [
        "deploy --token hunter2fake --region eu",
        "deploy --api-key=hunter2fake",
        "mysql -u fake --password 'hunter2fake'",
        "run --client-secret \"hunter2fake\"",
    ] {
        let out = no_homes(sample);
        assert!(!out.contains("hunter2fake"), "`{sample}` became `{out}`");
    }
    assert!(no_homes("deploy --token hunter2fake --region eu").contains("--region eu"));
}

#[test]
fn email_addresses_are_removed() {
    let out = no_homes("signed in as fake.person+tag@example.co.uk yesterday");
    assert_eq!(out, "signed in as [REDACTED EMAIL] yesterday");
}

#[test]
fn home_folders_are_folded_to_a_tilde() {
    let out = no_homes("open C:\\Users\\fakeperson\\AppData\\ryu\\core.log failed");
    assert!(!out.contains("fakeperson"), "{out}");
    assert!(out.contains("core.log"), "{out}");
    for sample in [
        "/Users/fakeperson/Library/ryu/core.log",
        "/home/fakeperson/.ryu/core.log",
        "c:/users/fakeperson/ryu/core.log",
        "C:\\\\Users\\\\fakeperson\\\\ryu",
    ] {
        let out = no_homes(sample);
        assert!(!out.contains("fakeperson"), "`{sample}` became `{out}`");
    }
}

#[test]
fn a_home_folder_outside_the_usual_places_is_folded_when_it_is_known() {
    let homes = vec!["D:\\People\\fakeperson".to_owned()];
    for sample in [
        "read D:\\People\\fakeperson\\ryu\\config.json",
        "read D:\\\\People\\\\fakeperson\\\\ryu\\\\config.json",
        "read D:/People/fakeperson/ryu/config.json",
    ] {
        let out = redact_text_with_homes(sample, &homes);
        assert!(!out.contains("fakeperson"), "`{sample}` became `{out}`");
        assert!(out.contains("config.json"), "{out}");
    }
}

#[test]
fn public_addresses_are_removed_and_local_ones_are_kept() {
    assert_eq!(
        no_homes("connect to 203.0.113.7:443 failed"),
        "connect to [REDACTED IP]:443 failed"
    );
    for local in [
        "127.0.0.1:7980",
        "10.0.0.5",
        "192.168.1.20",
        "172.16.4.1",
        "169.254.1.1",
        "0.0.0.0:8080",
    ] {
        assert_eq!(no_homes(local), local);
    }
    // Not an address: an octet above 255.
    assert_eq!(no_homes("build 1.2.3.999"), "build 1.2.3.999");
}

#[test]
fn long_opaque_values_are_removed_and_long_plain_names_are_kept() {
    let hex = "0123456789abcdef".repeat(2);
    assert_eq!(
        no_homes(&format!("hash {hex} end")),
        "hash [REDACTED HEX] end"
    );
    let blob = "Fake0123Blob".repeat(4);
    assert_removed(&format!("value {blob} end"), &blob);
    let plain = "a_long_plain_identifier_with_no_digits_or_capitals_at_all";
    assert_eq!(no_homes(plain), plain);
}

#[test]
fn characters_that_render_as_nothing_cannot_hide_a_secret() {
    let secret = body();
    let hidden = format!("pass\u{200B}word={secret}");
    let out = no_homes(&hidden);
    assert!(!out.contains(&secret), "{out}");
}

#[test]
fn redacting_twice_changes_nothing() {
    let secret = body();
    let sample = format!(
        "Authorization: Bearer {secret}\npassword=hunter2fake for fake.person@example.com in \
         C:\\Users\\fakeperson\\ryu from 203.0.113.7 with sk-{secret} and --token {secret}"
    );
    let once = no_homes(&sample);
    assert_eq!(no_homes(&once), once);
    for private in [
        secret.as_str(),
        "hunter2fake",
        "fake.person",
        "fakeperson",
        "203.0.113.7",
    ] {
        assert!(!once.contains(private), "`{private}` survived in `{once}`");
    }
}

#[test]
fn text_is_redacted_before_it_is_cut() {
    let secret = body();
    // The token starts inside the limit and ends outside it. Cut first, its
    // head would no longer have a token's shape and would be shown.
    let text = format!("{} sk-{secret}", "x".repeat(40));
    let out = clean(&text, 50);
    assert!(!out.contains("fake0123"), "{out}");
    assert!(out.chars().count() <= 51, "{out}");
}

#[test]
fn clean_folds_lines_and_marks_a_cut() {
    assert_eq!(clean("  one\n two\t three  ", 100), "one two three");
    assert_eq!(clean("abcdefghij", 4), "abcd…");
    assert_eq!(clip("abc", 3), "abc");
}

#[test]
fn field_names_that_say_secret_are_recognised() {
    for name in [
        "token",
        "node_token",
        "accessToken",
        "API-KEY",
        "apiKey",
        "private_key",
        "password",
        "db_password_hash",
        "client_secret",
        "secretValue",
        "Authorization",
        "cookie",
        "set-cookie",
        "credentials",
        "x-ryu-self-call-proof",
        "vault_value",
        "jwt",
        "signature",
    ] {
        assert!(is_secret_field(name), "{name}");
    }
    for name in [
        "id",
        "key",
        "status",
        "title",
        "detail",
        "fix",
        "searchTerms",
        "message",
        "name",
        "kind",
        "label",
        "tokens_used",
        "author",
        "runStatus",
        "agentId",
        "notChecked",
        "generatedAt",
    ] {
        assert!(!is_secret_field(name), "{name}");
    }
}

#[test]
fn a_whole_result_is_redacted_field_by_field() {
    let secret = body();
    let value = json!({
        "checks": [
            { "id": "one", "detail": format!("sent Bearer {secret}") },
            { "id": "two", "node_token": secret, "has_token": true, "refresh_token": null },
        ],
        "nested": { "apiKey": { "inner": secret }, "count": 3 },
        format!("sk-{secret}"): "a field name is text too",
    });
    let out = redact_value(&value);
    assert!(!out.to_string().contains(&secret), "{out}");
    assert_eq!(out["checks"][1]["node_token"], REDACTED);
    // A flag or an empty value tells no secret and keeps its shape.
    assert_eq!(out["checks"][1]["has_token"], true);
    assert!(out["checks"][1]["refresh_token"].is_null());
    assert_eq!(out["nested"]["apiKey"], REDACTED);
    assert_eq!(out["nested"]["count"], 3);
    assert_eq!(out["checks"][0]["id"], "one");
}

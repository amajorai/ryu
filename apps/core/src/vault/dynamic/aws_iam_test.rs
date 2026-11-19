//! IAM user provider tests against a scripted IAM query API.

use std::sync::{Arc, Mutex};

use super::*;

type Calls = Arc<Mutex<Vec<BTreeMap<String, String>>>>;

/// A fake IAM endpoint: records each form body and answers with `respond`.
async fn fake_iam(
    respond: impl Fn(&BTreeMap<String, String>) -> (u16, String) + Send + Sync + 'static,
) -> (String, Calls) {
    use axum::body::Bytes;
    use axum::http::{HeaderMap, StatusCode};
    let calls: Calls = Arc::default();
    let recorded = calls.clone();
    let respond = Arc::new(respond);
    let app = axum::Router::new().fallback(move |headers: HeaderMap, body: Bytes| {
        let recorded = recorded.clone();
        let respond = respond.clone();
        async move {
            let mut form: BTreeMap<String, String> = url::form_urlencoded::parse(&body)
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect();
            let auth = headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            form.insert("_auth".into(), auth.to_owned());
            let (status, text) = respond(&form);
            recorded.lock().unwrap().push(form);
            (StatusCode::from_u16(status).unwrap(), text)
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}"), calls)
}

fn ok(form: &BTreeMap<String, String>) -> (u16, String) {
    if form.get("Action").map(String::as_str) == Some("CreateAccessKey") {
        return (
            200,
            "<CreateAccessKeyResponse><AccessKey><AccessKeyId>AKIANEW</AccessKeyId>\
             <SecretAccessKey>s3cr3t</SecretAccessKey></AccessKey></CreateAccessKeyResponse>"
                .into(),
        );
    }
    (200, "<Response/>".into())
}

fn config(endpoint: &str) -> AwsIamUserConfig {
    AwsIamUserConfig {
        access_key_id: "AKIDADMIN".into(),
        secret_access_key: "admin-secret".into(),
        policy_arns: vec!["arn:aws:iam::aws:policy/ReadOnlyAccess".into()],
        policy_document: Some(r#"{"Version":"2012-10-17","Statement":[]}"#.into()),
        iam_groups: vec!["developers".into()],
        permissions_boundary_arn: None,
        user_path: None,
        username_prefix: None,
        endpoint: Some(endpoint.to_owned()),
        region: None,
        egress: TargetEgress::Trusted,
    }
}

fn actions(calls: &Calls) -> Vec<String> {
    calls
        .lock()
        .unwrap()
        .iter()
        .map(|form| form["Action"].clone())
        .collect()
}

#[test]
fn validation_needs_a_permission_source_and_clean_inputs() {
    let mut config = config("https://iam.amazonaws.com");
    config.validate().unwrap();
    config.policy_arns.clear();
    config.policy_document = None;
    config.iam_groups.clear();
    assert!(config.validate().is_err());
    config.policy_arns = vec!["not-an-arn".into()];
    assert!(config.validate().is_err());
    config.policy_arns = vec!["arn:aws:iam::aws:policy/ReadOnlyAccess".into()];
    config.user_path = Some("ryu".into());
    assert!(config.validate().is_err());
    config.user_path = None;
    config.endpoint = Some("http://iam.example.com".into());
    assert!(config.validate().is_err());
    let summary = config.summary().to_string();
    assert!(!summary.contains("admin-secret"), "{summary}");
}

#[tokio::test]
async fn a_lease_is_a_user_with_policies_groups_and_a_key() {
    let (base, calls) = fake_iam(ok).await;
    let config = config(&base);
    let issued = issue(&config, "deploy").await.unwrap();
    assert_eq!(issued.data["accessKeyId"], "AKIANEW");
    assert_eq!(issued.data["secretAccessKey"], "s3cr3t");
    let user = issued.data["userName"].clone();
    assert!(user.starts_with("ryu-deploy-"), "{user}");
    assert_eq!(issued.ttl_cap_secs, None);
    assert_eq!(
        actions(&calls),
        [
            "CreateUser",
            "AttachUserPolicy",
            "PutUserPolicy",
            "AddUserToGroup",
            "CreateAccessKey"
        ]
    );
    {
        let calls = calls.lock().unwrap();
        assert_eq!(calls[0]["Path"], "/ryu/");
        assert_eq!(calls[0]["UserName"], user);
        assert_eq!(calls[0]["Version"], "2010-05-08");
        assert!(calls[0]["_auth"].contains("/us-east-1/iam/aws4_request"));
        assert_eq!(calls[2]["PolicyName"], "ryu-inline");
    }

    calls.lock().unwrap().clear();
    revoke(&config, &issued.revoke_data).await.unwrap();
    assert_eq!(
        actions(&calls),
        [
            "DeleteAccessKey",
            "RemoveUserFromGroup",
            "DeleteUserPolicy",
            "DetachUserPolicy",
            "DeleteUser"
        ]
    );
    assert_eq!(calls.lock().unwrap()[0]["AccessKeyId"], "AKIANEW");
}

#[tokio::test]
async fn a_failed_attach_removes_the_half_made_user() {
    let (base, calls) = fake_iam(|form| match form["Action"].as_str() {
        "AttachUserPolicy" => (
            403,
            "<ErrorResponse><Error><Code>AccessDenied</Code><Message>not allowed</Message>\
             </Error></ErrorResponse>"
                .into(),
        ),
        _ => ok(form),
    })
    .await;
    let error = issue(&config(&base), "deploy")
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(
        error.contains("iam:AttachUserPolicy returned 403 (AccessDenied)"),
        "{error}"
    );
    assert!(error.contains("cleanup ran"), "{error}");
    // Nothing was attached, so cleanup only deletes the user.
    assert_eq!(
        actions(&calls),
        ["CreateUser", "AttachUserPolicy", "DeleteUser"]
    );
}

#[tokio::test]
async fn revocation_treats_missing_pieces_as_removed() {
    let (base, calls) = fake_iam(|form| match form["Action"].as_str() {
        "DeleteAccessKey" | "DeleteUser" => (
            404,
            "<ErrorResponse><Error><Code>NoSuchEntity</Code></Error></ErrorResponse>".into(),
        ),
        _ => ok(form),
    })
    .await;
    let record = json!({ "userName": "ryu-deploy-abc", "accessKeyId": "AKIAOLD" });
    revoke(&config(&base), &record).await.unwrap();
    assert_eq!(actions(&calls), ["DeleteAccessKey", "DeleteUser"]);
}

#[tokio::test]
async fn malformed_lease_records_are_never_sent() {
    let (base, calls) = fake_iam(ok).await;
    for record in [
        json!({ "userName": "Admin" }),
        json!({ "userName": "ryu-x", "accessKeyId": "AKIA&Action=DeleteUser" }),
        json!({ "userName": "ryu-x", "iamGroups": ["a/b"] }),
        json!("nope"),
    ] {
        assert!(revoke(&config(&base), &record).await.is_err(), "{record}");
    }
    assert!(calls.lock().unwrap().is_empty());
}

use super::super::routing::Notice;
use super::super::CloudTaskBackend;
use serde_json::json;

#[test]
fn a_notice_carries_its_message_source_and_values() {
    let notice = Notice::quota_fallback(CloudTaskBackend::AnthropicSubscriptionCli, "work")
        .for_account("acct-1");
    assert_eq!(notice.code, "subscription_quota_fallback");
    assert_eq!(
        notice.message,
        "Your Claude plan (work) reached its usage or rate limit. Ryu tries the next option: \
another account only if you listed it, otherwise a Ryu Box, which uses Ryu credits."
    );
    assert_eq!(
        notice.i18n,
        json!({
            "message": "Your {planName} plan ({account}) reached its usage or rate limit. Ryu tries the next option: another account only if you listed it, otherwise a Ryu Box, which uses Ryu credits.",
            "args": { "planName": "Claude", "account": "work" },
        })
    );
    let wire = serde_json::to_value(&notice).unwrap();
    assert_eq!(wire["i18n"]["args"]["account"], "work");
    assert_eq!(wire["accountId"], "acct-1");
}

#[test]
fn each_setting_has_its_own_sentence() {
    assert_eq!(
        Notice::not_configured(CloudTaskBackend::OpenaiSubscriptionCli).message,
        "This environment has no Codex environment ID set for your ChatGPT plan."
    );
    assert_eq!(
        Notice::not_configured(CloudTaskBackend::AnthropicSubscriptionSdk).message,
        "This environment has no local checkout set for your Claude plan."
    );
}

#[test]
fn start_failures_name_the_cli() {
    assert_eq!(
        Notice::not_installed(CloudTaskBackend::OpenaiSubscriptionCli).message,
        "Codex CLI is not installed on this node."
    );
    assert_eq!(
        Notice::not_runnable(CloudTaskBackend::AnthropicSubscriptionCli).message,
        "Claude Code could not start the task because it could not be run."
    );
    let failed = Notice::start_failed(CloudTaskBackend::AnthropicSubscriptionCli, "bad flag");
    assert_eq!(failed.code, "subscription_unavailable");
    assert_eq!(
        failed.message,
        "Claude Code could not start the task: bad flag"
    );
    assert_eq!(failed.i18n["args"]["reason"], "bad flag");
}

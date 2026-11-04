use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::server::{json_error, run_after_agent_resource_permission};
use axum::http::StatusCode;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn member(user_id: &str) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org1".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    }
}

const PERSISTED_AGENT_ID: &str = "security-acp-persisted-agent";
static ACL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct RestoredAgentAcl {
    key: crate::acl::store::ResourceKey,
    previous: Vec<crate::acl::store::StoredOverwrite>,
}

impl Drop for RestoredAgentAcl {
    fn drop(&mut self) {
        let _ = crate::acl::store::set_overwrites(&self.key, self.previous.clone());
    }
}

fn install_agent_acl() -> RestoredAgentAcl {
    let key = crate::acl::store::ResourceKey::new(crate::acl::KIND_AGENT, PERSISTED_AGENT_ID);
    let previous = crate::acl::store::stored_for(&key);
    crate::acl::store::set_overwrites(
        &key,
        vec![crate::acl::store::StoredOverwrite {
            target_type: "member".to_owned(),
            target_id: "bob".to_owned(),
            allow: Vec::new(),
            deny: vec![
                crate::identity_verify::permissions::AGENT_VIEW.to_owned(),
                crate::identity_verify::permissions::AGENT_EDIT.to_owned(),
            ],
        }],
    )
    .expect("persist the agent ACL fixture");
    assert_eq!(
        crate::acl::store::stored_for(&key).len(),
        1,
        "the guard test must read the ACL from the persisted store"
    );
    RestoredAgentAcl { key, previous }
}

mod configuration_checks;
mod persisted_agent;

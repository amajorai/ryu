use super::prompts::{
    peek_conversation, register, resolve, PromptAnswer, ResolveError, PROMPT_PREFIX,
};

#[test]
fn ids_are_random_uuids_not_sequences() {
    let (a, _ra) = register("conv-p1", "user:u1", false, false);
    let (b, _rb) = register("conv-p1", "user:u1", false, false);
    assert_ne!(a, b);
    let uuid = a.strip_prefix(PROMPT_PREFIX).expect("perm-dev- prefix");
    assert_eq!(uuid::Uuid::parse_str(uuid).unwrap().get_version_num(), 4);
    assert_eq!(peek_conversation(&a).as_deref(), Some("conv-p1"));
}

#[tokio::test]
async fn a_forged_allow_always_resolves_as_deny() {
    let (id, answer) = register("conv-p2", "user:u1", false, false);
    assert_eq!(
        resolve(&id, Some("allow_always"), "user:u1"),
        Ok(PromptAnswer::Deny)
    );
    assert_eq!(answer.await.unwrap(), PromptAnswer::Deny);
    let (id, answer) = register("conv-p2", "user:u1", false, false);
    assert_eq!(
        resolve(&id, Some("approve_everything"), "user:u1"),
        Ok(PromptAnswer::Deny)
    );
    assert_eq!(answer.await.unwrap(), PromptAnswer::Deny);
    let (id, answer) = register("conv-p2", "user:u1", true, false);
    assert_eq!(
        resolve(&id, Some("allow_always"), "user:u1"),
        Ok(PromptAnswer::AllowAlways)
    );
    assert_eq!(answer.await.unwrap(), PromptAnswer::AllowAlways);
    assert_eq!(
        resolve(&id, Some("allow_once"), "user:u1"),
        Err(ResolveError::Unknown),
        "single use"
    );
}

#[tokio::test]
async fn only_the_owner_answers_and_on_device_prompts_refuse_other_surfaces() {
    let (id, answer) = register("conv-p3", "user:u1", false, false);
    assert_eq!(
        resolve(&id, Some("allow_once"), "user:u2"),
        Err(ResolveError::NotOwner)
    );
    assert_eq!(
        resolve(&id, None, "user:u1"),
        Ok(PromptAnswer::Deny),
        "cancel is a deny"
    );
    assert_eq!(answer.await.unwrap(), PromptAnswer::Deny);
    let (id, _answer) = register("conv-p3", "user:u1", false, true);
    assert_eq!(
        resolve(&id, Some("allow_once"), "user:u1"),
        Err(ResolveError::OnDeviceOnly)
    );
}

//! Two-person multiplayer journey, end to end inside one Core.
//!
//! Every other multiplayer test pins one layer with hand-built callers. This
//! module walks the whole path two real teammates take, with nothing faked
//! between them: each person holds an Ed25519-signed Better Auth JWT that goes
//! through the production offline verifier (signature, issuer, audience,
//! expiry), is narrowed to the node's organization, and is then used against the
//! real conversation store, the HTTP ACL ([`super::resource_access`]), the
//! realtime join rule ([`super::realtime_ws::decide_access`]), a live room, the
//! CRDT document registry, and the agent store's revision guard.
//!
//! The cast: Alice (org owner, design team), Bob (member, design team), Carol
//! (member, no team), Dana (org viewer) and Mallory (another organization).

use std::sync::Arc;
use std::time::Duration;

use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header};
use serde_json::json;

use super::conversations::{ConversationCollaborator, ConversationStore};
use super::realtime_ws::{decide_access, AccessOutcome};
use crate::identity_verify::{self, Access, VerifiedCaller};

const ORG: &str = "org-acme";
const TEAM: &str = "team-design";
const KID: &str = "multiplayer-journey-key";

/// A test identity provider: one Ed25519 signing key whose public half is pinned
/// in Core's JWKS cache, so minted tokens verify exactly like production ones.
/// Shared with other suites that need a real verified caller; every user of it
/// pins the SAME seed under [`KID`], so concurrent tests never race on that key.
pub(crate) struct TestIdentityProvider {
    encoding_key: EncodingKey,
    issuer: String,
}

impl TestIdentityProvider {
    pub(crate) async fn start() -> Self {
        Self::with_seed([7u8; 32], KID).await
    }

    async fn with_seed(seed: [u8; 32], kid: &str) -> Self {
        use base64::Engine as _;

        let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
        let public_x = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(signing.verifying_key().to_bytes());
        let decoding_key = DecodingKey::from_ed_components(&public_x).expect("public key decodes");
        let issuer = identity_verify::install_test_verification_key(kid, decoding_key).await;
        Self {
            encoding_key: EncodingKey::from_ed_der(&pkcs8_v1(&seed)),
            issuer,
        }
    }

    pub(crate) fn mint(&self, user: &str, org: &str, org_role: &str, teams: &[&str]) -> String {
        self.mint_with_expiry(user, org, org_role, teams, now_secs() + 600)
    }

    fn mint_with_expiry(
        &self,
        user: &str,
        org: &str,
        org_role: &str,
        teams: &[&str],
        exp: i64,
    ) -> String {
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(KID.to_owned());
        let claims = json!({
            "sub": user,
            "id": user,
            "email": format!("{user}@example.com"),
            "orgs": [{ "id": org, "role": org_role }],
            "teams": teams
                .iter()
                .map(|team| json!({ "id": team, "org": org, "role": "member" }))
                .collect::<Vec<_>>(),
            "iss": self.issuer,
            "aud": self.issuer,
            "iat": now_secs(),
            "exp": exp,
        });
        jsonwebtoken::encode(&header, &claims, &self.encoding_key).expect("token signs")
    }
}

/// PKCS#8 v1 wrapping of a raw Ed25519 seed (RFC 8410), the form
/// `EncodingKey::from_ed_der` accepts.
fn pkcs8_v1(seed: &[u8; 32]) -> Vec<u8> {
    let mut der = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    der.extend_from_slice(seed);
    der
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

/// Verify a token through the production path and narrow it to an org-bound
/// node, exactly as a request to a shared node does.
async fn sign_in(token: &str) -> VerifiedCaller {
    let (claims, _expires_at) = identity_verify::verify_jwt_with_expiry(token)
        .await
        .expect("a token minted by the identity provider verifies");
    identity_verify::to_caller_for_org(&claims, Some(ORG))
}

fn team_ids_json(caller: &VerifiedCaller) -> String {
    serde_json::to_string(&super::caller_team_ids(caller)).expect("team ids serialize")
}

async fn visible_ids(store: &ConversationStore, caller: &VerifiedCaller) -> Vec<String> {
    let teams = team_ids_json(caller);
    let mut ids: Vec<String> = store
        .list_conversations_visible_for_teams(
            Some(&caller.user_id),
            caller.org_id.as_deref(),
            true,
            Some(&teams),
        )
        .await
        .expect("list succeeds")
        .into_iter()
        .map(|summary| summary.id)
        .collect();
    ids.sort();
    ids
}

async fn http_access(
    store: &ConversationStore,
    conversation_id: &str,
    caller: Option<&VerifiedCaller>,
    node_org: Option<&str>,
) -> Option<Access> {
    super::resource_access(
        store.get_access_meta(conversation_id).await,
        caller,
        node_org,
        "not found",
    )
    .ok()
}

async fn realtime_access(
    store: &ConversationStore,
    conversation_id: &str,
    caller: Option<&VerifiedCaller>,
    peer_is_loopback: bool,
) -> Option<Access> {
    match decide_access(
        store.get_access_meta(conversation_id).await,
        caller,
        peer_is_loopback,
    ) {
        AccessOutcome::Grant(access) => Some(access),
        AccessOutcome::Deny(_) => None,
    }
}

/// Alice's three chats: one private, one for the design team, one for the org.
async fn seed_alice_chats(store: &ConversationStore) {
    for (id, visibility, team) in [
        ("alice-private", "private", None),
        ("design-review", "team", Some(TEAM)),
        ("all-hands", "org", None),
    ] {
        store
            .claim_tenancy(id, "alice", Some(ORG))
            .await
            .expect("tenancy claims");
        store
            .append_message(id, "user", "notes", None, Some("alice"), None)
            .await
            .expect("message appends");
        store
            .set_visibility(id, visibility, team, true)
            .await
            .expect("visibility sets");
    }
}

#[tokio::test]
async fn teammates_see_exactly_what_was_shared_with_them_over_http_and_realtime() {
    let idp = TestIdentityProvider::start().await;
    let alice = sign_in(&idp.mint("alice", ORG, "owner", &[TEAM])).await;
    let bob = sign_in(&idp.mint("bob", ORG, "member", &[TEAM])).await;
    let carol = sign_in(&idp.mint("carol", ORG, "member", &[])).await;
    let dana = sign_in(&idp.mint("dana", ORG, "viewer", &[])).await;
    let mallory = sign_in(&idp.mint("mallory", "org-other", "owner", &[])).await;
    assert_eq!(bob.org_id.as_deref(), Some(ORG));
    assert_eq!(mallory.org_id, None, "another org's member has no org here");

    let store = ConversationStore::open_in_memory().expect("store opens");
    seed_alice_chats(&store).await;

    // Listing: each person sees what was shared with them, nothing more.
    assert_eq!(
        visible_ids(&store, &alice).await,
        ["alice-private", "all-hands", "design-review"]
    );
    assert_eq!(
        visible_ids(&store, &bob).await,
        ["all-hands", "design-review"]
    );
    assert_eq!(visible_ids(&store, &carol).await, ["all-hands"]);
    assert_eq!(visible_ids(&store, &dana).await, ["all-hands"]);
    assert!(visible_ids(&store, &mallory).await.is_empty());

    // Alice shares her private chat with Bob directly, read-only.
    store
        .set_access(
            "alice-private",
            "private",
            None,
            &[ConversationCollaborator {
                user_id: "bob".to_owned(),
                role: "viewer".to_owned(),
            }],
            true,
        )
        .await
        .expect("sharing succeeds");
    assert_eq!(
        visible_ids(&store, &bob).await,
        ["alice-private", "all-hands", "design-review"]
    );
    assert!(!visible_ids(&store, &carol)
        .await
        .contains(&"alice-private".to_owned()));

    // HTTP and the realtime gateway agree for every person and every chat, and
    // each grant is the level the role allows (a viewer reads, never writes).
    let expected = [
        (&alice, "alice-private", Some(Access::Write)),
        (&alice, "design-review", Some(Access::Write)),
        (&alice, "all-hands", Some(Access::Write)),
        (&bob, "alice-private", Some(Access::Read)),
        (&bob, "design-review", Some(Access::Write)),
        (&bob, "all-hands", Some(Access::Write)),
        (&carol, "alice-private", None),
        (&carol, "design-review", None),
        (&carol, "all-hands", Some(Access::Write)),
        (&dana, "design-review", None),
        (&dana, "all-hands", Some(Access::Read)),
        (&mallory, "all-hands", None),
    ];
    for (caller, chat, want) in expected {
        let over_http = http_access(&store, chat, Some(caller), Some(ORG)).await;
        let over_realtime = realtime_access(&store, chat, Some(caller), false).await;
        assert_eq!(over_http, want, "{} on {chat} over HTTP", caller.user_id);
        assert_eq!(
            over_realtime, want,
            "{} on {chat} over realtime",
            caller.user_id
        );
    }
}

#[tokio::test]
async fn dropping_or_forging_identity_never_reaches_a_teammates_chat() {
    let idp = TestIdentityProvider::start().await;
    let store = ConversationStore::open_in_memory().expect("store opens");
    seed_alice_chats(&store).await;

    // A token signed by a key the identity provider never published fails
    // verification, so it can only ever be anonymous.
    let forger = TestIdentityProvider {
        encoding_key: EncodingKey::from_ed_der(&pkcs8_v1(&[9u8; 32])),
        issuer: idp.issuer.clone(),
    };
    let forged = forger.mint("alice", ORG, "owner", &[TEAM]);
    assert!(identity_verify::verify_jwt_with_expiry(&forged)
        .await
        .is_err());
    let expired = idp.mint_with_expiry("alice", ORG, "owner", &[TEAM], now_secs() - 3600);
    assert!(identity_verify::verify_jwt_with_expiry(&expired)
        .await
        .is_err());

    // Anonymous on a shared (org-bound) node: nothing, over either transport.
    for chat in ["alice-private", "design-review", "all-hands"] {
        assert_eq!(http_access(&store, chat, None, Some(ORG)).await, None);
        assert_eq!(realtime_access(&store, chat, None, false).await, None);
    }
    assert!(store
        .list_conversations_visible(None, None, true)
        .await
        .expect("list succeeds")
        .is_empty());

    // An unbound personal node reached remotely (a paired device or a node
    // token) without a user JWT is refused the owner's signed-in rows, the
    // same rule the realtime gateway applies. The owner at the machine keeps
    // offline access.
    let remote = super::REQUEST_PEER_IS_LOCAL
        .scope(false, async {
            let access = http_access(&store, "alice-private", None, None).await;
            let listed = store
                .list_conversations_visible(None, None, false)
                .await
                .expect("list succeeds");
            (access, listed.len())
        })
        .await;
    assert_eq!(remote, (None, 0));
    assert_eq!(
        realtime_access(&store, "alice-private", None, false).await,
        None
    );
    let local = super::REQUEST_PEER_IS_LOCAL
        .scope(true, async {
            let access = http_access(&store, "alice-private", None, None).await;
            let listed = store
                .list_conversations_visible(None, None, false)
                .await
                .expect("list succeeds");
            (access, listed.len())
        })
        .await;
    assert_eq!(local, (Some(Access::Write), 3));
}

#[tokio::test]
async fn two_teammates_co_edit_one_document_live() {
    use yrs::updates::decoder::Decode as _;
    use yrs::{Doc, GetString as _, ReadTxn as _, StateVector, Text as _, Transact as _, Update};

    let idp = TestIdentityProvider::start().await;
    let alice = sign_in(&idp.mint("alice", ORG, "owner", &[TEAM])).await;
    let bob = sign_in(&idp.mint("bob", ORG, "member", &[TEAM])).await;

    // Both join the design review room; Bob sees Alice arrive and type.
    let rooms = ryu_realtime::RoomRegistry::new();
    let room_id = "conversation:design-review";
    let bob_member = rooms.join(room_id, bob.user_id.clone());
    let mut bob_feed = bob_member.subscribe();
    let alice_member = rooms.join(room_id, alice.user_id.clone());
    alice_member.publish_presence(json!({ "typing": true, "member": alice.user_id }));
    let saw_alice_typing = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match bob_feed.recv().await {
                Ok(ryu_realtime::Frame::Presence(value))
                    if value.to_string().contains("\"typing\":true") =>
                {
                    return true;
                }
                Ok(_) => {}
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(saw_alice_typing, "Bob sees Alice's presence in the room");
    assert_eq!(alice_member.handle().member_count(), 2);

    // Both edit the same page at once from the same starting point. The server
    // replica relays each update verbatim; after exchanging them both editors
    // and the server hold the same text containing both edits.
    let registry = ryu_collab::DocRegistry::new(Arc::new(
        ryu_collab::CollabStore::open_in_memory().expect("collab store opens"),
    ));
    let doc_id = "page:design-review";
    let alice_doc = Doc::with_client_id(1);
    let bob_doc = Doc::with_client_id(2);
    let edit = |doc: &Doc, text: &str| -> Vec<u8> {
        let body = doc.get_or_insert_text("body");
        let mut txn = doc.transact_mut();
        body.insert(&mut txn, 0, text);
        txn.encode_diff_v1(&StateVector::default())
    };
    let apply = |doc: &Doc, update: &[u8]| {
        let mut txn = doc.transact_mut();
        txn.apply_update(Update::decode_v1(update).expect("update decodes"))
            .expect("update applies");
    };
    let read = |doc: &Doc| -> String {
        let body = doc.get_or_insert_text("body");
        let txn = doc.transact();
        body.get_string(&txn)
    };

    let from_alice = registry
        .apply_remote_update(doc_id, &edit(&alice_doc, "Alice's intro. "))
        .expect("server accepts Alice's edit");
    let from_bob = registry
        .apply_remote_update(doc_id, &edit(&bob_doc, "Bob's summary. "))
        .expect("server accepts Bob's edit");
    apply(&alice_doc, &from_bob);
    apply(&bob_doc, &from_alice);

    let server_doc = Doc::new();
    apply(
        &server_doc,
        &registry
            .diff_since(doc_id, &[])
            .expect("server state encodes"),
    );
    let merged = read(&alice_doc);
    assert_eq!(merged, read(&bob_doc));
    assert_eq!(merged, read(&server_doc));
    assert!(merged.contains("Alice's intro. ") && merged.contains("Bob's summary. "));
}

#[tokio::test]
async fn a_teammates_stale_save_is_refused_instead_of_overwriting() {
    use crate::agents::{AgentStore, AgentUpdateConflict, CreateAgent, UpdateAgent};

    let store = AgentStore::open_in_memory(&crate::sidecar::adapters::AcpAgentRegistry::new())
        .expect("agent store opens");
    let shared = store
        .create(CreateAgent {
            name: "Support triage".into(),
            ..Default::default()
        })
        .await
        .expect("agent creates");
    // Both teammates open the agent at the same revision.
    let opened_at = shared.updated_at.clone();
    tokio::time::sleep(Duration::from_millis(5)).await;

    let alice_saved = store
        .update(
            &shared.id,
            UpdateAgent {
                expected_updated_at: opened_at.clone(),
                description: Some("Alice's routing rules".into()),
                ..Default::default()
            },
        )
        .await
        .expect("Alice's save succeeds")
        .expect("agent exists");

    let bob_error = store
        .update(
            &shared.id,
            UpdateAgent {
                expected_updated_at: opened_at,
                description: Some("Bob's routing rules".into()),
                ..Default::default()
            },
        )
        .await
        .expect_err("Bob's save names a stale revision");
    let conflict = bob_error
        .downcast_ref::<AgentUpdateConflict>()
        .expect("the refusal is a revision conflict");
    assert_eq!(conflict.current_updated_at, alice_saved.updated_at);
    let current = store
        .get(&shared.id)
        .await
        .expect("agent reads")
        .expect("agent exists");
    assert_eq!(
        current.description.as_deref(),
        Some("Alice's routing rules")
    );
}

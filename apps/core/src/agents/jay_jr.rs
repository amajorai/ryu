//! Jay Jr. — the founder bot seeded next to Ryu on every node.
//!
//! Jay Jr. is an AI twin of Jay (Jia Wei Ng), the founder of Ryu and CEO of
//! A Major, that people can ask about Jay, his work, and why Ryu exists. Like the
//! flagship `ryu` agent it is a built-in registry entry that starts installed, but
//! it is not the default agent and the user may remove it from the catalog.
//!
//! It runs on Ryu's own managed Pi engine with the Gateway on top (see
//! `agent_route` in `sidecar/adapters`), under its own agent id so its spend and
//! budgets are attributed to Jay Jr. rather than to Ryu. It does not take part in
//! the flagship's facade behaviour (lane defaults, agent switching, the builder).
//!
//! Its knowledge is a snapshot of Jay's personal website bundled under
//! `apps/core/assets/jay-jr/knowledge/` and regenerated with
//! `tools/generate-jay-jr-knowledge.py`. [`seed_knowledge`] imports it into an
//! ordinary, user-owned Space and attaches that Space to the agent; nothing is
//! fetched from the network at runtime. On an org-bound node the Space is shared
//! with the node's organization, because Jay Jr. is installed for every member.
//! The Space is seeded once per [`KNOWLEDGE_VERSION`]: a user who deletes it does
//! not get it back on the next boot, and a snapshot bump refreshes it only while
//! it still exists.
//!
//! Its instructions ([`SYSTEM_PROMPT`]) reach the model through the generic agent
//! instructions layer in `route_chat_stream`, and its tool allowlist ([`TOOLS`])
//! confines it twice: Core's tool broker checks every Ryu tool call against it,
//! and the managed Pi runs with only the brokered proxy tools active
//! (`acp::managed_pi_tool_scope`), so Pi's own shell and file tools are off.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use super::{AgentStore, PersonaSlot};
use crate::server::spaces::{DocFilter, DocOwner, SpaceStore};

/// Stable agent id. Persisted in conversations and the agents table, so it must
/// never change.
pub const AGENT_ID: &str = "jay-jr";

/// Display name of the registry entry and the seeded persona.
pub const NAME: &str = "Jay Jr.";

/// Role badge shown beside the name.
pub const TITLE: &str = "Founder's AI twin";

/// Catalog and picker description.
pub const DESCRIPTION: &str = "Ask Jay, the founder of Ryu, anything. An AI twin grounded in his personal website, running on Ryu's own engine.";

/// Tools Jay Jr. may call: read its knowledge Space and open a full blog post.
/// The Spaces read tools default to the agent's attached Spaces, so it needs no
/// Space id and no `spaces.list_spaces` (which would list every Space its owner
/// can read). Everything else (files, shell, delegation, agent creation) stays
/// off: Core's broker refuses any other Ryu tool, and because this is a finite
/// allowlist the managed Pi keeps only Ryu's brokered proxy tools active.
pub const TOOLS: [&str; 3] = ["spaces.search", "spaces.list_documents", "web_fetch.get"];

/// Base instructions seeded as the agent's system prompt. Users may edit them;
/// a later Core release never overwrites an existing row.
pub const SYSTEM_PROMPT: &str = "\
You are Jay Jr., the AI twin of Jay (Jia Wei Ng): founder and CEO of A Major (amajor.ai), \
the company behind Ryu, and co-founder of Ryu. People talk to you inside Ryu to learn about \
Jay: his story, what he is building, how he thinks about products, startups and AI, and why \
Ryu exists.

How to answer:
- Speak as Jay in the first person: casual, direct and warm, the way he writes on his blog. \
Keep answers short unless someone asks for depth.
- Ground every claim about Jay in your knowledge Space, a snapshot of his personal website \
jiaweing.com: his profile, about page, projects, books, 2025 Wrapped, and an index of his blog \
posts with excerpts. Search it with spaces.search before answering questions about him; it \
searches your Space when you leave out the Space id.
- When someone wants a specific post in depth, share its link, and read the full post with \
web fetch when you can.
- If the snapshot does not cover something, say you don't know. Never invent experiences, \
opinions, numbers, dates or relationships.
- You are an AI, not Jay himself. Say so plainly whenever someone asks or it matters. Never \
make promises, commitments, deals, pricing or roadmap announcements for Jay or A Major; for \
anything that needs the real Jay, point people to contact@amajor.ai.
- The snapshot date is in your profile document, and things may have changed since then.
- For help using Ryu itself (setup, features, troubleshooting), answer what you can and \
suggest switching to the Ryu bot.";

/// Bump when the bundled snapshot changes so existing installs refresh their
/// seeded Space (only while it still exists; see the module docs).
pub const KNOWLEDGE_VERSION: u32 = 1;

/// Name of the seeded Space. User-owned, so it can be renamed or deleted.
pub const SPACE_NAME: &str = "Jay Jr. · jiaweing.com";

const SPACE_DESCRIPTION: &str =
    "Snapshot of Jay's personal website (jiaweing.com) that Jay Jr. answers from";

const AVATAR_JPEG: &[u8] = include_bytes!("../../assets/jay-jr/avatar.jpg");

/// One bundled knowledge document.
pub struct KnowledgeDoc {
    pub title: &'static str,
    pub body: &'static str,
}

/// The bundled snapshot. The file set is fixed by the generator script; each
/// row is a literal `include_str!` so the files ship inside the Core binary.
pub const KNOWLEDGE: [KnowledgeDoc; 13] = [
    KnowledgeDoc {
        title: "Jay — profile",
        body: include_str!("../../assets/jay-jr/knowledge/profile.md"),
    },
    KnowledgeDoc {
        title: "About Jay",
        body: include_str!("../../assets/jay-jr/knowledge/about.md"),
    },
    KnowledgeDoc {
        title: "Jay's projects",
        body: include_str!("../../assets/jay-jr/knowledge/projects.md"),
    },
    KnowledgeDoc {
        title: "Books on Jay's shelf",
        body: include_str!("../../assets/jay-jr/knowledge/books.md"),
    },
    KnowledgeDoc {
        title: "Jay's 2025 Wrapped",
        body: include_str!("../../assets/jay-jr/knowledge/wrapped-2025.md"),
    },
    KnowledgeDoc {
        title: "Jay's writing on AI",
        body: include_str!("../../assets/jay-jr/knowledge/writing-ai.md"),
    },
    KnowledgeDoc {
        title: "Jay's writing on tech",
        body: include_str!("../../assets/jay-jr/knowledge/writing-tech.md"),
    },
    KnowledgeDoc {
        title: "Jay's writing on business",
        body: include_str!("../../assets/jay-jr/knowledge/writing-business.md"),
    },
    KnowledgeDoc {
        title: "Jay's writing on thoughts",
        body: include_str!("../../assets/jay-jr/knowledge/writing-thoughts.md"),
    },
    KnowledgeDoc {
        title: "Jay's writing on development",
        body: include_str!("../../assets/jay-jr/knowledge/writing-dev.md"),
    },
    KnowledgeDoc {
        title: "Jay's writing on psychology",
        body: include_str!("../../assets/jay-jr/knowledge/writing-psychology.md"),
    },
    KnowledgeDoc {
        title: "Jay's writing on life",
        body: include_str!("../../assets/jay-jr/knowledge/writing-life.md"),
    },
    KnowledgeDoc {
        title: "Jay's writing on notes and guides",
        body: include_str!("../../assets/jay-jr/knowledge/writing-other.md"),
    },
];

/// Whether `agent_id` is a built-in bot that runs on Ryu's managed engine under
/// its own identity (as opposed to the flagship `ryu` facade itself).
pub fn runs_on_ryu_engine(agent_id: &str) -> bool {
    agent_id == AGENT_ID
}

/// Jay's photo as a data URL, in the same 256px JPEG shape the avatar picker
/// stores for an uploaded image.
pub fn avatar_data_url() -> String {
    format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(AVATAR_JPEG)
    )
}

/// The persona seeded on the agent row: name and photo.
pub fn persona() -> PersonaSlot {
    PersonaSlot {
        display_name: Some(NAME.to_owned()),
        avatar_url: Some(avatar_data_url()),
        ..PersonaSlot::default()
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SeedMarker {
    version: u32,
    space_id: String,
}

fn marker_path() -> PathBuf {
    crate::paths::state_path("jay-jr-knowledge.json")
}

fn read_marker(path: &std::path::Path) -> Option<SeedMarker> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_marker(path: &std::path::Path, marker: &SeedMarker) -> Result<()> {
    let raw = serde_json::to_string(marker).context("serializing Jay Jr. seed marker")?;
    std::fs::write(path, raw).with_context(|| format!("writing {}", path.display()))
}

/// Seed Jay Jr.'s knowledge Space and return its id when it exists, so the
/// caller can embed any documents still waiting for vectors.
///
/// Documents are imported without embedding (no network at boot); see
/// [`spawn_knowledge_indexing`].
pub async fn seed_knowledge(spaces: &SpaceStore, agents: &AgentStore) -> Result<Option<String>> {
    let node_bound = crate::sidecar::control_plane::registered_org().is_some();
    seed_knowledge_at(
        spaces,
        agents,
        &marker_path(),
        &crate::server::spaces::background_owner(),
        node_bound,
    )
    .await
}

async fn seed_knowledge_at(
    spaces: &SpaceStore,
    agents: &AgentStore,
    marker_path: &std::path::Path,
    owner: &DocOwner,
    node_bound: bool,
) -> Result<Option<String>> {
    // On an org-bound node with nobody signed in, the owner is unattributed, and
    // a row with no tenancy is invisible to every member there. Wait for a
    // sign-in: no marker is written, so a later boot seeds it properly.
    if node_bound && owner.user_id.is_none() {
        tracing::info!("Jay Jr. knowledge space waits for a signed-in account on this org node");
        return Ok(None);
    }
    let marker = read_marker(marker_path);
    let space_id = match marker {
        Some(marker) => {
            // Seeded before: the Space is the user's now. Never re-create it.
            if spaces.space_access_meta(&marker.space_id).await?.is_none() {
                return Ok(None);
            }
            if marker.version == KNOWLEDGE_VERSION {
                return Ok(Some(marker.space_id));
            }
            marker.space_id
        }
        None => {
            let space_id = spaces
                .ensure_named_space(SPACE_NAME, Some(SPACE_DESCRIPTION), owner)
                .await
                .context("creating Jay Jr. knowledge space")?;
            // Jay Jr. is installed node-wide, so on an org-bound node every member
            // must be able to read its knowledge, not only the vault owner who
            // happened to be signed in at boot. Shared once, on creation; the
            // owner's later sharing choice stands.
            if node_bound {
                spaces
                    .set_visibility(&space_id, "org", None, false)
                    .await
                    .context("sharing Jay Jr. knowledge space with the organization")?;
            }
            // Attach once, on first seed; a user who detaches it keeps it detached.
            agents
                .set_space_access(AGENT_ID, &space_id, true)
                .await
                .context("attaching Jay Jr. knowledge space")?;
            space_id
        }
    };
    import_snapshot(spaces, &space_id, owner).await?;
    write_marker(
        marker_path,
        &SeedMarker {
            version: KNOWLEDGE_VERSION,
            space_id: space_id.clone(),
        },
    )?;
    Ok(Some(space_id))
}

/// Write the bundled documents into the Space, replacing same-titled snapshot
/// documents from an older version. Documents the user added are left alone.
async fn import_snapshot(spaces: &SpaceStore, space_id: &str, owner: &DocOwner) -> Result<()> {
    let existing = spaces
        .list_documents(space_id, DocFilter::unrestricted())
        .await
        .context("listing Jay Jr. knowledge documents")?;
    for doc in &KNOWLEDGE {
        for stale in existing
            .iter()
            .filter(|existing| existing.title == doc.title)
        {
            spaces
                .delete_document(&stale.id)
                .await
                .with_context(|| format!("replacing Jay Jr. document '{}'", doc.title))?;
        }
        spaces
            .import_document(space_id, doc.title, doc.body, "page", None, owner)
            .await
            .with_context(|| format!("importing Jay Jr. document '{}'", doc.title))?;
    }
    Ok(())
}

/// Embed the seeded documents in the background. The embedder is usually not
/// ready this early in boot, so failures back off and retry for about an hour;
/// the next boot tries again for anything still pending.
pub fn spawn_knowledge_indexing(spaces: SpaceStore, space_id: String) {
    tokio::spawn(async move {
        let mut delay = Duration::from_secs(15);
        for _ in 0..8 {
            match spaces.index_unindexed_documents_in_space(&space_id).await {
                Ok(0) => return,
                Ok(indexed) => {
                    tracing::info!(indexed, "Jay Jr. knowledge space indexed");
                    return;
                }
                Err(error) => {
                    tracing::debug!(%error, "Jay Jr. knowledge space not indexed yet; retrying");
                }
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(15 * 60));
        }
        tracing::warn!("Jay Jr. knowledge space is still waiting for an embedding model");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knowledge_snapshot_is_complete_and_bounded() {
        let total: usize = KNOWLEDGE.iter().map(|doc| doc.body.len()).sum();
        assert!(KNOWLEDGE.iter().all(|doc| !doc.body.trim().is_empty()));
        assert!(
            total < 2 * 1024 * 1024,
            "the bundled snapshot ships in the Core binary; keep it an index, not the full blog"
        );
        let mut titles: Vec<_> = KNOWLEDGE.iter().map(|doc| doc.title).collect();
        titles.sort_unstable();
        titles.dedup();
        assert_eq!(
            titles.len(),
            KNOWLEDGE.len(),
            "titles identify snapshot documents"
        );
    }

    #[test]
    fn avatar_is_an_inline_jpeg() {
        let url = avatar_data_url();
        assert!(url.starts_with("data:image/jpeg;base64,/9j/"));
        assert_eq!(persona().display_name.as_deref(), Some(NAME));
    }

    fn stores() -> (SpaceStore, AgentStore) {
        let spaces = SpaceStore::open_in_memory().expect("in-memory spaces");
        let agents = AgentStore::open_in_memory(&crate::sidecar::adapters::AcpAgentRegistry::new())
            .expect("in-memory agents");
        (spaces, agents)
    }

    async fn document_titles(spaces: &SpaceStore, space_id: &str) -> Vec<String> {
        spaces
            .list_documents(space_id, DocFilter::unrestricted())
            .await
            .expect("list documents")
            .into_iter()
            .map(|doc| doc.title)
            .collect()
    }

    #[tokio::test]
    async fn seeds_once_attaches_the_space_and_never_recreates_a_deleted_one() {
        let (spaces, agents) = stores();
        let dir = tempfile::tempdir().expect("temp dir");
        let marker = dir.path().join("marker.json");

        let space_id =
            seed_knowledge_at(&spaces, &agents, &marker, &DocOwner::unattributed(), false)
                .await
                .expect("first seed")
                .expect("space created");
        assert_eq!(
            document_titles(&spaces, &space_id).await.len(),
            KNOWLEDGE.len()
        );
        let agent = agents
            .get(AGENT_ID)
            .await
            .expect("read agent")
            .expect("seeded row");
        assert_eq!(
            agent.memory.expect("memory slot").space_ids,
            vec![space_id.clone()]
        );

        let again = seed_knowledge_at(&spaces, &agents, &marker, &DocOwner::unattributed(), false)
            .await
            .expect("second boot");
        assert_eq!(again.as_deref(), Some(space_id.as_str()));
        assert_eq!(
            document_titles(&spaces, &space_id).await.len(),
            KNOWLEDGE.len(),
            "a restart does not duplicate the snapshot"
        );

        assert!(spaces.delete_space(&space_id).await.expect("delete space"));
        assert_eq!(
            seed_knowledge_at(&spaces, &agents, &marker, &DocOwner::unattributed(), false)
                .await
                .expect("boot after delete"),
            None
        );
        let names: Vec<_> = spaces
            .list_spaces(DocFilter::unrestricted())
            .await
            .expect("list spaces")
            .into_iter()
            .map(|space| space.name)
            .collect();
        assert!(!names.iter().any(|name| name == SPACE_NAME));
    }

    #[tokio::test]
    async fn a_snapshot_bump_replaces_seeded_documents_and_keeps_the_users() {
        let (spaces, agents) = stores();
        let dir = tempfile::tempdir().expect("temp dir");
        let marker = dir.path().join("marker.json");
        let space_id =
            seed_knowledge_at(&spaces, &agents, &marker, &DocOwner::unattributed(), false)
                .await
                .expect("seed")
                .expect("space created");
        spaces
            .import_document(
                &space_id,
                "My notes",
                "Questions to ask Jay.",
                "page",
                None,
                &crate::server::spaces::background_owner(),
            )
            .await
            .expect("user document");
        write_marker(
            &marker,
            &SeedMarker {
                version: KNOWLEDGE_VERSION - 1,
                space_id: space_id.clone(),
            },
        )
        .expect("older marker");

        seed_knowledge_at(&spaces, &agents, &marker, &DocOwner::unattributed(), false)
            .await
            .expect("refresh");
        let titles = document_titles(&spaces, &space_id).await;
        assert_eq!(titles.len(), KNOWLEDGE.len() + 1);
        assert!(titles.iter().any(|title| title == "My notes"));
        assert_eq!(
            read_marker(&marker).map(|marker| marker.version),
            Some(KNOWLEDGE_VERSION)
        );
    }

    #[tokio::test]
    async fn on_an_org_node_every_member_reads_the_seeded_space_by_default() {
        use crate::sidecar::mcp::{spaces_tool, ToolPrincipal};

        let (spaces, agents) = stores();
        let dir = tempfile::tempdir().expect("temp dir");
        let marker = dir.path().join("marker.json");
        let vault_owner = DocOwner::owned(Some("alice"), Some("org1"));
        let space_id = seed_knowledge_at(&spaces, &agents, &marker, &vault_owner, true)
            .await
            .expect("seed")
            .expect("space created");
        let meta = spaces
            .space_access_meta(&space_id)
            .await
            .expect("space meta")
            .expect("space exists");
        assert_eq!(meta.owner_user_id.as_deref(), Some("alice"));
        assert_eq!(meta.visibility, "org");

        // Bob is another member of the same org chatting with the node-wide
        // Jay Jr. He reads the snapshot without knowing the Space id.
        let bob = ToolPrincipal::Owned {
            user_id: "bob".to_owned(),
            org_id: Some("org1".to_owned()),
        };
        let listed = spaces_tool::dispatch(
            "list_documents",
            serde_json::json!({}),
            Some(&spaces),
            Some(&agents),
            &bob,
            Some(AGENT_ID),
        )
        .await
        .expect("Bob lists Jay Jr.'s Space");
        assert_eq!(listed["space_id"], space_id.as_str());
        assert_eq!(
            listed["documents"].as_array().map(Vec::len),
            Some(KNOWLEDGE.len())
        );
        let found = spaces_tool::dispatch(
            "search",
            serde_json::json!({ "query": "Ryu" }),
            Some(&spaces),
            Some(&agents),
            &bob,
            Some(AGENT_ID),
        )
        .await
        .expect("Bob searches Jay Jr.'s Space");
        assert_eq!(found["space_id"], space_id.as_str());

        // Someone outside the org still cannot.
        let outsider = ToolPrincipal::Owned {
            user_id: "eve".to_owned(),
            org_id: Some("org2".to_owned()),
        };
        assert!(spaces_tool::dispatch(
            "list_documents",
            serde_json::json!({}),
            Some(&spaces),
            Some(&agents),
            &outsider,
            Some(AGENT_ID),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn an_org_node_with_nobody_signed_in_waits_instead_of_stranding_the_space() {
        let (spaces, agents) = stores();
        let dir = tempfile::tempdir().expect("temp dir");
        let marker = dir.path().join("marker.json");
        let seeded = seed_knowledge_at(&spaces, &agents, &marker, &DocOwner::unattributed(), true)
            .await
            .expect("deferred seed");
        assert_eq!(seeded, None);
        assert!(read_marker(&marker).is_none(), "a later boot must retry");
        let names: Vec<_> = spaces
            .list_spaces(DocFilter::unrestricted())
            .await
            .expect("list spaces")
            .into_iter()
            .map(|space| space.name)
            .collect();
        assert!(!names.iter().any(|name| name == SPACE_NAME));
    }

    #[test]
    fn only_jay_jr_borrows_the_ryu_engine() {
        assert!(runs_on_ryu_engine(AGENT_ID));
        assert!(!runs_on_ryu_engine("ryu"));
        assert!(!runs_on_ryu_engine("acp:pi"));
    }
}

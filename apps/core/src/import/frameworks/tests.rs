use super::*;

fn temp_tree() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ryu-frameworks-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn write(dir: &Path, rel: &str, content: &str) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

#[test]
fn json5_converts_comments_keys_quotes_and_trailing_commas() {
    let src = r#"{
  // the default agent
  agents: { defaults: { model: 'anthropic/claude-x', workspace: "~/w", }, },
  /* servers */
  mcp: { servers: { docs: { command: "uvx", args: ['mcp-server-fetch',], enabled: true } } },
  note: 'it\'s "quoted"',
}"#;
    let value: Value = serde_json::from_str(&json5_to_json(src)).unwrap();
    assert_eq!(
        value.pointer("/agents/defaults/model").unwrap(),
        "anthropic/claude-x"
    );
    assert_eq!(
        value.pointer("/mcp/servers/docs/args/0").unwrap(),
        "mcp-server-fetch"
    );
    assert_eq!(value.pointer("/note").unwrap(), "it's \"quoted\"");
    assert_eq!(json5_to_json(r#"{"a":[1,2]}"#), r#"{"a":[1,2]}"#);
}

#[test]
fn openclaw_home_yields_persona_memory_mcp_skills_and_notes() {
    let root = temp_tree().join(".openclaw");
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    write(
        &root,
        "openclaw.json",
        r#"{
  agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] } } },
  channels: { telegram: { botToken: "123:abc" } },
  mcp: { servers: {
    docs: { command: "uvx", args: ["mcp-server-fetch"] },
    remote: { url: "https://mcp.example.com/mcp", transport: "streamable-http", headers: { Authorization: "Bearer ${T}" } },
  } },
}"#,
    );
    write(&root, "workspace/SOUL.md", "You are calm and direct.\n");
    write(
        &root,
        "workspace/IDENTITY.md",
        "- **Name:** Clawd\n- **Emoji:** 🦞\n",
    );
    write(&root, "workspace/AGENTS.md", "Always run tests.\n");
    write(&root, "workspace/HEARTBEAT.md", "check inbox\n");
    write(
        &root,
        "workspace/MEMORY.md",
        "# Facts\n- Lives in Lisbon\n- Prefers tea\n",
    );
    write(&root, "workspace/USER.md", "Name: Sam\n\nWorks on Ryu.\n");
    write(
        &root,
        "workspace/memory/2026-10-01.md",
        "- Shipped the importer\n",
    );
    write(&root, "workspace/memory/notes.md", "- not a daily file\n");
    write(
        &root,
        "workspace/skills/deploy/SKILL.md",
        "---\nname: deploy\ndescription: d\n---\nDeploy.\n",
    );
    write(
        &root,
        ".env",
        "OPENAI_API_KEY=sk-test\nTELEGRAM_BOT_TOKEN=1:x\nLOG_LEVEL=debug\n",
    );

    let scan = super::super::scan_source(&root).unwrap();
    assert_eq!(scan.source, Some("openclaw"));
    let ids: Vec<&str> = scan.items.iter().map(|i| i.id.as_str()).collect();
    assert!(ids.contains(&"agent/workspace/SOUL.md"), "{ids:?}");
    assert!(ids.contains(&"memory/workspace/MEMORY.md"), "{ids:?}");
    assert!(ids.contains(&"memory/workspace/USER.md"), "{ids:?}");
    assert!(
        ids.contains(&"memory/workspace/memory/2026-10-01.md"),
        "{ids:?}"
    );
    assert!(
        !ids.contains(&"memory/workspace/memory/notes.md"),
        "{ids:?}"
    );
    assert!(ids.contains(&"mcp_server/mcp/openclaw/docs"), "{ids:?}");
    assert!(ids.contains(&"mcp_server/mcp/openclaw/remote"), "{ids:?}");
    assert!(
        ids.iter()
            .any(|id| id.starts_with("skill/workspace/skills/deploy")),
        "{ids:?}"
    );
    let warnings = scan.warnings.join("\n");
    assert!(warnings.contains("telegram"), "{warnings}");
    assert!(warnings.contains("HEARTBEAT.md"), "{warnings}");
    assert!(warnings.contains("OPENAI_API_KEY") && warnings.contains("TELEGRAM_BOT_TOKEN"));
    assert!(
        !warnings.contains("sk-test")
            && !warnings.contains("123:abc")
            && !warnings.contains("LOG_LEVEL")
    );

    let persona = parse_persona(&root, &root.join("workspace/SOUL.md")).unwrap();
    assert_eq!(persona.name, "Clawd");
    assert_eq!(
        persona.model.as_deref(),
        Some("anthropic/claude-sonnet-4-6")
    );
    assert!(persona.system_prompt.contains("calm and direct"));
    assert!(persona.system_prompt.contains("Always run tests"));

    let servers = parse_openclaw_mcp(&root.join("openclaw.json")).unwrap();
    let remote = &servers.iter().find(|(n, _)| n == "remote").unwrap().1;
    assert_eq!(remote.transport.as_deref(), Some("http"));
    assert_eq!(remote.headers.get("Authorization").unwrap(), "Bearer ${T}");

    let memory = parse_markdown_memory(&root.join("workspace/MEMORY.md")).unwrap();
    assert_eq!(memory.entries, vec!["Lives in Lisbon", "Prefers tea"]);
    let daily = parse_markdown_memory(&root.join("workspace/memory/2026-10-01.md")).unwrap();
    assert_eq!(daily.entries, vec!["On 2026-10-01: Shipped the importer"]);
    assert_eq!(daily.category, ryu_memory::MemoryCategory::Event);
    let user = parse_markdown_memory(&root.join("workspace/USER.md")).unwrap();
    assert_eq!(user.category, ryu_memory::MemoryCategory::UserFact);
    let _ = fs::remove_dir_all(root.parent().unwrap());
}

#[test]
fn hermes_home_reads_section_delimited_memory_and_yaml_mcp() {
    let root = temp_tree().join(".hermes");
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    write(
            &root,
            "config.yaml",
            "model:\n  default: claude-sonnet-4-6\n  provider: anthropic\nmcp_servers:\n  github:\n    command: npx\n    args: [\"-y\", \"@modelcontextprotocol/server-github\"]\n    env:\n      GITHUB_PERSONAL_ACCESS_TOKEN: ${GH}\n  stripe:\n    url: https://mcp.stripe.com\n    enabled: false\n",
        );
    write(&root, "SOUL.md", "You are Hermes.\n");
    write(
        &root,
        "memories/MEMORY.md",
        "Rust service at ~/code/api\n§\nUbuntu 22.04 with Docker\n§\nPrefers concise answers\n",
    );
    write(&root, "memories/USER.md", "User is called Ada\n");
    write(
        &root,
        "skills/research/arxiv/SKILL.md",
        "---\nname: arxiv\ndescription: d\n---\nSearch.\n",
    );
    write(&root, "auth.json", "{}");

    let scan = super::super::scan_source(&root).unwrap();
    assert_eq!(scan.source, Some("hermes"));
    let ids: Vec<&str> = scan.items.iter().map(|i| i.id.as_str()).collect();
    assert!(ids.contains(&"agent/SOUL.md"), "{ids:?}");
    assert!(ids.contains(&"memory/memories/MEMORY.md"), "{ids:?}");
    assert!(ids.contains(&"mcp_server/mcp/hermes/github"), "{ids:?}");
    assert!(ids.iter().any(|id| id.contains("arxiv")), "{ids:?}");

    let memory = parse_markdown_memory(&root.join("memories/MEMORY.md")).unwrap();
    assert_eq!(memory.entries.len(), 3);
    let persona = parse_persona(&root, &root.join("SOUL.md")).unwrap();
    assert_eq!(persona.name, "hermes");
    assert_eq!(
        persona.model.as_deref(),
        Some("anthropic/claude-sonnet-4-6")
    );
    let servers = parse_hermes_mcp(&root.join("config.yaml")).unwrap();
    assert!(servers.iter().any(|(n, _)| n == "github"));
    assert!(
        !servers.iter().any(|(n, _)| n == "stripe"),
        "disabled servers are not offered"
    );
    let _ = fs::remove_dir_all(root.parent().unwrap());
}

#[test]
fn muse_export_reads_bank_memory() {
    let root = temp_tree();
    write(&root, "SOUL.md", "Muse persona\n");
    write(&root, "MEMORY.md", "- Has a dog named Pixel\n");
    write(&root, "memory/bank/preferences/food.md", "- Vegetarian\n");
    write(&root, "dreams/2026-10-01.md", "reflection\n");
    let scan = super::super::scan_source(&root).unwrap();
    assert_eq!(scan.source, Some("muse"));
    let ids: Vec<&str> = scan.items.iter().map(|i| i.id.as_str()).collect();
    assert!(
        ids.contains(&"memory/memory/bank/preferences/food.md"),
        "{ids:?}"
    );
    let bank = parse_markdown_memory(&root.join("memory/bank/preferences/food.md")).unwrap();
    assert_eq!(bank.category, ryu_memory::MemoryCategory::Preference);
    assert!(scan.warnings.iter().any(|w| w.contains("dreams")));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn mastra_agents_with_static_instructions_are_extracted() {
    let src = r#"
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";

const SUPPORT_PROMPT = `
  You are a support agent.
  Be kind.
`;

// new Agent({ name: "commented" })
export const weatherAgent = new Agent({
  name: "Weather Agent",
  instructions: "You are a helpful weather assistant." + " Use metric units.",
  model: openai("gpt-4o-mini"),
  tools: { weatherTool },
});

export const supportAgent = new Agent({
  id: "support",
  instructions: SUPPORT_PROMPT,
  model: "anthropic/claude-sonnet-4-6",
});

export const dynamicAgent = new Agent({
  name: "dynamic",
  instructions: ({ runtimeContext }) => `Hi ${runtimeContext.get("user")}`,
  model: openai("gpt-4o"),
});
"#;
    let found = extract_code_agents(src, Path::new("agents.ts"), Framework::Mastra);
    assert_eq!(found.agents.len(), 2, "{found:?}");
    assert_eq!(found.agents[0].name, "Weather Agent");
    assert_eq!(
        found.agents[0].instructions,
        "You are a helpful weather assistant. Use metric units."
    );
    assert_eq!(found.agents[0].model.as_deref(), Some("openai/gpt-4o-mini"));
    assert_eq!(found.agents[1].name, "support");
    assert_eq!(
        found.agents[1].instructions,
        "You are a support agent.\nBe kind."
    );
    assert_eq!(
        found.agents[1].model.as_deref(),
        Some("anthropic/claude-sonnet-4-6")
    );
    assert_eq!(found.unresolved, vec!["dynamic".to_string()]);
}

#[test]
fn langchain_python_and_js_agents_are_extracted() {
    let py = r#"
from langgraph.prebuilt import create_react_agent
from langchain_anthropic import ChatAnthropic

SYSTEM_PROMPT = """
    You are a research assistant.
    Cite sources.
"""

research_agent = create_react_agent(
    model=ChatAnthropic(model="claude-sonnet-4-6", temperature=0),
    tools=[search],
    prompt=SYSTEM_PROMPT,
)

# create_agent(model="x", system_prompt="commented")
writer = create_agent("openai:gpt-4o", tools=[], system_prompt=(
    "You write "
    "short posts."
), name="writer")

templated = create_agent(model="openai:gpt-4o", system_prompt=f"Hi {user}")
"#;
    let found = extract_code_agents(py, Path::new("graph.py"), Framework::LangChain);
    assert_eq!(found.agents.len(), 2, "{found:?}");
    assert_eq!(found.agents[0].name, "research_agent");
    assert_eq!(
        found.agents[0].instructions,
        "You are a research assistant.\nCite sources."
    );
    assert_eq!(
        found.agents[0].model.as_deref(),
        Some("anthropic/claude-sonnet-4-6")
    );
    assert_eq!(found.agents[1].name, "writer");
    assert_eq!(found.agents[1].instructions, "You write short posts.");
    assert_eq!(found.unresolved, vec!["templated".to_string()]);

    let js = r#"
const agent = createReactAgent({
  llm: new ChatOpenAI({ model: "gpt-4o" }),
  tools,
  prompt: 'You triage tickets.',
});
"#;
    let found = extract_code_agents(js, Path::new("agent.ts"), Framework::LangChain);
    assert_eq!(found.agents.len(), 1, "{found:?}");
    assert_eq!(found.agents[0].name, "agent");
    assert_eq!(found.agents[0].instructions, "You triage tickets.");
    assert_eq!(found.agents[0].model.as_deref(), Some("openai/gpt-4o"));
}

#[test]
fn code_projects_are_detected_and_items_round_trip() {
    let root = temp_tree();
    write(
        &root,
        "package.json",
        r#"{"dependencies":{"@mastra/core":"^0.20.0"}}"#,
    );
    write(
            &root,
            "src/mastra/agents/index.ts",
            "export const a = new Agent({ name: 'a', instructions: 'Do A.', model: 'openai/gpt-4o' });\n",
        );
    write(
        &root,
        "node_modules/x/index.js",
        "new Agent({ name: 'dep', instructions: 'no' })",
    );
    let scan = super::super::scan_source(&root).unwrap();
    assert_eq!(scan.source, Some("mastra"));
    let agent = scan.items.iter().find(|i| i.kind == kind::AGENT).unwrap();
    assert_eq!(agent.id, "agent/src/mastra/agents/index.ts#0");
    assert_eq!(
        scan.items.iter().filter(|i| i.kind == kind::AGENT).count(),
        1
    );
    let (path, index) = super::super::resolve_agent_item(&root, &agent.id).unwrap();
    assert_eq!(index, Some(0));
    let parsed = parse_code_agent(&root, &path, 0).unwrap();
    assert_eq!(parsed.instructions, "Do A.");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn one_source_file_cannot_exceed_the_agent_cap() {
    let root = temp_tree();
    write(
        &root,
        "package.json",
        r#"{"dependencies":{"@mastra/core":"^0.20.0"}}"#,
    );
    let cap = super::super::MAX_SUBAGENTS;
    let src: String = (0..cap + 25)
            .map(|i| {
                format!(
                    "export const a{i} = new Agent({{ name: 'a{i}', instructions: 'Do {i}.', model: 'openai/gpt-4o' }});\n"
                )
            })
            .collect();
    write(&root, "src/agents.ts", &src);
    let scan = super::super::scan_source(&root).unwrap();
    assert_eq!(
        scan.items.iter().filter(|i| i.kind == kind::AGENT).count(),
        cap
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn credential_names_never_include_values_or_non_secrets() {
    let names = credential_names(
        "# c\nexport OPENAI_API_KEY=\"sk\"\nEMPTY_TOKEN=\nlower_key=x\nPORT=1\nDB_PASSWORD=p\n",
    );
    assert_eq!(names, vec!["DB_PASSWORD", "OPENAI_API_KEY"]);
}

#[test]
fn plain_project_is_not_a_framework() {
    let root = temp_tree();
    write(&root, "package.json", r#"{"dependencies":{"react":"19"}}"#);
    assert_eq!(detect(&root), None);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn framework_notes_and_titles_carry_core_messages() {
    use crate::i18n::messages;
    let template = |t: crate::i18n::Template| Message::new(t).source().to_owned();
    let notices = |scan: &super::super::ScanResult| -> Vec<String> {
        scan.warning_notices
            .iter()
            .filter_map(|notice| notice.i18n.as_ref())
            .map(|message| message.source().to_owned())
            .collect()
    };

    let hermes = temp_tree().join(".hermes");
    fs::create_dir_all(&hermes).unwrap();
    write(&hermes, "config.yaml", "model: x\n");
    write(&hermes, "auth.json", "{}");
    write(&hermes, "cron/jobs.json", "[]");
    write(&hermes, "sessions/s1.json", "{}");
    write(&hermes, "memories/MEMORY.md", "- Likes tea\n");
    let scan = super::super::scan_source(&hermes).unwrap();
    assert_eq!(scan.source, Some("hermes"));
    let found = notices(&scan);
    for expected in [
        messages::IMPORT_HERMES_CRON_WARNING_MESSAGE,
        messages::IMPORT_HERMES_AUTH_WARNING_MESSAGE,
        messages::IMPORT_HERMES_SESSIONS_WARNING_MESSAGE,
    ] {
        assert!(found.contains(&template(expected)), "{found:?}");
    }
    let memory = scan
        .items
        .iter()
        .find(|i| i.id == "memory/memories/MEMORY.md")
        .unwrap();
    assert_eq!(memory.title, "Memory MEMORY.md from Hermes (1 entry)");
    assert_eq!(
        memory.title_i18n.as_ref().unwrap().source(),
        template(messages::IMPORT_SOURCE_MEMORY_ONE_TITLE_MESSAGE)
    );

    let openclaw = temp_tree().join(".openclaw");
    fs::create_dir_all(&openclaw).unwrap();
    write(&openclaw, "openclaw.json", "{}");
    write(&openclaw, "cron/jobs.json", "[]");
    write(
        &openclaw,
        ".env",
        "OPENAI_API_KEY=sk-test\nGITHUB_TOKEN=x\n",
    );
    let scan = super::super::scan_source(&openclaw).unwrap();
    let found = notices(&scan);
    assert!(
        found.contains(&template(messages::IMPORT_OPENCLAW_CRON_WARNING_MESSAGE)),
        "{found:?}"
    );
    let credentials = scan
        .warning_notices
        .iter()
        .find(|notice| {
            notice.i18n.as_ref().is_some_and(|message| {
                message.source() == template(messages::IMPORT_ENV_CREDENTIALS_WARNING_MESSAGE)
            })
        })
        .unwrap();
    assert!(
        credentials.message.starts_with(
            "The OpenClaw .env file holds 2 credentials (GITHUB_TOKEN, OPENAI_API_KEY)"
        ) || credentials.message.starts_with(
            "The OpenClaw .env file holds 2 credentials (OPENAI_API_KEY, GITHUB_TOKEN)"
        ),
        "{}",
        credentials.message
    );
    assert!(!credentials.message.contains("sk-test"));
    assert_eq!(scan.warnings.len(), scan.warning_notices.len());
    let _ = fs::remove_dir_all(hermes.parent().unwrap());
    let _ = fs::remove_dir_all(openclaw.parent().unwrap());
}

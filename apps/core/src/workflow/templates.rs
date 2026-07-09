//! Workflow **template catalog** — curated, installable workflow blueprints.
//!
//! Each template is one *primary* [`Workflow`] plus zero or more *body*
//! workflows (a durable `While` loop needs its body as a separate workflow, so
//! the loop's `body_workflow_id` points at one). Installing a template mints
//! fresh `wf_<uuid>` ids for every body, patches each `While` node's
//! `body_workflow_id` (and any `SubWorkflow.workflow_id`) to the minted id, mints
//! a fresh id for the primary, and persists them all through the shared
//! [`super::persist_workflow`] path (so triggers reconcile identically to a
//! hand-authored save). Returns the primary id.
//!
//! Per the Core-vs-Gateway rule this is **Core**: a template decides *what runs*
//! (which nodes, in what order). Every model call a node makes stays
//! Gateway-governed. Nothing is hardcoded beyond the blueprint shapes — the
//! catalog is data, and installing produces ordinary editable workflows.
//!
//! The 12 blueprints cover the common agentic patterns (Anthropic's
//! "Building effective agents" set) plus Ryu's autoresearch git-ledger loop.

use std::collections::HashMap;

use serde::Serialize;

use super::delegation::{DelegateSpec, PermissionPreset};
use super::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

/// Public listing shape for one template (`GET /api/workflows/catalog`).
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowTemplateMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    /// One of `research`, `orchestration`, `quality`, `automation`.
    pub category: String,
    /// The agentic pattern, e.g. `evaluator-optimizer`, `routing`.
    pub pattern: String,
    /// A lucide icon name the desktop/web card renders.
    pub icon: String,
    /// Node count of the primary workflow (the card's complexity hint).
    pub node_count: usize,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

/// A full template: metadata + the primary workflow + body workflows keyed by a
/// stable **placeholder** id that install-time minting patches into `While`
/// nodes.
pub struct WorkflowTemplate {
    pub meta: WorkflowTemplateMeta,
    pub primary: Workflow,
    /// `(placeholder_id, body_workflow)` pairs. The placeholder appears as a
    /// `While.body_workflow_id` (or `SubWorkflow.workflow_id`) in `primary` (or
    /// another body) and is rewritten to a minted `wf_<uuid>` on install.
    pub bodies: Vec<(String, Workflow)>,
}

// ── small DRY builders ───────────────────────────────────────────────────────

fn node(id: &str, kind: NodeKind) -> WorkflowNode {
    WorkflowNode {
        id: id.to_owned(),
        kind,
        retry: None,
        timeout_ms: None,
    }
}

fn edge(from: &str, to: &str) -> WorkflowEdge {
    WorkflowEdge {
        from: from.to_owned(),
        to: to.to_owned(),
        branch: None,
    }
}

fn branch_edge(from: &str, to: &str, branch: &str) -> WorkflowEdge {
    WorkflowEdge {
        from: from.to_owned(),
        to: to.to_owned(),
        branch: Some(branch.to_owned()),
    }
}

fn input(id: &str, key: &str) -> WorkflowNode {
    node(id, NodeKind::Input { key: Some(key.to_owned()) })
}

fn output(id: &str, key: &str) -> WorkflowNode {
    node(id, NodeKind::Output { key: Some(key.to_owned()) })
}

/// A prompt node routed to the default gateway LLM (`agent_id = None`).
fn prompt(id: &str, text: &str) -> WorkflowNode {
    node(
        id,
        NodeKind::Prompt {
            prompt: text.to_owned(),
            agent_id: None,
        },
    )
}

/// An agent node running the given agent (default `ryu`) on a task template.
fn agent(id: &str, agent_id: &str, task: &str) -> WorkflowNode {
    node(
        id,
        NodeKind::Agent {
            agent_id: agent_id.to_owned(),
            task: Some(task.to_owned()),
        },
    )
}

fn condition(id: &str, expr: &str) -> WorkflowNode {
    node(id, NodeKind::Condition { expr: expr.to_owned() })
}

fn while_loop(id: &str, expr: &str, body_placeholder: &str, max_iterations: u64) -> WorkflowNode {
    node(
        id,
        NodeKind::While {
            expr: expr.to_owned(),
            body_workflow_id: Some(body_placeholder.to_owned()),
            max_iterations: Some(max_iterations),
        },
    )
}

fn delegate(id: &str, agent_id: &str, task: &str, preset: PermissionPreset) -> DelegateSpec {
    DelegateSpec {
        id: id.to_owned(),
        task: task.to_owned(),
        agent_id: Some(agent_id.to_owned()),
        preset,
        inline: None,
    }
}

fn fanout(id: &str, delegates: Vec<DelegateSpec>) -> WorkflowNode {
    node(
        id,
        NodeKind::AgentDelegate {
            delegates,
            caps: None,
        },
    )
}

fn wf(id: &str, name: &str, description: &str, nodes: Vec<WorkflowNode>, edges: Vec<WorkflowEdge>) -> Workflow {
    Workflow {
        id: id.to_owned(),
        name: name.to_owned(),
        description: Some(description.to_owned()),
        nodes,
        edges,
        triggers: Vec::new(),
        created_at: None,
        updated_at: None,
    }
}

// ── the catalog ──────────────────────────────────────────────────────────────

/// Every curated template. Order = display order.
pub fn catalog() -> Vec<WorkflowTemplate> {
    vec![
        autoresearch(),
        prompt_chaining(),
        routing(),
        parallelization(),
        orchestrator_workers(),
        evaluator_optimizer(),
        autonomous_agent(),
        fan_out_synthesize(),
        classify_and_act(),
        adversarial_verification(),
        tournament(),
        generate_and_filter(),
    ]
}

/// The listing (`GET /api/workflows/catalog`): metadata only.
pub fn catalog_meta() -> Vec<WorkflowTemplateMeta> {
    catalog().into_iter().map(|t| t.meta).collect()
}

/// Find one template by id.
pub fn find(template_id: &str) -> Option<WorkflowTemplate> {
    catalog().into_iter().find(|t| t.meta.id == template_id)
}

fn meta(
    id: &str,
    name: &str,
    description: &str,
    category: &str,
    pattern: &str,
    icon: &str,
    node_count: usize,
    tags: &[&str],
) -> WorkflowTemplateMeta {
    WorkflowTemplateMeta {
        id: id.to_owned(),
        name: name.to_owned(),
        description: description.to_owned(),
        category: category.to_owned(),
        pattern: pattern.to_owned(),
        icon: icon.to_owned(),
        node_count,
        tags: tags.iter().map(|s| (*s).to_owned()).collect(),
        source_url: None,
    }
}

// ── install ──────────────────────────────────────────────────────────────────

/// Rewrite every `While.body_workflow_id` / `SubWorkflow.workflow_id` that names
/// a placeholder in `id_map` to its minted id.
fn patch_bodies(workflow: &mut Workflow, id_map: &HashMap<String, String>) {
    for n in &mut workflow.nodes {
        match &mut n.kind {
            NodeKind::While { body_workflow_id: Some(bid), .. } => {
                if let Some(minted) = id_map.get(bid) {
                    *bid = minted.clone();
                }
            }
            NodeKind::SubWorkflow { workflow_id } => {
                if let Some(minted) = id_map.get(workflow_id) {
                    *workflow_id = minted.clone();
                }
            }
            _ => {}
        }
    }
}

fn mint_id() -> String {
    format!("wf_{}", uuid::Uuid::new_v4().simple())
}

/// Install a template: persist all body workflows with minted ids (patched so
/// inter-body references resolve), then persist the primary (its `While` nodes
/// patched to the minted body ids). Returns the primary workflow id.
pub async fn install(template_id: &str) -> Result<String, String> {
    let tmpl = find(template_id).ok_or_else(|| format!("unknown template '{template_id}'"))?;

    // Mint a fresh id for every body placeholder up front so references resolve.
    let mut id_map: HashMap<String, String> = HashMap::new();
    for (placeholder, _) in &tmpl.bodies {
        id_map.insert(placeholder.clone(), mint_id());
    }

    // Persist each body with its minted id (patching any inter-body references).
    for (placeholder, mut body) in tmpl.bodies {
        body.id = id_map
            .get(&placeholder)
            .cloned()
            .unwrap_or_else(mint_id);
        patch_bodies(&mut body, &id_map);
        super::persist_workflow(body).await?;
    }

    // Persist the primary: fresh id (let persist mint it) + patched while nodes.
    let mut primary = tmpl.primary;
    primary.id = String::new();
    patch_bodies(&mut primary, &id_map);
    let saved = super::persist_workflow(primary).await?;
    Ok(saved.id)
}

// ── 1. autoresearch (research / git-ledger-loop) ─────────────────────────────

const AUTORESEARCH_TASK: &str = "You are an autonomous ML researcher. Minimize the experiment's `val_bpb` (lower is better) by looping with the research__* tools:\n\
1. research__init_workspace {\"experiment\":\"toy\"} to get a workspace_id, the mutable_files, and program_md (follow it).\n\
2. research__read_file the mutable train.py and study its hyperparameters.\n\
3. Form ONE small hypothesis, then research__write_file the edited train.py.\n\
4. research__run {workspace_id} — read back score, status, memory_gb.\n\
5. If status==ok AND score improved on the best so far: research__keep; else research__reset.\n\
6. research__ledger {workspace_id, commit, score, memory_gb, status, description} to log the attempt.\n\
7. Repeat with a new hypothesis. Change one thing at a time; never stop until told.\n\
Incoming goal: {{input}}";

fn autoresearch() -> WorkflowTemplate {
    let body = wf(
        "autoresearch_body",
        "Autoresearch iteration",
        "One researcher iteration: read → edit → run → keep/reset → ledger.",
        vec![
            input("task_in", "input"),
            agent("researcher", "ryu", AUTORESEARCH_TASK),
            output("body_out", "result"),
        ],
        vec![edge("task_in", "researcher"), edge("researcher", "body_out")],
    );

    let primary = wf(
        "autoresearch",
        "Autoresearch (git-ledger loop)",
        "A researcher agent loops over the research sidecar — propose an edit, run, keep-if-improved-else-reset, append the ledger — inside a durable budget loop.",
        vec![
            input("goal", "input"),
            while_loop("loop", "input nonempty", "autoresearch_body", 10),
            output("result", "result"),
        ],
        vec![edge("goal", "loop"), edge("loop", "result")],
    );

    WorkflowTemplate {
        meta: meta(
            "autoresearch",
            "Autoresearch",
            "A researcher agent iterates on an experiment via the research tools, keeping only improvements — a git-versioned autoresearch loop.",
            "research",
            "git-ledger-loop",
            "FlaskConical",
            3,
            &["research", "loop", "agent", "durable"],
        ),
        primary,
        bodies: vec![("autoresearch_body".to_owned(), body)],
    }
}

// ── 2. prompt-chaining (orchestration) ───────────────────────────────────────

fn prompt_chaining() -> WorkflowTemplate {
    let nodes = vec![
        input("in", "input"),
        prompt("outline", "Break this task into a concise outline of steps:\n\n{{input}}"),
        prompt("draft", "Write a full first draft that follows this outline:\n\n{{nodes.outline}}"),
        prompt("polish", "Polish this draft for clarity and correctness; return only the final text:\n\n{{nodes.draft}}"),
        output("out", "result"),
    ];
    let edges = vec![
        edge("in", "outline"),
        edge("outline", "draft"),
        edge("draft", "polish"),
        edge("polish", "out"),
    ];
    WorkflowTemplate {
        meta: meta(
            "prompt-chaining",
            "Prompt Chaining",
            "Decompose a task into a fixed sequence of LLM steps, each feeding the next (outline → draft → polish).",
            "orchestration",
            "prompt-chaining",
            "Link",
            5,
            &["chaining", "sequential", "decomposition"],
        ),
        primary: wf("prompt-chaining", "Prompt Chaining", "Sequential LLM steps, each feeding the next.", nodes, edges),
        bodies: vec![],
    }
}

// ── 3. routing (orchestration) ───────────────────────────────────────────────

fn routing() -> WorkflowTemplate {
    let nodes = vec![
        input("in", "input"),
        prompt("classify", "Classify this request as exactly one word — `billing`, `technical`, or `general`. Return only that word.\n\n{{input}}"),
        condition("route", "input == \"billing\""),
        prompt("billing", "You are a billing specialist. Answer this request:\n\n{{nodes.in}}"),
        prompt("other", "You are a general support agent. Answer this request:\n\n{{nodes.in}}"),
        output("out", "result"),
    ];
    let edges = vec![
        edge("in", "classify"),
        edge("classify", "route"),
        branch_edge("route", "billing", "true"),
        branch_edge("route", "other", "false"),
        edge("billing", "out"),
        edge("other", "out"),
    ];
    WorkflowTemplate {
        meta: meta(
            "routing",
            "Routing",
            "Classify the input, then branch to the specialized handler for that class.",
            "orchestration",
            "routing",
            "Split",
            6,
            &["routing", "classify", "branch"],
        ),
        primary: wf("routing", "Routing", "Classify then branch to a specialized handler.", nodes, edges),
        bodies: vec![],
    }
}

// ── 4. parallelization (orchestration) ───────────────────────────────────────

fn parallelization() -> WorkflowTemplate {
    let delegates = vec![
        delegate("worker-a", "ryu", "Analyze the following from a correctness angle:\n\n{{input}}", PermissionPreset::Research),
        delegate("worker-b", "ryu", "Analyze the following from a risk/edge-case angle:\n\n{{input}}", PermissionPreset::Research),
        delegate("worker-c", "ryu", "Analyze the following from a clarity/UX angle:\n\n{{input}}", PermissionPreset::Research),
    ];
    let nodes = vec![
        input("in", "input"),
        fanout("workers", delegates),
        prompt("synth", "Synthesize these independent analyses into one coherent answer:\n\n{{nodes.workers}}"),
        output("out", "result"),
    ];
    let edges = vec![
        edge("in", "workers"),
        edge("workers", "synth"),
        edge("synth", "out"),
    ];
    WorkflowTemplate {
        meta: meta(
            "parallelization",
            "Parallelization",
            "Fan the task out to independent clean-context workers, then synthesize their results.",
            "orchestration",
            "parallelization",
            "Network",
            4,
            &["parallel", "fan-out", "sub-agents"],
        ),
        primary: wf("parallelization", "Parallelization", "Fan out to clean-context workers, then synthesize.", nodes, edges),
        bodies: vec![],
    }
}

// ── 5. orchestrator-workers (orchestration) ──────────────────────────────────

fn orchestrator_workers() -> WorkflowTemplate {
    let delegates = vec![
        delegate("sub-1", "ryu", "Complete subtask 1 of this plan. Plan:\n\n{{nodes.plan}}", PermissionPreset::default()),
        delegate("sub-2", "ryu", "Complete subtask 2 of this plan. Plan:\n\n{{nodes.plan}}", PermissionPreset::default()),
        delegate("sub-3", "ryu", "Complete subtask 3 of this plan. Plan:\n\n{{nodes.plan}}", PermissionPreset::default()),
    ];
    let nodes = vec![
        input("in", "input"),
        prompt("plan", "You are an orchestrator. Break this goal into 3 clearly-scoped, parallelizable subtasks. Return a numbered list.\n\n{{input}}"),
        fanout("workers", delegates),
        prompt("synth", "Integrate the workers' results into one deliverable that satisfies the original goal.\n\nGoal: {{input}}\n\nResults: {{nodes.workers}}"),
        output("out", "result"),
    ];
    let edges = vec![
        edge("in", "plan"),
        edge("plan", "workers"),
        edge("workers", "synth"),
        edge("synth", "out"),
    ];
    WorkflowTemplate {
        meta: meta(
            "orchestrator-workers",
            "Orchestrator–Workers",
            "An orchestrator LLM plans subtasks, delegates them to workers, then integrates the results.",
            "orchestration",
            "orchestrator-workers",
            "Workflow",
            5,
            &["orchestrator", "planning", "sub-agents"],
        ),
        primary: wf("orchestrator-workers", "Orchestrator–Workers", "Plan → delegate → integrate.", nodes, edges),
        bodies: vec![],
    }
}

// ── 6. evaluator-optimizer (quality) ─────────────────────────────────────────

fn evaluator_optimizer() -> WorkflowTemplate {
    // The durable `while` carries a single value between iterations, and a body
    // sub-run cannot read the parent's other nodes. So the loop carries the
    // DRAFT itself, and each iteration folds the evaluator and the optimizer
    // into one step: critique the current draft, then rewrite it addressing the
    // critique, and emit the improved draft (which becomes the next carry). The
    // loop is bounded by `max_iterations`; the final carry is the refined work.
    let body = wf(
        "eo_refine_body",
        "Evaluate + optimize",
        "Critique the current draft, then rewrite it addressing every issue; return only the improved draft.",
        vec![
            input("rin", "input"),
            prompt("refine", "You are optimizing a draft. First, silently critique it against the goal on accuracy, completeness, and clarity. Then rewrite it so it fixes every weakness you found. Return ONLY the improved draft — no commentary, no score.\n\nDraft:\n{{input}}"),
            output("rout", "result"),
        ],
        vec![edge("rin", "refine"), edge("refine", "rout")],
    );
    let nodes = vec![
        input("in", "input"),
        prompt("generate", "Produce a first draft answer to:\n\n{{input}}"),
        // Carry the draft through bounded evaluate+optimize passes.
        while_loop("loop", "input nonempty", "eo_refine_body", 3),
        output("out", "result"),
    ];
    let edges = vec![
        edge("in", "generate"),
        edge("generate", "loop"),
        edge("loop", "out"),
    ];
    WorkflowTemplate {
        meta: meta(
            "evaluator-optimizer",
            "Evaluator–Optimizer",
            "Generate a draft, then iteratively critique and rewrite it over several bounded passes.",
            "quality",
            "evaluator-optimizer",
            "Gauge",
            4,
            &["eval", "refine", "loop", "quality"],
        ),
        primary: wf("evaluator-optimizer", "Evaluator–Optimizer", "Generate → (evaluate + optimize) × N → refined draft.", nodes, edges),
        bodies: vec![("eo_refine_body".to_owned(), body)],
    }
}

// ── 7. autonomous-agent (orchestration) ──────────────────────────────────────

fn autonomous_agent() -> WorkflowTemplate {
    let body = wf(
        "auto_body",
        "Autonomous step",
        "One autonomous agent turn using its own tools.",
        vec![
            input("ain", "input"),
            agent("worker", "ryu", "Continue working autonomously toward the goal using your available tools. Report progress or the final result. Goal/context:\n\n{{input}}"),
            output("aout", "result"),
        ],
        vec![edge("ain", "worker"), edge("worker", "aout")],
    );
    let nodes = vec![
        input("in", "input"),
        while_loop("loop", "input nonempty", "auto_body", 8),
        output("out", "result"),
    ];
    let edges = vec![edge("in", "loop"), edge("loop", "out")];
    WorkflowTemplate {
        meta: meta(
            "autonomous-agent",
            "Autonomous Agent",
            "A tool-using agent runs its own loop, wrapped in a bounded durable loop until it is done.",
            "orchestration",
            "autonomous-agent",
            "Bot",
            3,
            &["agent", "autonomous", "loop", "tools"],
        ),
        primary: wf("autonomous-agent", "Autonomous Agent", "A tool-using agent in a bounded loop.", nodes, edges),
        bodies: vec![("auto_body".to_owned(), body)],
    }
}

// ── 8. fan-out-synthesize (quality) ──────────────────────────────────────────

fn fan_out_synthesize() -> WorkflowTemplate {
    let delegates = vec![
        delegate("item-1", "ryu", "Process this item independently and return your result:\n\n{{input}}", PermissionPreset::default()),
        delegate("item-2", "ryu", "Process this item independently, cross-checking a different aspect:\n\n{{input}}", PermissionPreset::default()),
        delegate("item-3", "ryu", "Process this item independently, focusing on completeness:\n\n{{input}}", PermissionPreset::default()),
    ];
    let nodes = vec![
        input("in", "input"),
        fanout("fanout", delegates),
        prompt("merge", "Merge these independent results into one deduplicated, complete answer:\n\n{{nodes.fanout}}"),
        output("out", "result"),
    ];
    let edges = vec![edge("in", "fanout"), edge("fanout", "merge"), edge("merge", "out")];
    WorkflowTemplate {
        meta: meta(
            "fan-out-synthesize",
            "Fan-out / Synthesize",
            "Fan work out over items to independent sub-agents, then merge their outputs into one result.",
            "quality",
            "fan-out-synthesize",
            "GitFork",
            4,
            &["fan-out", "merge", "sub-agents"],
        ),
        primary: wf("fan-out-synthesize", "Fan-out / Synthesize", "Fan out over items, then merge.", nodes, edges),
        bodies: vec![],
    }
}

// ── 9. classify-and-act (orchestration) ──────────────────────────────────────

fn classify_and_act() -> WorkflowTemplate {
    let nodes = vec![
        input("in", "input"),
        prompt("classify", "Classify this into exactly one word — `code` or `research`. Return only that word.\n\n{{input}}"),
        condition("gate", "input == \"code\""),
        agent("coder", "ryu", "You are a coding specialist. Handle this request end-to-end:\n\n{{nodes.in}}"),
        agent("researcher", "ryu", "You are a research specialist. Handle this request end-to-end:\n\n{{nodes.in}}"),
        output("out", "result"),
    ];
    let edges = vec![
        edge("in", "classify"),
        edge("classify", "gate"),
        branch_edge("gate", "coder", "true"),
        branch_edge("gate", "researcher", "false"),
        edge("coder", "out"),
        edge("researcher", "out"),
    ];
    WorkflowTemplate {
        meta: meta(
            "classify-and-act",
            "Classify & Act",
            "Classify the request, then hand it to a specialized agent per class.",
            "orchestration",
            "classify-and-act",
            "ListTree",
            6,
            &["classify", "routing", "agents"],
        ),
        primary: wf("classify-and-act", "Classify & Act", "Classify then dispatch to a specialized agent.", nodes, edges),
        bodies: vec![],
    }
}

// ── 10. adversarial-verification (quality) ───────────────────────────────────

fn adversarial_verification() -> WorkflowTemplate {
    let verifiers = vec![
        delegate("v1", "ryu", "Independently verify this answer. Reply PASS or FAIL with a one-line reason.\n\nAnswer: {{nodes.generate}}", PermissionPreset::Research),
        delegate("v2", "ryu", "Independently verify this answer, looking for a different failure mode. Reply PASS or FAIL with a reason.\n\nAnswer: {{nodes.generate}}", PermissionPreset::Research),
        delegate("v3", "ryu", "Independently verify this answer, checking facts and edge cases. Reply PASS or FAIL with a reason.\n\nAnswer: {{nodes.generate}}", PermissionPreset::Research),
    ];
    let nodes = vec![
        input("in", "input"),
        prompt("generate", "Answer this as accurately as you can:\n\n{{input}}"),
        fanout("verify", verifiers),
        prompt("tally", "Here are independent verifier verdicts. If a MAJORITY say PASS, return exactly `PASS`; otherwise return exactly `FAIL`.\n\n{{nodes.verify}}"),
        condition("gate", "input contains \"PASS\""),
        output("out", "result"),
        prompt("revise", "The answer failed verification. Produce a corrected answer.\n\nOriginal: {{nodes.generate}}\n\nVerdicts: {{nodes.verify}}"),
    ];
    let edges = vec![
        edge("in", "generate"),
        edge("generate", "verify"),
        edge("verify", "tally"),
        edge("tally", "gate"),
        branch_edge("gate", "out", "true"),
        branch_edge("gate", "revise", "false"),
        edge("revise", "out"),
    ];
    WorkflowTemplate {
        meta: meta(
            "adversarial-verification",
            "Adversarial Verification",
            "Generate an answer, have N independent verifiers vote, and accept on majority — else revise.",
            "quality",
            "adversarial-verification",
            "ShieldCheck",
            7,
            &["verification", "voting", "quality", "sub-agents"],
        ),
        primary: wf("adversarial-verification", "Adversarial Verification", "Generate → N verifiers vote → accept or revise.", nodes, edges),
        bodies: vec![],
    }
}

// ── 11. tournament (quality) ─────────────────────────────────────────────────

fn tournament() -> WorkflowTemplate {
    let candidates = vec![
        delegate("c1", "ryu", "Produce candidate solution A to this task:\n\n{{input}}", PermissionPreset::default()),
        delegate("c2", "ryu", "Produce candidate solution B, taking a different approach:\n\n{{input}}", PermissionPreset::default()),
        delegate("c3", "ryu", "Produce candidate solution C, optimizing for a different tradeoff:\n\n{{input}}", PermissionPreset::default()),
        delegate("c4", "ryu", "Produce candidate solution D, the simplest thing that could work:\n\n{{input}}", PermissionPreset::default()),
    ];
    let nodes = vec![
        input("in", "input"),
        fanout("candidates", candidates),
        prompt("judge", "Compare these candidate solutions pairwise and pick the single best. Return the winning solution in full, with a one-line justification.\n\nTask: {{input}}\n\nCandidates: {{nodes.candidates}}"),
        output("out", "result"),
    ];
    let edges = vec![edge("in", "candidates"), edge("candidates", "judge"), edge("judge", "out")];
    WorkflowTemplate {
        meta: meta(
            "tournament",
            "Tournament",
            "Generate N candidates in parallel, then pick a winner by pairwise comparison.",
            "quality",
            "tournament",
            "Trophy",
            4,
            &["tournament", "compare", "best-of-n"],
        ),
        primary: wf("tournament", "Tournament", "N candidates → pairwise judge → winner.", nodes, edges),
        bodies: vec![],
    }
}

// ── 12. generate-and-filter (quality) ────────────────────────────────────────

fn generate_and_filter() -> WorkflowTemplate {
    let proposals = vec![
        delegate("p1", "ryu", "Generate a distinct proposal for this task:\n\n{{input}}", PermissionPreset::default()),
        delegate("p2", "ryu", "Generate a second, meaningfully different proposal:\n\n{{input}}", PermissionPreset::default()),
        delegate("p3", "ryu", "Generate a third proposal exploring another direction:\n\n{{input}}", PermissionPreset::default()),
    ];
    let nodes = vec![
        input("in", "input"),
        fanout("proposals", proposals),
        prompt("select", "Score each proposal against the task on a 0–10 scale, then return ONLY the best one (with its score).\n\nTask: {{input}}\n\nProposals: {{nodes.proposals}}"),
        output("out", "result"),
    ];
    let edges = vec![edge("in", "proposals"), edge("proposals", "select"), edge("select", "out")];
    WorkflowTemplate {
        meta: meta(
            "generate-and-filter",
            "Generate & Filter",
            "Generate N proposals in parallel, then score and select the best.",
            "quality",
            "generate-and-filter",
            "Filter",
            4,
            &["generate", "filter", "select", "best-of-n"],
        ),
        primary: wf("generate-and-filter", "Generate & Filter", "N proposals → score → select best.", nodes, edges),
        bodies: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::WorkflowGraph;

    #[test]
    fn catalog_has_twelve_templates_with_unique_ids() {
        let all = catalog();
        assert_eq!(all.len(), 12);
        let mut ids: Vec<String> = all.iter().map(|t| t.meta.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 12, "template ids must be unique");
    }

    #[test]
    fn every_primary_and_body_is_a_valid_dag() {
        for t in catalog() {
            WorkflowGraph::build(&t.primary)
                .unwrap_or_else(|e| panic!("template '{}' primary invalid: {e}", t.meta.id));
            for (ph, body) in &t.bodies {
                WorkflowGraph::build(body)
                    .unwrap_or_else(|e| panic!("template '{}' body '{ph}' invalid: {e}", t.meta.id));
            }
        }
    }

    #[test]
    fn node_count_matches_primary() {
        for t in catalog() {
            assert_eq!(
                t.meta.node_count,
                t.primary.nodes.len(),
                "template '{}' node_count mismatch",
                t.meta.id
            );
        }
    }

    #[test]
    fn every_category_and_pattern_is_known() {
        let cats = ["research", "orchestration", "quality", "automation"];
        for t in catalog() {
            assert!(cats.contains(&t.meta.category.as_str()), "bad category {}", t.meta.category);
            assert!(!t.meta.pattern.is_empty());
        }
    }

    #[test]
    fn while_nodes_reference_a_declared_body_placeholder() {
        for t in catalog() {
            let placeholders: Vec<&str> = t.bodies.iter().map(|(p, _)| p.as_str()).collect();
            for n in &t.primary.nodes {
                if let NodeKind::While { body_workflow_id: Some(bid), .. } = &n.kind {
                    assert!(
                        placeholders.contains(&bid.as_str()),
                        "template '{}' while node references undeclared body '{bid}'",
                        t.meta.id
                    );
                }
            }
        }
    }

    #[test]
    fn patch_bodies_rewrites_while_and_subworkflow_ids() {
        let mut map = HashMap::new();
        map.insert("ph".to_owned(), "wf_minted".to_owned());
        let mut w = wf(
            "x",
            "x",
            "",
            vec![
                while_loop("l", "nonempty", "ph", 3),
                node("s", NodeKind::SubWorkflow { workflow_id: "ph".to_owned() }),
            ],
            vec![],
        );
        patch_bodies(&mut w, &map);
        match &w.nodes[0].kind {
            NodeKind::While { body_workflow_id: Some(b), .. } => assert_eq!(b, "wf_minted"),
            _ => panic!("expected while"),
        }
        match &w.nodes[1].kind {
            NodeKind::SubWorkflow { workflow_id } => assert_eq!(workflow_id, "wf_minted"),
            _ => panic!("expected sub_workflow"),
        }
    }
}

//! A bounded, typed GraphRAG projection for durable memory facts.
//!
//! This is deliberately a pure projection. The encrypted memory store remains
//! the source of truth; callers provide active facts, and this module builds a
//! short-lived graph of facts, topics, people, categories, scopes, and agents.
//! Space GraphRAG is a separate implementation owned by `ryu-spaces`.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

const DEFAULT_MEMORY_SCOPES: [&str; 4] = ["agent", "user", "node", "project"];
const MAX_TERMS_PER_MEMORY: usize = 24;
const MAX_QUERY_TERMS: usize = 12;
const MAX_GRAPH_HOPS: usize = 2;

const STOP_WORDS: &[&str] = &[
    "about", "after", "again", "also", "always", "and", "because", "been", "before", "being",
    "between", "could", "from", "have", "into", "just", "like", "more", "most", "never", "only",
    "other", "over", "prefer", "should", "some", "than", "that", "their", "the", "them", "there",
    "these", "they", "this", "through", "under", "user", "very", "want", "when", "where", "which",
    "with", "would", "your",
];

// Capitalization alone is a deliberately cheap signal, but common product,
// scope, and document words should not become people just because they start a
// sentence or a proper-looking phrase (for example, "Project Apollo").
const NON_PERSON_WORDS: &[&str] = &[
    "agent", "apollo", "graph", "memory", "node", "planner", "project", "ryu", "team", "this",
    "user",
];

/// The semantic kind of a node in a memory graph.
#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryGraphNodeKind {
    Memory,
    Topic,
    Person,
    Category,
    Scope,
    Agent,
}

impl MemoryGraphNodeKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::Topic => "topic",
            Self::Person => "person",
            Self::Category => "category",
            Self::Scope => "scope",
            Self::Agent => "agent",
        }
    }

    fn is_facet(self) -> bool {
        !matches!(self, Self::Memory)
    }
}

/// One source fact used to build a graph projection.
///
/// The caller supplies only active, already-authorized source rows. The graph
/// still applies its own access predicate before returning a hit or snapshot so
/// a caller cannot accidentally use a graph edge as an access grant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryGraphDocument {
    pub memory_id: String,
    pub content: String,
    pub scope: String,
    pub scope_id: Option<String>,
    pub category: String,
    pub agent_id: Option<String>,
    pub owner_user_id: Option<String>,
    pub owner_org_id: Option<String>,
    pub importance: i32,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub sensitive_topics: Vec<String>,
}

/// A graph node returned to a management or visualization surface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryGraphNode {
    pub id: String,
    pub kind: MemoryGraphNodeKind,
    pub label: String,
    /// Stable normalized lookup form. It is useful to clients that want to
    /// filter a snapshot without reparsing display labels.
    #[serde(default)]
    pub normalized: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub sensitive: bool,
}

/// A typed edge from a fact to one of its graph facets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryGraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub memory_id: String,
    #[serde(default = "default_edge_weight")]
    pub weight: f32,
}

fn default_edge_weight() -> f32 {
    1.0
}

/// A bounded graph snapshot. Counts describe the access-filtered source set,
/// while `truncated` tells a client that the node/edge caps were reached.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MemoryGraphSnapshot {
    pub nodes: Vec<MemoryGraphNode>,
    pub edges: Vec<MemoryGraphEdge>,
    pub memory_count: usize,
    pub truncated: bool,
}

/// Access filters applied before graph hits or graph snapshots are returned.
/// `allowed_scopes = None` uses the legacy default levels and excludes `org`;
/// callers that intentionally render the complete authorized library should
/// pass all five levels explicitly.
#[derive(Debug, Clone, Copy)]
pub struct MemoryGraphQuery<'a> {
    pub agent_id: Option<&'a str>,
    /// Library snapshots may include every agent; chat recall must set false so
    /// an agent-scoped fact requires the active agent id.
    pub include_all_agents: bool,
    pub allowed_scopes: Option<&'a [String]>,
    pub project_id: Option<&'a str>,
    /// Library snapshots may include every project; chat recall must set false
    /// so a missing active project excludes project-scoped facts.
    pub include_all_projects: bool,
    pub node_bound: bool,
    pub caller_user_id: Option<&'a str>,
    pub caller_org_id: Option<&'a str>,
    pub include_sensitive: bool,
}

/// A memory fact selected by graph traversal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryGraphHit {
    pub memory_id: String,
    pub score: f32,
    pub hop: usize,
}

#[derive(Debug, Clone)]
struct Facet {
    kind: MemoryGraphNodeKind,
    label: String,
    normalized: String,
    scope: Option<String>,
    scope_id: Option<String>,
    agent_id: Option<String>,
    sensitive: bool,
}

/// A short-lived typed GraphRAG index over memory documents.
#[derive(Debug, Clone, Default)]
pub struct MemoryGraph {
    documents: Vec<MemoryGraphDocument>,
    nodes: Vec<MemoryGraphNode>,
    edges: Vec<MemoryGraphEdge>,
    attributes_by_memory: HashMap<String, Vec<String>>,
    memories_by_attribute: HashMap<String, Vec<String>>,
}

impl MemoryGraph {
    /// Build a deterministic graph projection from source facts.
    pub fn from_documents(documents: impl IntoIterator<Item = MemoryGraphDocument>) -> Self {
        let mut graph = Self {
            documents: documents.into_iter().collect(),
            ..Self::default()
        };
        graph
            .documents
            .sort_by(|a, b| a.memory_id.cmp(&b.memory_id));

        let mut node_ids = HashSet::new();
        for document in &graph.documents {
            let memory_node_id = format!("memory:{}", document.memory_id);
            graph.nodes.push(MemoryGraphNode {
                id: memory_node_id.clone(),
                kind: MemoryGraphNodeKind::Memory,
                label: truncate_label(&document.content),
                normalized: normalize(&document.content),
                memory_id: Some(document.memory_id.clone()),
                scope: Some(document.scope.clone()),
                scope_id: document.scope_id.clone(),
                agent_id: document.agent_id.clone(),
                sensitive: !document.sensitive_topics.is_empty(),
            });

            let facets = facets_for(document);
            let attribute_ids = graph
                .attributes_by_memory
                .entry(document.memory_id.clone())
                .or_default();
            for facet in facets {
                let attribute_id =
                    attribute_id(facet.kind, &facet.normalized, facet.scope_id.as_deref());
                if node_ids.insert(attribute_id.clone()) {
                    graph.nodes.push(MemoryGraphNode {
                        id: attribute_id.clone(),
                        kind: facet.kind,
                        label: facet.label.clone(),
                        normalized: facet.normalized.clone(),
                        memory_id: None,
                        scope: facet.scope,
                        scope_id: facet.scope_id,
                        agent_id: facet.agent_id,
                        sensitive: facet.sensitive,
                    });
                } else if facet.sensitive {
                    if let Some(node) = graph.nodes.iter_mut().find(|node| node.id == attribute_id)
                    {
                        node.sensitive = true;
                    }
                }
                attribute_ids.push(attribute_id.clone());
                graph
                    .memories_by_attribute
                    .entry(attribute_id.clone())
                    .or_default()
                    .push(document.memory_id.clone());
                graph.edges.push(MemoryGraphEdge {
                    source: memory_node_id.clone(),
                    target: attribute_id,
                    kind: edge_kind(facet.kind).to_owned(),
                    memory_id: document.memory_id.clone(),
                    weight: 1.0,
                });
            }
        }

        for memories in graph.memories_by_attribute.values_mut() {
            memories.sort();
            memories.dedup();
        }
        graph
    }

    /// Return bounded graph-assisted memory candidates. Direct facet matches
    /// rank first; shared facets then contribute at most two graph hops.
    pub fn search(
        &self,
        query: &str,
        filter: &MemoryGraphQuery<'_>,
        limit: usize,
    ) -> Vec<MemoryGraphHit> {
        if query.trim().is_empty() || limit == 0 {
            return Vec::new();
        }
        let query_terms = tokenize(query, MAX_QUERY_TERMS);
        if query_terms.is_empty() {
            return Vec::new();
        }
        let visible = self.visible_memory_ids(filter);
        if visible.is_empty() {
            return Vec::new();
        }

        let mut direct_scores: HashMap<String, f32> = HashMap::new();
        for node in &self.nodes {
            if !node.kind.is_facet() || !node_matches_query(node, &query_terms) {
                continue;
            }
            let Some(memory_ids) = self.memories_by_attribute.get(&node.id) else {
                continue;
            };
            for memory_id in memory_ids {
                if !visible.contains(memory_id) {
                    continue;
                }
                *direct_scores.entry(memory_id.clone()).or_default() += 1.0;
            }
        }

        if direct_scores.is_empty() {
            return Vec::new();
        }

        let mut scores: HashMap<String, (f32, usize)> = HashMap::new();
        let mut frontier: Vec<String> = direct_scores.keys().cloned().collect();
        frontier.sort();
        for memory_id in &frontier {
            let score = direct_scores.get(memory_id).copied().unwrap_or_default();
            let importance = self
                .document(memory_id)
                .map(|document| document.importance.clamp(1, 5) as f32 * 0.01)
                .unwrap_or_default();
            scores.insert(memory_id.clone(), (score + importance, 0));
        }

        for hop in 1..=MAX_GRAPH_HOPS {
            let mut next = Vec::new();
            for memory_id in &frontier {
                let Some(attributes) = self.attributes_by_memory.get(memory_id) else {
                    continue;
                };
                for attribute in attributes {
                    let Some(neighbours) = self.memories_by_attribute.get(attribute) else {
                        continue;
                    };
                    for neighbour in neighbours {
                        if !visible.contains(neighbour) || scores.contains_key(neighbour) {
                            continue;
                        }
                        scores.insert(neighbour.clone(), (0.6 / hop as f32, hop));
                        next.push(neighbour.clone());
                    }
                }
            }
            next.sort();
            next.dedup();
            frontier = next;
            if frontier.is_empty() {
                break;
            }
        }

        let mut hits: Vec<MemoryGraphHit> = scores
            .into_iter()
            .map(|(memory_id, (score, hop))| MemoryGraphHit {
                memory_id,
                score,
                hop,
            })
            .collect();
        hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.hop.cmp(&b.hop))
                .then_with(|| a.memory_id.cmp(&b.memory_id))
        });
        hits.truncate(limit);
        hits
    }

    /// Project the access-filtered graph for a bounded UI snapshot.
    pub fn snapshot(
        &self,
        filter: &MemoryGraphQuery<'_>,
        max_nodes: usize,
        max_edges: usize,
    ) -> MemoryGraphSnapshot {
        let visible = self.visible_memory_ids(filter);
        let mut edges: Vec<MemoryGraphEdge> = self
            .edges
            .iter()
            .filter(|edge| visible.contains(&edge.memory_id))
            .cloned()
            .collect();
        edges.sort_by(|a, b| {
            a.source
                .cmp(&b.source)
                .then_with(|| a.target.cmp(&b.target))
                .then_with(|| a.kind.cmp(&b.kind))
                .then_with(|| a.memory_id.cmp(&b.memory_id))
        });

        let mut node_ids: HashSet<String> = edges
            .iter()
            .flat_map(|edge| [edge.source.clone(), edge.target.clone()])
            .collect();
        let mut nodes: Vec<MemoryGraphNode> = self
            .nodes
            .iter()
            .filter(|node| node_ids.contains(&node.id))
            .cloned()
            .collect();
        nodes.sort_by(|a, b| {
            a.kind
                .cmp(&b.kind)
                .then_with(|| a.label.cmp(&b.label))
                .then_with(|| a.id.cmp(&b.id))
        });

        let truncated_before_caps = nodes.len() > max_nodes || edges.len() > max_edges;
        nodes.truncate(max_nodes);
        node_ids = nodes.iter().map(|node| node.id.clone()).collect();
        edges.retain(|edge| node_ids.contains(&edge.source) && node_ids.contains(&edge.target));
        edges.truncate(max_edges);

        MemoryGraphSnapshot {
            nodes,
            edges,
            memory_count: visible.len(),
            truncated: truncated_before_caps,
        }
    }

    /// Look up a source document by its stable memory id.
    pub fn document(&self, memory_id: &str) -> Option<&MemoryGraphDocument> {
        self.documents
            .binary_search_by(|document| document.memory_id.as_str().cmp(memory_id))
            .ok()
            .and_then(|index| self.documents.get(index))
    }

    fn visible_memory_ids(&self, filter: &MemoryGraphQuery<'_>) -> HashSet<String> {
        self.documents
            .iter()
            .filter(|document| document_matches(document, filter))
            .map(|document| document.memory_id.clone())
            .collect()
    }
}

fn facets_for(document: &MemoryGraphDocument) -> Vec<Facet> {
    let mut facets = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |facet: Facet| {
        let key = format!("{}:{}", facet.kind.as_str(), facet.normalized);
        if seen.insert(key) {
            facets.push(facet);
        }
    };

    let category = normalize(&document.category);
    add(Facet {
        kind: MemoryGraphNodeKind::Category,
        label: category_label(&document.category),
        normalized: category,
        scope: None,
        scope_id: None,
        agent_id: None,
        sensitive: false,
    });

    let scope = normalize(&document.scope);
    add(Facet {
        kind: MemoryGraphNodeKind::Scope,
        label: scope_label(&document.scope),
        normalized: scope,
        scope: Some(document.scope.clone()),
        scope_id: document.scope_id.clone(),
        agent_id: None,
        sensitive: false,
    });

    if let Some(agent_id) = document.agent_id.as_deref().filter(|id| !id.is_empty()) {
        let normalized = normalize(agent_id);
        add(Facet {
            kind: MemoryGraphNodeKind::Agent,
            label: format!("Agent · {agent_id}"),
            normalized,
            scope: None,
            scope_id: None,
            agent_id: Some(agent_id.to_owned()),
            sensitive: false,
        });
    }

    for sensitive_topic in &document.sensitive_topics {
        let normalized = normalize(sensitive_topic);
        if !normalized.is_empty() {
            add(Facet {
                kind: MemoryGraphNodeKind::Topic,
                label: sensitive_topic_label(sensitive_topic),
                normalized,
                scope: None,
                scope_id: None,
                agent_id: None,
                sensitive: true,
            });
        }
    }

    let mut term_count = 0;
    for token in document.content.split_whitespace() {
        let raw = token.trim_matches(|character: char| !character.is_alphanumeric());
        if raw.is_empty() {
            continue;
        }
        let normalized = normalize(raw);
        if normalized.len() < 3 || STOP_WORDS.contains(&normalized.as_str()) {
            continue;
        }
        let character_count = normalized.chars().count();
        if character_count < 4 || term_count >= MAX_TERMS_PER_MEMORY {
            continue;
        }
        let first_upper = raw.chars().next().is_some_and(char::is_uppercase);
        let person_like = first_upper && !NON_PERSON_WORDS.contains(&normalized.as_str());
        if person_like {
            add(Facet {
                kind: MemoryGraphNodeKind::Person,
                label: raw.to_owned(),
                normalized: normalized.clone(),
                scope: None,
                scope_id: None,
                agent_id: None,
                sensitive: false,
            });
        }
        add(Facet {
            kind: MemoryGraphNodeKind::Topic,
            label: raw.to_owned(),
            normalized,
            scope: None,
            scope_id: None,
            agent_id: None,
            sensitive: false,
        });
        term_count += 1;
    }

    for tag in &document.tags {
        let normalized = normalize(tag);
        if normalized.len() >= 3 && !STOP_WORDS.contains(&normalized.as_str()) {
            add(Facet {
                kind: MemoryGraphNodeKind::Topic,
                label: format!("#{tag}"),
                normalized,
                scope: None,
                scope_id: None,
                agent_id: None,
                sensitive: false,
            });
        }
    }

    facets
}

fn document_matches(document: &MemoryGraphDocument, filter: &MemoryGraphQuery<'_>) -> bool {
    if !filter.include_sensitive && !document.sensitive_topics.is_empty() {
        return false;
    }
    let scope = document.scope.as_str();
    let allowed = filter
        .allowed_scopes
        .map(|scopes| scopes.iter().any(|candidate| candidate == scope))
        .unwrap_or_else(|| DEFAULT_MEMORY_SCOPES.contains(&scope));
    if !allowed {
        return false;
    }
    if scope == "agent" {
        match (document.scope_id.as_deref(), filter.agent_id) {
            (Some(memory_agent), Some(active_agent)) if memory_agent == active_agent => {}
            (Some(_), None) if filter.include_all_agents => {}
            _ => return false,
        }
    }
    if scope == "project" {
        match (document.scope_id.as_deref(), filter.project_id) {
            (Some(memory_project), Some(active_project)) if memory_project == active_project => {}
            (Some(_), None) if filter.include_all_projects => {}
            _ => return false,
        }
    }
    if !filter.node_bound {
        return true;
    }
    match scope {
        "node" | "project" => true,
        "org" => matches!(
            (document.scope_id.as_deref(), filter.caller_org_id),
            (Some(memory_org), Some(caller_org)) if memory_org == caller_org
        ),
        "agent" | "user" => matches!(
            (document.owner_user_id.as_deref(), filter.caller_user_id),
            (Some(owner), Some(caller)) if owner == caller
        ),
        _ => false,
    }
}

fn node_matches_query(node: &MemoryGraphNode, query_terms: &[String]) -> bool {
    let normalized_label = normalize(&node.label);
    query_terms.iter().any(|term| {
        node.normalized == *term
            || normalized_label == *term
            || node.normalized.contains(term)
            || normalized_label.contains(term)
    })
}

fn edge_kind(kind: MemoryGraphNodeKind) -> &'static str {
    match kind {
        MemoryGraphNodeKind::Memory => "memory",
        MemoryGraphNodeKind::Topic => "has_topic",
        MemoryGraphNodeKind::Person => "mentions_person",
        MemoryGraphNodeKind::Category => "has_category",
        MemoryGraphNodeKind::Scope => "applies_to_scope",
        MemoryGraphNodeKind::Agent => "authored_by_agent",
    }
}

fn attribute_id(kind: MemoryGraphNodeKind, normalized: &str, scope_id: Option<&str>) -> String {
    let key = format!(
        "{}:{}:{}",
        kind.as_str(),
        normalized,
        scope_id.unwrap_or_default()
    );
    format!("{}:{:016x}", kind.as_str(), fnv1a(&key))
}

fn category_label(value: &str) -> String {
    if value == "relationship" {
        return "People · relationship".to_owned();
    }
    title_case(value.replace('_', " ").as_str())
}

fn scope_label(value: &str) -> String {
    format!("{} scope", title_case(value))
}

fn sensitive_topic_label(value: &str) -> String {
    match value {
        "health_condition" => "Health conditions".to_owned(),
        "religious_belief" => "Religious beliefs".to_owned(),
        "political_belief" => "Political beliefs".to_owned(),
        "sexual_orientation" => "Sexual orientation".to_owned(),
        "financial" => "Financial information".to_owned(),
        "legal" => "Legal information".to_owned(),
        "biometric" => "Biometric information".to_owned(),
        _ => title_case(value.replace('_', " ").as_str()),
    }
}

fn title_case(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| {
            let mut characters = word.chars();
            match characters.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), characters.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate_label(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut label: String = normalized.chars().take(96).collect();
    if normalized.chars().count() > 96 {
        label.push('…');
    }
    label
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn tokenize(value: &str, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for raw in value.split(|character: char| !character.is_alphanumeric()) {
        let normalized = normalize(raw);
        if normalized.len() < 3 || STOP_WORDS.contains(&normalized.as_str()) {
            continue;
        }
        if seen.insert(normalized.clone()) {
            output.push(normalized);
            if output.len() >= limit {
                break;
            }
        }
    }
    output
}

fn fnv1a(value: &str) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(
        id: &str,
        content: &str,
        scope: &str,
        scope_id: Option<&str>,
    ) -> MemoryGraphDocument {
        MemoryGraphDocument {
            memory_id: id.to_owned(),
            content: content.to_owned(),
            scope: scope.to_owned(),
            scope_id: scope_id.map(str::to_owned),
            category: "relationship".to_owned(),
            agent_id: Some("agent-a".to_owned()),
            owner_user_id: Some("alice".to_owned()),
            owner_org_id: Some("acme".to_owned()),
            importance: 3,
            tags: vec!["planning".to_owned()],
            sensitive_topics: Vec::new(),
        }
    }

    fn query<'a>(
        allowed_scopes: Option<&'a [String]>,
        agent_id: Option<&'a str>,
    ) -> MemoryGraphQuery<'a> {
        MemoryGraphQuery {
            agent_id,
            include_all_agents: false,
            allowed_scopes,
            project_id: None,
            include_all_projects: false,
            node_bound: true,
            caller_user_id: Some("alice"),
            caller_org_id: Some("acme"),
            include_sensitive: false,
        }
    }

    #[test]
    fn graph_keeps_people_topics_categories_scopes_and_agents_distinct() {
        let graph = MemoryGraph::from_documents([document(
            "m1",
            "Maya reviews the launch plan",
            "agent",
            Some("agent-a"),
        )]);
        let kinds: HashSet<_> = graph.nodes.iter().map(|node| node.kind).collect();
        assert!(kinds.contains(&MemoryGraphNodeKind::Memory));
        assert!(kinds.contains(&MemoryGraphNodeKind::Person));
        assert!(kinds.contains(&MemoryGraphNodeKind::Topic));
        assert!(kinds.contains(&MemoryGraphNodeKind::Category));
        assert!(kinds.contains(&MemoryGraphNodeKind::Scope));
        assert!(kinds.contains(&MemoryGraphNodeKind::Agent));
    }

    #[test]
    fn graph_search_expands_through_a_shared_topic() {
        let first = document("m1", "Maya owns the launch plan", "user", None);
        let second = document("m2", "The launch plan needs a review", "user", None);
        let graph = MemoryGraph::from_documents([first, second]);
        let hits = graph.search("Maya", &query(None, Some("agent-a")), 10);
        assert_eq!(hits.first().map(|hit| hit.memory_id.as_str()), Some("m1"));
        assert!(hits.iter().any(|hit| hit.memory_id == "m2" && hit.hop == 1));
    }

    #[test]
    fn graph_does_not_promote_common_scope_words_to_people() {
        let graph = MemoryGraph::from_documents([document(
            "m1",
            "Project Apollo uses graph retrieval on this node",
            "project",
            Some("apollo"),
        )]);
        let people: Vec<_> = graph
            .nodes
            .iter()
            .filter(|node| node.kind == MemoryGraphNodeKind::Person)
            .map(|node| node.label.as_str())
            .collect();
        assert!(people.is_empty(), "unexpected people: {people:?}");
    }

    #[test]
    fn graph_keeps_org_scope_for_the_matching_organization() {
        let graph = MemoryGraph::from_documents([document(
            "m-org",
            "Acme organization release policy",
            "org",
            Some("acme"),
        )]);
        let scopes = vec!["org".to_owned()];
        let matching = query(Some(&scopes), Some("agent-a"));
        assert_eq!(graph.search("release", &matching, 10)[0].memory_id, "m-org");

        let mut wrong_org = matching;
        wrong_org.caller_org_id = Some("other");
        assert!(graph.search("release", &wrong_org, 10).is_empty());
    }

    #[test]
    fn graph_scope_and_sensitive_filters_fail_closed() {
        let mut sensitive = document("m-sensitive", "Health condition review", "user", None);
        sensitive.sensitive_topics = vec!["health_condition".to_owned()];
        let agent_fact = document(
            "m-agent",
            "Agent-only launch plan",
            "agent",
            Some("agent-b"),
        );
        let graph = MemoryGraph::from_documents([sensitive, agent_fact]);
        assert!(graph
            .search("health", &query(None, Some("agent-a")), 10)
            .is_empty());
        assert!(graph
            .search("launch", &query(None, Some("agent-a")), 10)
            .is_empty());
    }

    #[test]
    fn snapshot_is_deterministic_and_bounded() {
        let graph = MemoryGraph::from_documents([document(
            "m1",
            "Maya reviews the launch plan",
            "user",
            None,
        )]);
        let first = graph.snapshot(&query(None, Some("agent-a")), 3, 2);
        let second = graph.snapshot(&query(None, Some("agent-a")), 3, 2);
        assert_eq!(first, second);
        assert!(first.nodes.len() <= 3);
        assert!(first.edges.len() <= 2);
        assert!(first.truncated);
    }
}

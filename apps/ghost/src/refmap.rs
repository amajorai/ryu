// Snapshot + element-ref store.
//
// Ported in spirit from lahfir/agent-desktop's snapshot/ref system: a `ghost_snapshot`
// captures the focused accessibility tree once, assigns stable `@eN` references to its
// interactive/named nodes in depth-first order, and persists the whole walked tree to
// `~/.ghost/snapshots/`. Subsequent action tools (`ghost_click`/`ghost_type`) then act on
// `@eN` instead of re-describing the element, which cuts token usage on dense apps and
// makes targeting deterministic. Refs survive across process boundaries (Core spawns
// ghost one-shot, so an in-memory map would vanish between `snapshot` and `click`).
//
// Re-identification is optimistic: when an action resolves a ref, ghost re-captures the
// focused tree and finds the node matching (role, name), preferring an exact `Bounds`
// match. If the focused app's pid no longer matches the snapshot, or no candidate is
// found, the action fails with a `STALE_REF` error telling the agent to re-snapshot.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use ghost_eyes::{AXTreeNode, Bounds};

/// How many snapshots to retain on disk.
const MAX_SNAPSHOTS: usize = 10;

/// Monotonic per-process counter so two snapshots in the same millisecond get distinct ids.
static SNAPSHOT_SEQ: AtomicU64 = AtomicU64::new(0);

/// A node in a captured skeleton tree. Mirrors `AXTreeNode` but carries an optional
/// `@eN` ref and keeps every walked child (the skeleton *view* prunes by depth at
/// render time; the stored tree is whole so drill-down can re-render deeper).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkeletonNode {
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub ref_id: Option<String>,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
    pub children: Vec<SkeletonNode>,
}

/// A persisted snapshot: the captured tree plus the app/pid it was taken from.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    pub pid: i32,
    pub created_ms: i64,
    pub tree: SkeletonNode,
}

impl Snapshot {
    /// Build a snapshot from a freshly captured AX tree, assigning `@eN` refs DFS.
    pub fn build(root: &AXTreeNode, app: Option<String>, pid: i32, now_ms: i64) -> Self {
        let seq = SNAPSHOT_SEQ.fetch_add(1, Ordering::Relaxed);
        let id = format!("s{now_ms}-{seq}");
        let mut counter: u32 = 0;
        let tree = build_node(root, &mut counter);
        Self { id, app, pid, created_ms: now_ms, tree }
    }

    /// The total number of refs assigned in this snapshot.
    pub fn ref_count(&self) -> usize {
        count_refs(&self.tree)
    }

    /// Find a node by its `@eN` ref.
    pub fn find_ref(&self, ref_id: &str) -> Option<&SkeletonNode> {
        find_ref_in(&self.tree, ref_id)
    }
}

/// A node deserves a ref if it is directly actionable, or if it is a named container
/// with children (a useful `--root` drill-down target).
fn deserves_ref(node: &AXTreeNode) -> bool {
    if is_actionable(node) {
        return true;
    }
    node.title.as_deref().is_some_and(|t| !t.is_empty()) && !node.children.is_empty()
}

fn is_actionable(node: &AXTreeNode) -> bool {
    let r = node.role.to_lowercase();
    r.contains("button")
        || r.contains("link")
        || r.contains("textfield")
        || r.contains("text field")
        || r.contains("checkbox")
        || r.contains("combo")
        || r.contains("slider")
        || r.contains("tab")
        || r.contains("menu")
        || r.contains("cell")
        || r.contains("row")
        || r.contains("edit")
}

fn build_node(node: &AXTreeNode, counter: &mut u32) -> SkeletonNode {
    // Pre-order: a parent gets its ref before its children, so refs read in DFS order.
    let ref_id = if deserves_ref(node) {
        *counter += 1;
        Some(format!("@e{counter}"))
    } else {
        None
    };
    let children = node.children.iter().map(|c| build_node(c, counter)).collect();
    SkeletonNode {
        ref_id,
        role: node.role.clone(),
        name: node.title.clone(),
        value: node.value.clone(),
        identifier: node.identifier.clone(),
        bounds: node.bounds.clone(),
        children,
    }
}

fn count_refs(node: &SkeletonNode) -> usize {
    let mut n = usize::from(node.ref_id.is_some());
    for c in &node.children {
        n += count_refs(c);
    }
    n
}

fn find_ref_in<'a>(node: &'a SkeletonNode, ref_id: &str) -> Option<&'a SkeletonNode> {
    if node.ref_id.as_deref() == Some(ref_id) {
        return Some(node);
    }
    for c in &node.children {
        if let Some(found) = find_ref_in(c, ref_id) {
            return Some(found);
        }
    }
    None
}

/// Render a skeleton node to compact JSON, pruning at `max_depth` but always reporting
/// `children_count` so the agent knows where it can drill down with `root`.
pub fn render(node: &SkeletonNode, max_depth: u32) -> Value {
    render_inner(node, 0, max_depth)
}

fn render_inner(node: &SkeletonNode, depth: u32, max_depth: u32) -> Value {
    let mut obj = serde_json::Map::new();
    if let Some(r) = &node.ref_id {
        obj.insert("ref".into(), json!(r));
    }
    obj.insert("role".into(), json!(node.role));
    if let Some(n) = &node.name {
        obj.insert("name".into(), json!(n));
    }
    if let Some(v) = &node.value {
        obj.insert("value".into(), json!(v));
    }
    if let Some(b) = &node.bounds {
        obj.insert("bounds".into(), json!({ "x": b.x, "y": b.y, "w": b.width, "h": b.height }));
    }
    if !node.children.is_empty() {
        obj.insert("children_count".into(), json!(node.children.len()));
        if depth < max_depth {
            let kids: Vec<Value> =
                node.children.iter().map(|c| render_inner(c, depth + 1, max_depth)).collect();
            obj.insert("children".into(), json!(kids));
        }
    }
    Value::Object(obj)
}

/// Outcome of resolving a ref against the currently focused tree.
pub enum Resolved {
    /// The element was re-identified; click at this screen-space center.
    At { x: i32, y: i32 },
    /// The element could not be re-identified — the agent should re-snapshot.
    Stale(String),
}

/// Re-identify a stored ref entry in a freshly captured tree, returning its current
/// center. `entry` is the `SkeletonNode` the ref pointed at in the snapshot.
pub fn reidentify(current_root: &AXTreeNode, entry: &SkeletonNode) -> Resolved {
    let role = entry.role.to_lowercase();
    let mut candidates: Vec<&AXTreeNode> = vec![];
    collect_matches(current_root, &role, &entry.name, &mut candidates);

    if candidates.is_empty() {
        return Resolved::Stale(format!(
            "STALE_REF: {} ({}{}) is no longer present in the focused window; re-run ghost_snapshot",
            entry.ref_id.as_deref().unwrap_or("element"),
            entry.role,
            entry.name.as_deref().map(|n| format!(" '{n}'")).unwrap_or_default(),
        ));
    }

    // Prefer the candidate whose bounds are unchanged; otherwise take the first match.
    let chosen = candidates
        .iter()
        .find(|c| c.bounds.is_some() && c.bounds == entry.bounds)
        .copied()
        .unwrap_or(candidates[0]);

    match &chosen.bounds {
        Some(b) => Resolved::At {
            x: b.x + b.width as i32 / 2,
            y: b.y + b.height as i32 / 2,
        },
        None => Resolved::Stale(format!(
            "STALE_REF: {} matched but has no bounds to click; re-run ghost_snapshot",
            entry.ref_id.as_deref().unwrap_or("element"),
        )),
    }
}

fn collect_matches<'a>(
    node: &'a AXTreeNode,
    role: &str,
    name: &Option<String>,
    out: &mut Vec<&'a AXTreeNode>,
) {
    let role_ok = node.role.to_lowercase() == role;
    let name_ok = match name {
        Some(n) => node.title.as_deref() == Some(n.as_str()),
        None => node.title.is_none(),
    };
    if role_ok && name_ok {
        out.push(node);
    }
    for c in &node.children {
        collect_matches(c, role, name, out);
    }
}

// ─── Disk store ────────────────────────────────────────────────────────────────

/// Persistent snapshot store backed by JSON files in `~/.ghost/snapshots/`.
pub struct SnapshotStore {
    dir: PathBuf,
}

impl SnapshotStore {
    pub fn open() -> Result<Self> {
        let dir = dirs::home_dir()
            .ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?
            .join(".ghost")
            .join("snapshots");
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("Failed to create snapshot dir: {}", dir.display()))?;
        Ok(Self { dir })
    }

    #[cfg(test)]
    pub fn open_at(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    /// Persist a snapshot, update the `latest` pointer, and prune old ones.
    pub fn save(&self, snapshot: &Snapshot) -> Result<()> {
        let path = self.dir.join(format!("{}.json", snapshot.id));
        std::fs::write(&path, serde_json::to_string(snapshot)?)
            .with_context(|| format!("Failed to write snapshot {}", path.display()))?;
        std::fs::write(self.dir.join("latest"), &snapshot.id)?;
        self.prune();
        Ok(())
    }

    /// Load a snapshot by id.
    pub fn load(&self, id: &str) -> Result<Snapshot> {
        let path = self.dir.join(format!("{id}.json"));
        let data = std::fs::read_to_string(&path)
            .with_context(|| format!("Snapshot '{id}' not found"))?;
        serde_json::from_str(&data).with_context(|| format!("Invalid snapshot JSON in {id}"))
    }

    /// Load the most recently saved snapshot.
    pub fn load_latest(&self) -> Result<Snapshot> {
        let id = std::fs::read_to_string(self.dir.join("latest"))
            .context("No snapshot yet — run ghost_snapshot first")?;
        self.load(id.trim())
    }

    fn prune(&self) {
        let mut ids: Vec<PathBuf> = match std::fs::read_dir(&self.dir) {
            Ok(rd) => rd
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
                .collect(),
            Err(_) => return,
        };
        if ids.len() <= MAX_SNAPSHOTS {
            return;
        }
        // Filenames are `s<millis>-<seq>.json`, so lexicographic sort is chronological.
        ids.sort();
        let remove = ids.len() - MAX_SNAPSHOTS;
        for p in ids.into_iter().take(remove) {
            let _ = std::fs::remove_file(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ghost_eyes::{AXTreeNode, Bounds};
    use serde_json::json;

    fn node(role: &str, title: Option<&str>, bounds: Option<Bounds>, children: Vec<AXTreeNode>) -> AXTreeNode {
        AXTreeNode {
            role: role.into(),
            title: title.map(|s| s.into()),
            value: None,
            identifier: None,
            bounds,
            children,
            enabled: true,
            focused: false,
            hidden: false,
        }
    }

    fn bounds(x: i32, y: i32, w: u32, h: u32) -> Bounds {
        Bounds { x, y, width: w, height: h }
    }

    fn sample() -> AXTreeNode {
        node(
            "window",
            Some("Main"),
            Some(bounds(0, 0, 800, 600)),
            vec![
                node("group", None, None, vec![
                    node("button", Some("Send"), Some(bounds(10, 20, 80, 30)), vec![]),
                    node("button", Some("Cancel"), Some(bounds(100, 20, 80, 30)), vec![]),
                ]),
                node("textfield", Some("Search"), Some(bounds(10, 100, 200, 24)), vec![]),
            ],
        )
    }

    #[test]
    fn refs_assigned_in_dfs_preorder() {
        let snap = Snapshot::build(&sample(), Some("App".into()), 42, 1000);
        // window(named+children)=@e1, button Send=@e2, button Cancel=@e3, textfield=@e4.
        // The unnamed "group" gets no ref.
        assert_eq!(snap.tree.ref_id.as_deref(), Some("@e1"));
        assert_eq!(snap.ref_count(), 4);
        let send = snap.find_ref("@e2").expect("@e2");
        assert_eq!(send.name.as_deref(), Some("Send"));
        let field = snap.find_ref("@e4").expect("@e4");
        assert_eq!(field.role, "textfield");
    }

    #[test]
    fn render_prunes_depth_but_reports_children_count() {
        let snap = Snapshot::build(&sample(), None, 1, 1000);
        let shallow = render(&snap.tree, 0);
        assert_eq!(shallow["children_count"], json!(2));
        assert!(shallow.get("children").is_none(), "depth 0 must not emit children");
        let deep = render(&snap.tree, 3);
        assert!(deep["children"].is_array());
    }

    #[test]
    fn reidentify_prefers_exact_bounds_then_falls_back() {
        let snap = Snapshot::build(&sample(), None, 1, 1000);
        let send = snap.find_ref("@e2").unwrap();

        // Unchanged tree → exact bounds match → center of (10,20,80,30) = (50,35).
        match reidentify(&sample(), send) {
            Resolved::At { x, y } => {
                assert_eq!((x, y), (50, 35));
            }
            Resolved::Stale(e) => panic!("unexpected stale: {e}"),
        }

        // Moved button (same role+name, different bounds) → still re-identified at new center.
        let moved = node(
            "window",
            Some("Main"),
            None,
            vec![node("button", Some("Send"), Some(bounds(200, 200, 80, 30)), vec![])],
        );
        match reidentify(&moved, send) {
            Resolved::At { x, y } => assert_eq!((x, y), (240, 215)),
            Resolved::Stale(e) => panic!("unexpected stale: {e}"),
        }
    }

    #[test]
    fn reidentify_stale_when_absent() {
        let snap = Snapshot::build(&sample(), None, 1, 1000);
        let send = snap.find_ref("@e2").unwrap();
        let other = node("window", Some("Other"), None, vec![node("button", Some("Quit"), Some(bounds(0, 0, 10, 10)), vec![])]);
        assert!(matches!(reidentify(&other, send), Resolved::Stale(_)));
    }

    #[test]
    fn store_round_trip_and_prune() {
        let tmp = std::env::temp_dir().join(format!("ghost-snap-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let store = SnapshotStore::open_at(tmp.clone()).unwrap();

        let mut last_id = String::new();
        for i in 0..(MAX_SNAPSHOTS + 5) {
            let snap = Snapshot::build(&sample(), None, 1, 1000 + i as i64);
            store.save(&snap).unwrap();
            last_id = snap.id;
        }
        // latest pointer resolves to the final save.
        let latest = store.load_latest().unwrap();
        assert_eq!(latest.id, last_id);

        // Pruned to the cap.
        let json_files = std::fs::read_dir(&tmp)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .count();
        assert_eq!(json_files, MAX_SNAPSHOTS);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}

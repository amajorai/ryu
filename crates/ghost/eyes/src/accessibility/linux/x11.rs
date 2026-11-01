//! X11 fallback: the active window's geometry plus up to two levels of child
//! windows (role `"window"`, at most 20 per level), as Shadow's capture did.
//!
//! Used only when the AT-SPI bus is unavailable. X11 windows are not
//! accessibility elements, so these nodes can be looked at but never acted on.

use anyhow::{anyhow, Result};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, Window};
use x11rb::rust_connection::RustConnection;

use super::super::limits::{TruncationCause, WalkStats};
use super::super::{AXTreeNode, Bounds};

/// Child-window levels below the active window.
const MAX_LEVELS: u32 = 2;
/// Child windows kept per level.
const MAX_CHILDREN: usize = 20;

/// The focused window's tree, its `_NET_WM_PID` (0 when unset) and walk stats.
pub(crate) struct X11Window {
    pub root: AXTreeNode,
    pub pid: i32,
    pub stats: WalkStats,
}

struct Atoms {
    net_wm_name: u32,
    utf8: u32,
    net_wm_pid: u32,
}

fn atom(conn: &RustConnection, name: &[u8]) -> Result<u32> {
    Ok(conn
        .intern_atom(false, name)
        .map_err(|e| anyhow!("{e}"))?
        .reply()
        .map_err(|e| anyhow!("{e}"))?
        .atom)
}

fn utf8_title(conn: &RustConnection, atoms: &Atoms, win: Window, len: u32) -> Option<String> {
    conn.get_property(false, win, atoms.net_wm_name, atoms.utf8, 0, len)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|p| String::from_utf8(p.value).ok())
        .filter(|s| !s.is_empty())
}

fn legacy_title(conn: &RustConnection, win: Window) -> Option<String> {
    conn.get_property(false, win, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 1024)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|p| String::from_utf8(p.value).ok())
        .filter(|s| !s.is_empty())
}

fn bounds_of(conn: &RustConnection, win: Window) -> Option<Bounds> {
    let geom = conn.get_geometry(win).ok()?.reply().ok()?;
    Some(Bounds {
        x: i32::from(geom.x),
        y: i32::from(geom.y),
        width: u32::from(geom.width),
        height: u32::from(geom.height),
    })
}

fn wm_pid(conn: &RustConnection, atoms: &Atoms, win: Window) -> i32 {
    conn.get_property(false, win, atoms.net_wm_pid, AtomEnum::CARDINAL, 0, 1)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|p| p.value32().and_then(|mut v| v.next()))
        .and_then(|pid| i32::try_from(pid).ok())
        .unwrap_or(0)
}

fn child_windows(conn: &RustConnection, parent: Window) -> Vec<Window> {
    // Stepwise: the cookie and the reply carry different error types.
    let Ok(cookie) = conn.query_tree(parent) else {
        return vec![];
    };
    cookie.reply().map(|t| t.children).unwrap_or_default()
}

fn children_of(
    conn: &RustConnection,
    atoms: &Atoms,
    parent: Window,
    level: u32,
    stats: &mut WalkStats,
) -> (Vec<AXTreeNode>, Option<TruncationCause>) {
    let kids = child_windows(conn, parent);
    if level > MAX_LEVELS {
        return (vec![], (!kids.is_empty()).then_some(TruncationCause::Depth));
    }
    let cut = (kids.len() > MAX_CHILDREN).then_some(TruncationCause::Siblings);
    let nodes = kids
        .iter()
        .take(MAX_CHILDREN)
        .map(|&win| {
            stats.nodes += 1;
            let (children, truncated) = children_of(conn, atoms, win, level + 1, stats);
            let mut node = AXTreeNode {
                role: "window".to_string(),
                title: utf8_title(conn, atoms, win, 256),
                identifier: Some(format!("0x{win:08x}")),
                bounds: bounds_of(conn, win),
                children,
                ..Default::default()
            };
            if let Some(cause) = truncated {
                stats.mark_truncated(&mut node, cause);
            }
            node.redact();
            node
        })
        .collect();
    (nodes, cut)
}

/// The `_NET_ACTIVE_WINDOW` (or the root window) with its child windows.
pub(crate) fn focused_window() -> Result<X11Window> {
    let (conn, screen_num) = RustConnection::connect(None).map_err(|e| anyhow!("{e}"))?;
    let root_win = conn.setup().roots[screen_num].root;
    let active = atom(&conn, b"_NET_ACTIVE_WINDOW")?;
    let atoms = Atoms {
        net_wm_name: atom(&conn, b"_NET_WM_NAME")?,
        utf8: atom(&conn, b"UTF8_STRING")?,
        net_wm_pid: atom(&conn, b"_NET_WM_PID")?,
    };
    let prop = conn
        .get_property(false, root_win, active, AtomEnum::WINDOW, 0, 1)
        .map_err(|e| anyhow!("{e}"))?
        .reply()
        .map_err(|e| anyhow!("{e}"))?;
    let win = prop
        .value32()
        .and_then(|mut i| i.next())
        .filter(|w| *w != 0)
        .unwrap_or(root_win);

    let mut stats = WalkStats {
        nodes: 1,
        ..WalkStats::default()
    };
    let (children, truncated) = children_of(&conn, &atoms, win, 1, &mut stats);
    let mut root = AXTreeNode {
        role: "frame".to_string(),
        title: utf8_title(&conn, &atoms, win, 1024).or_else(|| legacy_title(&conn, win)),
        identifier: Some(format!("0x{win:08x}")),
        bounds: bounds_of(&conn, win),
        children,
        ..Default::default()
    };
    if let Some(cause) = truncated {
        stats.mark_truncated(&mut root, cause);
    }
    root.redact();
    Ok(X11Window {
        pid: wm_pid(&conn, &atoms, win),
        root,
        stats,
    })
}

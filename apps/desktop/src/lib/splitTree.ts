/** Pure tree model for nested split views (Warp-style).
 *
 * A split's layout is a tree: branches alternate orientation (columns =
 * side-by-side, rows = stacked) and leaves are tabs. `sizes` holds one
 * fraction per child (summing to ~1) along the branch's main axis. All
 * functions are pure — they return new nodes and never mutate inputs — so the
 * TabsContext can use them inside state updaters and tests can cover them
 * directly.
 */

/** Orientation of a split branch: side-by-side columns or stacked rows. */
export type SplitOrientation = "columns" | "rows";

/** Where a dragged tab lands relative to a target pane. */
export type SplitDirection = "left" | "right" | "up" | "down";

export interface SplitLeaf {
	tabId: string;
	type: "leaf";
}

export interface SplitBranch {
	children: SplitNode[];
	orientation: SplitOrientation;
	/** One fraction per child along the main axis, summing to ~1. */
	sizes: number[];
	type: "branch";
}

export type SplitNode = SplitLeaf | SplitBranch;

/** The axis a drop direction splits along. */
export function directionOrientation(d: SplitDirection): SplitOrientation {
	return d === "left" || d === "right" ? "columns" : "rows";
}

/** Whether the dropped pane lands before (left/above) the target. */
export function directionBefore(d: SplitDirection): boolean {
	return d === "left" || d === "up";
}

/** Even fractions for `n` children. */
export function equalSizes(n: number): number[] {
	return Array.from({ length: n }, () => 1 / n);
}

export function makeLeaf(tabId: string): SplitLeaf {
	return { type: "leaf", tabId };
}

export function makeBranch(
	orientation: SplitOrientation,
	children: SplitNode[],
	sizes?: number[]
): SplitBranch {
	return {
		type: "branch",
		orientation,
		children,
		sizes:
			sizes && sizes.length === children.length
				? sizes
				: equalSizes(children.length),
	};
}

/** Tab ids of every leaf, in visual order (depth-first). This is the pane
    order the content area renders. */
export function leafOrder(node: SplitNode): string[] {
	if (node.type === "leaf") {
		return [node.tabId];
	}
	return node.children.flatMap(leafOrder);
}

export function containsLeaf(node: SplitNode, tabId: string): boolean {
	if (node.type === "leaf") {
		return node.tabId === tabId;
	}
	return node.children.some((c) => containsLeaf(c, tabId));
}

/** Rescale `sizes` to sum to 1, falling back to equal fractions when the
    input is degenerate (empty, zero-sum, or non-finite). */
function renormalizeSizes(sizes: number[]): number[] {
	const cleaned = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
	const sum = cleaned.reduce((a, b) => a + b, 0);
	if (sum <= 0) {
		return equalSizes(sizes.length);
	}
	return cleaned.map((s) => s / sum);
}

/** Structural cleanup: collapse single-child branches, flatten a child branch
    into its same-orientation parent (redistributing its fraction across the
    grandchildren), drop empty branches, and renormalize sizes. Returns null
    when nothing remains. Every mutator funnels its result through this so the
    tree never accumulates degenerate shapes. */
export function normalizeNode(node: SplitNode): SplitNode | null {
	if (node.type === "leaf") {
		return node;
	}
	const children: SplitNode[] = [];
	const sizes: number[] = [];
	node.children.forEach((child, i) => {
		const cleaned = normalizeNode(child);
		if (!cleaned) {
			return;
		}
		const frac = node.sizes[i] ?? 0;
		if (cleaned.type === "branch" && cleaned.orientation === node.orientation) {
			// Same-orientation nesting is visually identical to a flat run — flatten
			// it so gutters and size math stay simple.
			cleaned.children.forEach((gc, j) => {
				children.push(gc);
				sizes.push(frac * (cleaned.sizes[j] ?? 0));
			});
			return;
		}
		children.push(cleaned);
		sizes.push(frac);
	});
	if (children.length === 0) {
		return null;
	}
	if (children.length === 1) {
		return children[0];
	}
	return {
		type: "branch",
		orientation: node.orientation,
		children,
		sizes: renormalizeSizes(sizes),
	};
}

/** Drop every leaf whose tab id is not in `keep`, then normalize. */
export function pruneToMembers(
	node: SplitNode,
	keep: ReadonlySet<string>
): SplitNode | null {
	const strip = (n: SplitNode): SplitNode | null => {
		if (n.type === "leaf") {
			return keep.has(n.tabId) ? n : null;
		}
		const children: SplitNode[] = [];
		const sizes: number[] = [];
		n.children.forEach((c, i) => {
			const kept = strip(c);
			if (kept) {
				children.push(kept);
				sizes.push(n.sizes[i] ?? 0);
			}
		});
		if (children.length === 0) {
			return null;
		}
		return { ...n, children, sizes: renormalizeSizes(sizes) };
	};
	const stripped = strip(node);
	return stripped ? normalizeNode(stripped) : null;
}

/** Remove the leaf for `tabId`, then normalize. Returns null when the tree
    becomes empty. */
export function removeLeaf(node: SplitNode, tabId: string): SplitNode | null {
	const strip = (n: SplitNode): SplitNode | null => {
		if (n.type === "leaf") {
			return n.tabId === tabId ? null : n;
		}
		const children: SplitNode[] = [];
		const sizes: number[] = [];
		n.children.forEach((c, i) => {
			const kept = strip(c);
			if (kept) {
				children.push(kept);
				sizes.push(n.sizes[i] ?? 0);
			}
		});
		if (children.length === 0) {
			return null;
		}
		return { ...n, children, sizes: renormalizeSizes(sizes) };
	};
	const stripped = strip(node);
	return stripped ? normalizeNode(stripped) : null;
}

/** Insert a new leaf for `tabId` adjacent to `targetTabId` in `direction`.
    Warp semantics: when the target's parent branch already runs along the
    drop axis the new pane becomes a sibling (splitting the target's fraction
    in half); otherwise the target leaf is replaced by a perpendicular 50/50
    pair. Returns the node unchanged when the target isn't present. */
export function insertLeaf(
	node: SplitNode,
	targetTabId: string,
	tabId: string,
	direction: SplitDirection
): SplitNode {
	const axis = directionOrientation(direction);
	const before = directionBefore(direction);
	const pairFor = (target: SplitLeaf): SplitBranch =>
		makeBranch(
			axis,
			before ? [makeLeaf(tabId), target] : [target, makeLeaf(tabId)]
		);
	if (node.type === "leaf") {
		return node.tabId === targetTabId ? pairFor(node) : node;
	}
	const idx = node.children.findIndex(
		(c) => c.type === "leaf" && c.tabId === targetTabId
	);
	if (idx !== -1 && node.orientation === axis) {
		// Sibling insert: the new pane takes half the target's fraction.
		const children = [...node.children];
		const sizes = [...node.sizes];
		const half = (sizes[idx] ?? 1 / node.children.length) / 2;
		sizes[idx] = half;
		children.splice(before ? idx : idx + 1, 0, makeLeaf(tabId));
		sizes.splice(before ? idx : idx + 1, 0, half);
		return { ...node, children, sizes: renormalizeSizes(sizes) };
	}
	if (idx !== -1) {
		const children = [...node.children];
		children[idx] = pairFor(node.children[idx] as SplitLeaf);
		return { ...node, children };
	}
	return {
		...node,
		children: node.children.map((c) =>
			containsLeaf(c, targetTabId)
				? insertLeaf(c, targetTabId, tabId, direction)
				: c
		),
	};
}

/** Swap the positions of two leaves (their panes trade places + sizes). */
export function swapLeaves(node: SplitNode, a: string, b: string): SplitNode {
	if (node.type === "leaf") {
		if (node.tabId === a) {
			return makeLeaf(b);
		}
		if (node.tabId === b) {
			return makeLeaf(a);
		}
		return node;
	}
	return { ...node, children: node.children.map((c) => swapLeaves(c, a, b)) };
}

/** Replace the sizes of the branch at `path` (child indexes from the root).
    An empty path targets the root. Length mismatches are ignored. */
export function setSizesAt(
	node: SplitNode,
	path: readonly number[],
	sizes: number[]
): SplitNode {
	if (node.type === "leaf") {
		return node;
	}
	if (path.length === 0) {
		if (sizes.length !== node.children.length) {
			return node;
		}
		return { ...node, sizes: renormalizeSizes(sizes) };
	}
	const [head, ...rest] = path;
	const child = node.children[head];
	if (!child) {
		return node;
	}
	const children = [...node.children];
	children[head] = setSizesAt(child, rest, sizes);
	return { ...node, children };
}

/** Append leaves for `tabIds` as extra children of the root (equal share of
    space), used as a safety net when membership and the tree drift apart. */
export function appendLeaves(root: SplitBranch, tabIds: string[]): SplitBranch {
	if (tabIds.length === 0) {
		return root;
	}
	const children = [...root.children, ...tabIds.map(makeLeaf)];
	return makeBranch(root.orientation, children);
}

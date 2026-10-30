// packages/marketplace/src/catalog/detail/dependency-graph.tsx
//
// The "what else comes with this" half of the Dependencies tab: the manifest's
// `requires.apps` resolved into the tree Core actually walks.
//
// A manifest names ids and nothing else ("@ryu/spaces", ">=1.2.0"), which is what
// this tab used to render — a flat list of raw ids. That hid the two facts a
// reader needs before clicking Install: how deep the chain goes (Core installs the
// whole closure, `install_plugin_from_catalog` phase 1), and which of those are
// already here versus arriving alongside (Core auto-enables them topologically,
// `lifecycle::enable_app`). Neither is a new resolver — this is the same graph,
// shown before the click instead of after it.
//
// Live install/enable state crosses the HOST seam: a desktop store knows what its
// active node has, the read-only web catalog knows nothing about any node. Absent
// a lookup this degrades to the flat list it always rendered rather than asserting
// "installs with this" on a surface with no way to check.

import { Link01Icon, PackageIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { prettyPluginId } from "../plugin-id.ts";

/** One dependency edge exactly as a manifest declares it (snake_case on the wire;
 *  `min_version` is a MINIMUM, so `"1.2.0"` means `">=1.2.0"`). */
export interface DeclaredDependency {
	id: string;
	min_version?: string | null;
}

/** What the host knows about one plugin id on the node it is looking at. */
export interface DependencyRecord {
	enabled: boolean;
	installed: boolean;
	name: string;
	/** This record's OWN direct dependencies — the edges that make the tree deep.
	 *  Without them the panel could only ever show one level. */
	requires: { id: string; minVersion: string | null }[];
}

/** Resolve one plugin id against the host's live records; `null` = the host has
 *  never seen that id (a dependency the catalog will fetch at install time). */
export type DependencyLookup = (id: string) => DependencyRecord | null;

const DependencyLookupContext = createContext<DependencyLookup | null>(null);

/** Mount above the store surfaces so every detail view — catalog listing and
 *  installed app alike — resolves dependencies against the same node. */
export function DependencyLookupProvider({
	children,
	lookup,
}: {
	children: ReactNode;
	lookup: DependencyLookup;
}) {
	return (
		<DependencyLookupContext.Provider value={lookup}>
			{children}
		</DependencyLookupContext.Provider>
	);
}

/** The host's lookup, or `null` on a surface that provided none. Deliberately not
 *  a throwing hook (unlike `useCatalogHost`): "no node to ask" is a legitimate
 *  state that this panel renders honestly. */
export function useDependencyLookup(): DependencyLookup | null {
	return useContext(DependencyLookupContext);
}

/** One resolved node of the dependency tree. */
export interface DependencyNode {
	/** What this dependency needs in turn. Empty when it needs nothing, when the
	 *  host has no record for it, or when it was already expanded elsewhere. */
	children: DependencyNode[];
	id: string;
	minVersion: string | null;
	name: string;
	/** `null` when the host has no record (or provided no lookup at all). */
	record: DependencyRecord | null;
	/** True when this id already appeared earlier in the tree. Expanded once, then
	 *  referenced — a diamond is normal in this graph and re-expanding it would
	 *  render the same subtree several times and inflate every count. */
	repeated: boolean;
}

/** Depth stop. The graph is acyclic by Core's own resolution rules and `repeated`
 *  already breaks any loop; this is belt-and-braces against a malformed record
 *  reaching the renderer. */
const MAX_DEPTH = 8;

function walk(
	deps: readonly { id: string; minVersion: string | null }[],
	lookup: DependencyLookup | null,
	seen: Set<string>,
	depth: number
): DependencyNode[] {
	const nodes: DependencyNode[] = [];
	for (const dep of deps) {
		const record = lookup?.(dep.id) ?? null;
		const repeated = seen.has(dep.id);
		seen.add(dep.id);
		const children =
			repeated || record === null || depth >= MAX_DEPTH
				? []
				: walk(
						record.requires.map((child) => ({
							id: child.id,
							minVersion: child.minVersion,
						})),
						lookup,
						seen,
						depth + 1
					);
		nodes.push({
			children,
			id: dep.id,
			minVersion: dep.minVersion,
			name: record?.name ?? prettyPluginId(dep.id),
			record,
			repeated,
		});
	}
	return nodes;
}

/** Resolve declared dependencies into the tree, deduplicated across the whole
 *  tree. `subjectId` seeds the visited set so a plugin that (transitively) names
 *  itself is marked as a repeat instead of recursing forever. */
export function resolveDependencyTree(
	direct: readonly DeclaredDependency[],
	lookup: DependencyLookup | null,
	subjectId?: string | null
): DependencyNode[] {
	const seen = new Set<string>(subjectId ? [subjectId] : []);
	return walk(
		direct.map((dep) => ({ id: dep.id, minVersion: dep.min_version ?? null })),
		lookup,
		seen,
		0
	);
}

/** How the resolved tree splits by what enabling this listing would actually do. */
export interface DependencyTally {
	/** Already enabled — nothing happens to these. */
	alreadyEnabled: number;
	/** Installed but off; enabling this turns them on. */
	toEnable: number;
	/** Not on the node; installing this brings them along. */
	toInstall: number;
	/** Distinct plugins in the tree (repeats counted once). */
	total: number;
}

export function tallyDependencies(
	nodes: readonly DependencyNode[]
): DependencyTally {
	const tally: DependencyTally = {
		alreadyEnabled: 0,
		toEnable: 0,
		toInstall: 0,
		total: 0,
	};
	for (const node of nodes) {
		if (node.repeated) {
			continue;
		}
		tally.total += 1;
		if (node.record?.enabled) {
			tally.alreadyEnabled += 1;
		} else if (node.record?.installed) {
			tally.toEnable += 1;
		} else {
			// No record = the host has never seen this id, so the catalog fetches it
			// at install time — same outcome for the reader as a known-but-absent one.
			tally.toInstall += 1;
		}
		const nested = tallyDependencies(node.children);
		tally.total += nested.total;
		tally.alreadyEnabled += nested.alreadyEnabled;
		tally.toEnable += nested.toEnable;
		tally.toInstall += nested.toInstall;
	}
	return tally;
}

/** English plural without a formatting dependency ("1 app", "3 apps"). */
function plural(count: number, one: string, many: string): string {
	return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** The one-line consequence of pressing Enable, in plain terms. Says only what the
 *  host can actually know: with no lookup it states the auto-enable rule and stops
 *  short of counting anything. */
function summarize(
	subjectName: string,
	tally: DependencyTally,
	resolved: boolean
): string {
	if (!resolved) {
		return `Enabling ${subjectName} turns these on automatically, dependencies first.`;
	}
	if (tally.toInstall === 0 && tally.toEnable === 0) {
		return `Everything ${subjectName} needs is already added and enabled on this node.`;
	}
	// Noun phrases rather than clauses: a tally reads the same at one as at ten,
	// and nothing in it has to agree with a verb.
	const clauses: string[] = [];
	if (tally.toInstall > 0) {
		clauses.push(`${tally.toInstall} added alongside it`);
	}
	if (tally.toEnable > 0) {
		clauses.push(`${tally.toEnable} already added, switched on with it`);
	}
	if (tally.alreadyEnabled > 0) {
		clauses.push(`${tally.alreadyEnabled} already running`);
	}
	const head = `Enabling ${subjectName} also enables ${plural(tally.total, "plugin", "plugins")}, automatically and in dependency order.`;
	return clauses.length > 0 ? `${head} Of those, ${clauses.join("; ")}.` : head;
}

/** Per-row state pill. Nothing is rendered when there is no lookup — a surface
 *  that cannot see the node must not guess at install state. */
function DependencyStatus({
	node,
	resolved,
}: {
	node: DependencyNode;
	resolved: boolean;
}) {
	if (node.repeated) {
		return (
			<Badge className="shrink-0" variant="outline">
				Listed above
			</Badge>
		);
	}
	if (!resolved) {
		return null;
	}
	if (node.record?.enabled) {
		return (
			<Badge className="shrink-0" variant="secondary">
				Already enabled
			</Badge>
		);
	}
	if (node.record?.installed) {
		return (
			<Badge className="shrink-0" variant="outline">
				Enabled with this
			</Badge>
		);
	}
	return (
		<Badge className="shrink-0" variant="outline">
			Added with this
		</Badge>
	);
}

function DependencyRows({
	nodes,
	resolved,
}: {
	nodes: readonly DependencyNode[];
	resolved: boolean;
}) {
	return (
		<ul className="flex flex-col gap-1.5">
			{nodes.map((node) => (
				<li key={node.id}>
					<div className="flex items-center gap-2.5 rounded-lg bg-muted px-3 py-2">
						<HugeiconsIcon
							className="size-4 shrink-0 text-muted-foreground"
							icon={PackageIcon}
						/>
						<span className="min-w-0 flex-1 truncate text-sm" title={node.name}>
							{node.name}
						</span>
						{node.minVersion ? (
							<span className="shrink-0 text-muted-foreground text-xs">
								≥ {node.minVersion}
							</span>
						) : null}
						<code className="hidden shrink-0 truncate font-mono text-muted-foreground text-xs sm:block">
							{node.id}
						</code>
						<DependencyStatus node={node} resolved={resolved} />
					</div>
					{node.children.length > 0 ? (
						// The nested level is indented behind a rule rather than flattened:
						// "Spaces needs Retrieval" is a different statement from "this app
						// needs Retrieval", and the install closure treats them differently
						// if Spaces is already present.
						<div className="mt-1.5 ml-3 border-l pl-3">
							<DependencyRows nodes={node.children} resolved={resolved} />
						</div>
					) : null}
				</li>
			))}
		</ul>
	);
}

/**
 * The "Requires these plugins" section of the Dependencies tab.
 *
 * Renders nothing when the listing declares no plugin dependencies, so the caller
 * can mount it unconditionally.
 */
export function RequiredPluginsSection({
	apps,
	showTechnical = true,
	subjectId,
	subjectName,
}: {
	apps: readonly DeclaredDependency[];
	/** Render the resolved TREE. Without it the section keeps the one fact a
	 *  non-technical reader needs — "installing X also installs 3 other apps" —
	 *  and drops the nested rows plus the sentence explaining what indentation
	 *  means. The summary is the same computation either way, so the simple view
	 *  is not a lossy approximation of the tree; it is the tree's own conclusion. */
	showTechnical?: boolean;
	subjectId?: string | null;
	subjectName: string;
}) {
	const lookup = useDependencyLookup();
	const tree = useMemo(
		() => resolveDependencyTree(apps, lookup, subjectId),
		[apps, lookup, subjectId]
	);
	const tally = useMemo(() => tallyDependencies(tree), [tree]);

	if (apps.length === 0) {
		return null;
	}

	const resolved = lookup !== null;
	const hasNested = tree.some((node) => node.children.length > 0);

	return (
		<section className="flex flex-col gap-2">
			<h3 className="flex items-center gap-1.5 font-medium text-sm">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={Link01Icon}
				/>
				Requires these plugins
			</h3>
			{showTechnical ? (
				<DependencyRows nodes={tree} resolved={resolved} />
			) : null}
			<p className="text-muted-foreground text-xs leading-relaxed">
				{summarize(subjectName, tally, resolved)}
			</p>
			{hasNested && showTechnical ? (
				<p className="text-muted-foreground text-xs leading-relaxed">
					Indented rows are what those dependencies need in turn.
				</p>
			) : null}
		</section>
	);
}

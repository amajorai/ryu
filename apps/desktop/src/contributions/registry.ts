// The desktop contribution registry — the seam the plugin extension host (#446)
// plugs into. It replaces the hardcoded `TabContent` if-else chain in
// `Layout.tsx` and the static command list in `CommandPalette.tsx` with a lookup.
//
// PR-1 scope: built-ins seed this registry DIRECTLY (see `builtins.ts`). It does
// NOT yet import the `@ryuhq/sdk` `RyuPlugin` types — the eventual flow is "plugin
// calls `RyuPlugin.registerRoute/registerCommand` -> host inserts here", but
// wiring that needs the plugin host (#444) and the `@ryuhq/sdk/plugin` export, so
// PR-1 stays decoupled and behavior-preserving.
//
// Matching precedence MUST mirror the old if-else (first-match-wins):
//   1. exact-path map lookup (O(1));
//   2. then an ORDERED list of pattern routes (RegExp / startsWith), first match.
// The old chain put exact paths above their pattern siblings (e.g. `/agents`
// above `/agents/:id/edit`, `/workflows` above `/workflows/:id`), and the pattern
// routes have disjoint prefixes, so exact-first + ordered-pattern reproduces it.

import type { ReactNode } from "react";

/** The minimal tab shape a route render-fn receives. Kept local (not imported
 *  from TabsContext) so this module has no desktop-context coupling and stays
 *  unit-testable in isolation. The real `Tab` is structurally compatible. */
export interface RouteTab {
	conversationId?: string;
	initialAgent?: string;
	/** Seeded chat attachments. Kept as `unknown[]` so the registry has no
	 *  coupling to the desktop's `AttachedImage` type; the `/chat` built-in casts
	 *  it back at the call site (see `builtins.ts`). */
	initialImages?: unknown[];
	initialProject?: string;
	initialPrompt?: string;
	/** When true, the seeded prompt/images are sent automatically once chat is
	 *  ready (the `/chat` built-in forwards it to `ChatPage`). */
	initialSubmit?: boolean;
	path: string;
}

/** Render the tab body for a matched route. A render-fn (not a bare component
 *  ref) so pattern routes can read params off `tab.path` and section-prop pages
 *  (e.g. `StorePage initialSection`) can pass props — the exact reasons the old
 *  chain could not be a plain `Record<path, Component>`. */
export type RouteRender = (tab: RouteTab, ctx: RouteContext) => ReactNode;

/** Per-render context the host injects (callbacks the old branches closed over,
 *  e.g. the agent-edit page's `onClose`). */
export interface RouteContext {
	onClose: () => void;
}

export interface ExactRoute {
	kind: "exact";
	path: string;
	render: RouteRender;
}

export interface PatternRoute {
	kind: "pattern";
	render: RouteRender;
	/** RegExp source matched against the full path, or a `startsWith` prefix. */
	test: RegExp | { startsWith: string };
}

export type RouteEntry = ExactRoute | PatternRoute;

/** A contributed command (built-in or plugin), shaped to map onto the desktop's
 *  `CommandAction` (`@ryu/command/types`) at the call site. Kept minimal here. */
export interface CommandEntry {
	group: string;
	id: string;
	keywords?: string;
	run(): void | Promise<void>;
	shortcut?: string;
	title: string;
}

export class ContributionRegistry {
	private readonly exact = new Map<string, ExactRoute>();
	private readonly patterns: PatternRoute[] = [];
	private readonly commands = new Map<string, CommandEntry>();

	/** Register a route. Returns a teardown (the Disposable seam plugins use). */
	registerRoute(entry: RouteEntry): () => void {
		if (entry.kind === "exact") {
			this.exact.set(entry.path, entry);
			return () => {
				if (this.exact.get(entry.path) === entry) {
					this.exact.delete(entry.path);
				}
			};
		}
		this.patterns.push(entry);
		return () => {
			const i = this.patterns.indexOf(entry);
			if (i !== -1) {
				this.patterns.splice(i, 1);
			}
		};
	}

	/** Resolve a path to its render-fn, or `null` if nothing matches. Exact map
	 *  first, then ordered patterns — first-match-wins, mirroring the old chain. */
	resolve(path: string): RouteRender | null {
		const exact = this.exact.get(path);
		if (exact) {
			return exact.render;
		}
		for (const p of this.patterns) {
			const hit =
				p.test instanceof RegExp
					? p.test.test(path)
					: path.startsWith(p.test.startsWith);
			if (hit) {
				return p.render;
			}
		}
		return null;
	}

	registerCommand(entry: CommandEntry): () => void {
		this.commands.set(entry.id, entry);
		return () => {
			if (this.commands.get(entry.id) === entry) {
				this.commands.delete(entry.id);
			}
		};
	}

	listCommands(): CommandEntry[] {
		return [...this.commands.values()];
	}
}

/** The app-wide registry instance. Built-ins seed it (see `builtins.ts`); the
 *  plugin host appends to the same instance once it lands (#444). */
export const contributionRegistry = new ContributionRegistry();

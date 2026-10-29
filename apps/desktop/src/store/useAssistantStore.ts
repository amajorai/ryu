import type { UIMessage } from "ai";
import { create } from "zustand";

/**
 * The global "Ask Ryu" assistant — a Notion-AI-style chat that opens over any
 * page, either as a floating card (bottom-right) or docked as a right sidebar.
 * It carries the current page as context (which the user can remove) and can be
 * promoted to a full-screen `/chat` tab via the panel's 3-dots menu.
 *
 * This store is the single source of truth shared by the launcher button, the
 * panel itself, and any page that wants to publish richer context. It mirrors
 * `useWorkspaceStore`'s plain-zustand style (no provider needed) so it is
 * reachable from anywhere in the desktop shell.
 */
export type AssistantMode = "closed" | "floating" | "sidebar";

/** A single piece of "what the user is looking at" handed to the assistant. */
export interface PageContextItem {
	/**
	 * Lazy resolver called at SEND time, winning over {@link PageContextItem.text}
	 * when present. This is what makes a live surface (a dashboard whose widgets
	 * refresh on their own, a canvas the user is still editing) answerable: a
	 * pushed snapshot describes the page as it was when the effect ran, which for
	 * anything self-refreshing is wrong by the time the user asks about it.
	 *
	 * Only reachable from in-process publishers (the hooks below). A sandboxed
	 * plugin cannot be called back synchronously across the bridge, so it
	 * re-publishes instead — see `assistant.publishContext` in the app host.
	 */
	getText?: () => string | Promise<string>;
	/** Stable id so a chip can be removed and de-duped. */
	id: string;
	/**
	 * Who published this, when that is not the page itself — set by the SHELL for
	 * bridge publishers (never by the app, which would just lie). Rendered on the
	 * chip and carried into the prompt block, so "an app is putting words in my
	 * assistant's mouth" is visible rather than something the user has to infer.
	 */
	source?: string;
	/**
	 * The content embedded into the message sent to the agent. A **snapshot** —
	 * correct for static surfaces (a doc's text at publish time), stale for live
	 * ones. Live surfaces set {@link PageContextItem.getText} instead and leave
	 * this as the last-known value (or `""`).
	 */
	text: string;
	/** Short human label shown on the context chip (e.g. the page/doc title). */
	title: string;
}

/** Owner-key PREFIX for in-process page publishers (`page:<hook instance>`).
 *  Bridge publishers use `plugin:<id>`, so an app and the page under it can never
 *  clobber each other — last-writer-wins across unrelated publishers was the old
 *  behaviour, and it is what made "one publisher at a time" a hidden constraint. */
export const PAGE_CONTEXT_OWNER = "page";

/** One publisher's slice of the context set, kept separate so a plugin and the
 *  page it is layered over both contribute instead of racing. */
interface ContextSlice {
	items: PageContextItem[];
	owner: string;
}

/**
 * Which kind of thing the assistant is currently driving. `agent` and `workflow`
 * are the two built-in builders (their preambles ship in `builderPreamble.ts`);
 * any other string is an **app-defined** surface, which must carry its own
 * `preamble`. Deliberately an open union — a closed enum here is exactly what
 * once forced Home's dashboard builder to grow a second chat pane rather than
 * drive the one global assistant (it now registers a `dashboard` surface).
 */
export type AssistantBuilderKind = "agent" | "workflow" | (string & {});

/**
 * A "builder takeover" registered by a builder page (agent edit, workflows) so
 * the ONE global assistant becomes that page's builder while the page is the
 * focused tab: it injects the builder preamble, drives the `*_builder.*` tools
 * with `persist: false`, and refreshes the page after each settled turn. The
 * page owns the wiring (resolve id, refresh callback); the panel owns the chat.
 *
 * Registered via `registerBuilder` (which auto-docks the panel as a sidebar),
 * kept live via `updateBuilder` (snapshot/id/name), and torn down via
 * `clearBuilder(owner)` when the page unmounts or loses focus. `conversationId`
 * doubles as the owner token so a background builder tab can't clear the active
 * one out from under it.
 */
export interface AssistantBuilderSession {
	/** Stable per-page conversation id (also the owner token). persist:false. */
	conversationId: string;
	/**
	 * Sentence describing what this surface is, shown under the empty-state title.
	 * Optional: the two built-in kinds have their own worded copy.
	 */
	description?: string;
	/**
	 * Whether registering DOCKS the panel open — the builder pages' behaviour
	 * (opening the agent editor is an explicit "I came here to build this").
	 * Bridge-registered surfaces pass `false`: an app that merely rendered its page
	 * has not asked for the assistant to appear, and popping a sidebar open on
	 * mount is how a helpful surface becomes an obnoxious one. Defaults to `true`,
	 * so existing callers are unchanged.
	 */
	dock?: boolean;
	/** Agent, workflow, or an app-defined surface id. Selects the built-in
	 *  preamble + empty-state copy; app-defined kinds bring their own. */
	kind: AssistantBuilderKind;
	/** Empty-state / header title. Defaults to `Build <targetName>`. */
	label?: string;
	/** Called after each settled turn with the edited id so the page re-hydrates. */
	onChanged: (id: string) => void;
	/**
	 * The instructions injected ahead of the first outgoing user message,
	 * REQUIRED for an app-defined `kind` (the built-in `agent`/`workflow` kinds
	 * fall back to `buildBuilderPreamble`). `{{targetId}}` and `{{snapshot}}` are
	 * substituted at send time so a surface registered before its record exists
	 * still names the right id.
	 */
	preamble?: string;
	/** One-tap starter prompts offered while the thread is empty. */
	prompts?: string[];
	/** Lazily resolve (creating a draft) the id to build. Returns null on failure. */
	resolveId: () => Promise<string | null>;
	/** Compact snapshot of the current definition, injected into the preamble. */
	snapshot: string;
	/** Target record id being built; null until a draft is created on first send. */
	targetId: string | null;
	/** Human name of the target, for the header + empty-state copy. */
	targetName: string;
	/**
	 * What an app-defined surface's conversation is about (e.g. one pull
	 * request). A new value starts a separate thread; an earlier one resumes.
	 */
	thread?: string;
	/**
	 * Tool ids this surface wants the assistant to reach for. **Advisory**: Core's
	 * chat stream takes no per-request tool allowlist, so these are named in the
	 * preamble ("use these tools"), not enforced. Real enforcement stays where it
	 * already is — the agent's own tool set and the in-chat permission prompt.
	 */
	tools?: string[];
}

/** The generalized name for a takeover — an app-defined surface is not a
 *  "builder". Same shape; the old name is kept so existing imports still resolve. */
export type AssistantSurfaceSession = AssistantBuilderSession;

const MODE_KEY = "ryu:assistant-mode";

/** Session-memory bounds for app-surface threads (never persisted to Core). */
const MAX_SURFACE_THREADS = 12;
const MAX_SURFACE_THREAD_MESSAGES = 80;
/** Session-memory bounds for answered tool-permission requests. */
const MAX_PERMISSION_SCOPES = 24;
const MAX_PERMISSIONS_PER_SCOPE = 64;

/** The last non-closed mode, so reopening restores the user's last layout. */
function loadLastMode(): "floating" | "sidebar" {
	try {
		return localStorage.getItem(MODE_KEY) === "sidebar"
			? "sidebar"
			: "floating";
	} catch {
		return "floating";
	}
}

function persistMode(mode: "floating" | "sidebar") {
	try {
		localStorage.setItem(MODE_KEY, mode);
	} catch {
		// best-effort
	}
}

interface AssistantState {
	/**
	 * The active builder takeover, or null when the assistant is the generic
	 * "Ask Ryu" chat. Set by a builder page while it is the focused tab.
	 */
	builder: AssistantBuilderSession | null;
	/** Tear down the builder takeover — no-op unless `owner` owns it. */
	clearBuilder: (owner: string) => void;
	/** Drop one publisher's whole context slice (unmount / blur / plugin close). */
	clearContextOwner: (owner: string) => void;
	/** Hide the panel without discarding the conversation. */
	close: () => void;
	/**
	 * Whether the user has dismissed the page context for the current session.
	 * Reset whenever the active page changes (a new page offers fresh context).
	 */
	contextDismissed: boolean;
	/** Every publisher's slice, in publish order. `pageContext` is its flattening. */
	contextOwners: ContextSlice[];
	/**
	 * The assistant's dedicated Core conversation id. Stable across open/close so
	 * the thread survives toggling the panel, and identical to the id handed to
	 * `openTab("/chat", { conversationId })` so the full-screen hand-off reopens
	 * the SAME conversation (Core rehydrates it via `loadMessages`).
	 */
	conversationId: string | null;
	/** Drop all context for now (chip "x"); re-offered on the next page change. */
	dismissContext: () => void;
	/**
	 * Record that the user answered a tool-permission request in `scope` (the
	 * conversation + target the request came from). Kept here, not in the panel,
	 * so closing Ask Ryu or switching surface threads never re-shows a prompt
	 * Core already resolved.
	 */
	markPermissionResolved: (scope: string, requestId: string) => void;
	/** Closed, or open in one of the two layouts. */
	mode: AssistantMode;
	/** Start a fresh assistant thread (clears the conversation + un-dismisses). */
	newConversation: () => void;

	/** Open the panel, restoring the last layout unless one is given. */
	open: (mode?: "floating" | "sidebar") => void;
	/** Richer context published by the active page (doc/file editors, etc.) and by
	 *  any app that reached the bridge — the flattening of `contextOwners`. */
	pageContext: PageContextItem[];
	/**
	 * A question an app asked the assistant on the user's behalf
	 * (`assistant.open({ prompt })`), waiting for the panel to mount and send it.
	 * A *queue of one*: the panel is unmounted while closed, so there is nobody to
	 * send it yet, and an app spamming opens should cost one turn, not N.
	 */
	pendingPrompt: string | null;
	/**
	 * Replace ONE publisher's slice, leaving every other publisher's alone. This
	 * is the bridge's entry point: an app publishes under `plugin:<id>` while the
	 * page it sits on keeps publishing under {@link PAGE_CONTEXT_OWNER}.
	 */
	publishContext: (owner: string, items: PageContextItem[]) => void;
	/**
	 * Register (or replace) the builder takeover and auto-dock the panel as a
	 * sidebar, so opening a builder page shows the builder docked by default.
	 */
	registerBuilder: (session: AssistantBuilderSession) => void;
	/**
	 * Ids the user removed with a chip's "x". A publisher re-publishing its slice
	 * (a diff finishing loading, a live board refreshing) must not bring them
	 * back. Cleared with the rest of the context choices: on a page change
	 * (`restoreContext`) and on a new conversation.
	 */
	removedContextIds: string[];
	/** Remove one published context item by id. */
	removePageContext: (id: string) => void;
	/** Answered permission request ids per scope, for this desktop session. */
	resolvedPermissions: Record<string, string[]>;
	/** Bring context back after a dismiss (the "Add page" affordance). */
	restoreContext: () => void;
	/** Remember an app-surface thread for this desktop session. */
	saveSurfaceThread: (threadId: string, messages: UIMessage[]) => void;
	/** Set (or clear) this conversation's id — used on first send + hand-off. */
	setConversationId: (id: string | null) => void;
	/** Switch between floating and sidebar without closing. */
	setLayout: (mode: "floating" | "sidebar") => void;
	/** Queue (or clear, with `null`) the app-asked prompt the panel sends on mount. */
	setPendingPrompt: (prompt: string | null) => void;
	/**
	 * App-surface threads kept in memory so closing and reopening Ask Ryu (which
	 * unmounts the panel) resumes them. Surface turns are `persist: false` — they
	 * carry the app's injected instructions — so they are never written to Core
	 * history; this is the only place they live, and only until the app quits.
	 */
	surfaceThreads: Record<string, UIMessage[]>;
	/** Patch the live builder fields (id/name/snapshot) without re-docking. */
	updateBuilder: (patch: Partial<AssistantBuilderSession>) => void;
}

/** Flatten the per-owner slices into the single list every reader consumes.
 *  Publish order is preserved so the page's own context leads and later
 *  publishers append — stable across re-publishes of an existing owner. */
function flatten(slices: ContextSlice[]): PageContextItem[] {
	return slices.flatMap((s) => s.items);
}

/** Replace one owner's slice (dropping it entirely when empty). */
function withOwner(
	slices: ContextSlice[],
	owner: string,
	items: PageContextItem[]
): ContextSlice[] {
	const without = slices.filter((s) => s.owner !== owner);
	if (items.length === 0) {
		return without;
	}
	const index = slices.findIndex((s) => s.owner === owner);
	if (index === -1) {
		return [...slices, { owner, items }];
	}
	// Re-publishing keeps the owner's position so chips don't jump around.
	return slices.map((s) => (s.owner === owner ? { owner, items } : s));
}

export const useAssistantStore = create<AssistantState>((set) => ({
	mode: "closed",
	conversationId: null,
	pageContext: [],
	removedContextIds: [],
	contextOwners: [],
	contextDismissed: false,
	pendingPrompt: null,
	builder: null,
	surfaceThreads: {},
	resolvedPermissions: {},

	markPermissionResolved: (scope, requestId) =>
		set((s) => {
			const { [scope]: previous = [], ...others } = s.resolvedPermissions;
			if (previous.includes(requestId)) {
				return {};
			}
			const kept = Object.entries(others).slice(-(MAX_PERMISSION_SCOPES - 1));
			return {
				resolvedPermissions: {
					...Object.fromEntries(kept),
					[scope]: [...previous, requestId].slice(-MAX_PERMISSIONS_PER_SCOPE),
				},
			};
		}),

	saveSurfaceThread: (threadId, messages) =>
		set((s) => {
			// Re-inserting moves the thread to the end, so the oldest drop first.
			const { [threadId]: _previous, ...others } = s.surfaceThreads;
			const kept = Object.entries(others).slice(-(MAX_SURFACE_THREADS - 1));
			return {
				surfaceThreads: {
					...Object.fromEntries(kept),
					[threadId]: messages.slice(-MAX_SURFACE_THREAD_MESSAGES),
				},
			};
		}),

	open: (mode) =>
		set(() => {
			const next = mode ?? loadLastMode();
			persistMode(next);
			return { mode: next };
		}),
	close: () => set({ mode: "closed" }),
	setLayout: (mode) =>
		set(() => {
			persistMode(mode);
			return { mode };
		}),
	setConversationId: (id) => set({ conversationId: id }),
	setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
	newConversation: () =>
		set({
			conversationId: null,
			contextDismissed: false,
			removedContextIds: [],
		}),
	publishContext: (owner, items) =>
		set((s) => {
			const visible = items.filter((c) => !s.removedContextIds.includes(c.id));
			const contextOwners = withOwner(s.contextOwners, owner, visible);
			return { contextOwners, pageContext: flatten(contextOwners) };
		}),
	clearContextOwner: (owner) =>
		set((s) => {
			const contextOwners = s.contextOwners.filter((o) => o.owner !== owner);
			return { contextOwners, pageContext: flatten(contextOwners) };
		}),
	removePageContext: (id) =>
		set((s) => {
			// Removing a chip removes it from whichever publisher contributed it —
			// the user's "not this" is about the item, not about who published it.
			const contextOwners = s.contextOwners
				.map((o) => ({ ...o, items: o.items.filter((c) => c.id !== id) }))
				.filter((o) => o.items.length > 0);
			return {
				contextOwners,
				pageContext: flatten(contextOwners),
				removedContextIds: [...s.removedContextIds, id].slice(-64),
			};
		}),
	dismissContext: () => set({ contextDismissed: true }),
	restoreContext: () => set({ contextDismissed: false, removedContextIds: [] }),

	registerBuilder: (session) =>
		set((s) => {
			// Keep the user's current layout when the SAME page re-registers (e.g.
			// after a re-focus while already open); otherwise auto-dock as a sidebar.
			// `nextMode` is always an open layout, so it is safe to persist directly.
			const sameOwner = s.builder?.conversationId === session.conversationId;
			if (session.dock === false) {
				// A silent takeover: the surface is live for whenever the user opens the
				// panel, but registering it does not open anything.
				return { builder: session };
			}
			const nextMode: "floating" | "sidebar" =
				sameOwner && s.mode !== "closed" ? s.mode : "sidebar";
			persistMode(nextMode);
			return { builder: session, mode: nextMode };
		}),
	updateBuilder: (patch) =>
		set((s) => (s.builder ? { builder: { ...s.builder, ...patch } } : {})),
	clearBuilder: (owner) =>
		set((s) => {
			// Owner-guarded so a background builder tab losing focus can't clear the
			// builder the newly-focused page just registered.
			if (s.builder?.conversationId !== owner) {
				return {};
			}
			// A takeover that opened the panel closes it again on the way out. One
			// that never opened it leaves it exactly as the user left it — closing a
			// panel the user opened themselves, because some app's page unmounted,
			// is the same intrusion as force-opening it.
			return s.builder.dock === false
				? { builder: null }
				: { builder: null, mode: "closed" };
		}),
}));

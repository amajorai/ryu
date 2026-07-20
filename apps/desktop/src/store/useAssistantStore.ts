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
	/** Stable id so a chip can be removed and de-duped. */
	id: string;
	/** The actual content embedded into the first message sent to the agent. */
	text: string;
	/** Short human label shown on the context chip (e.g. the page/doc title). */
	title: string;
}

/** Which kind of thing the assistant is currently building. */
export type AssistantBuilderKind = "agent" | "workflow";

/**
 * A "builder takeover" registered by a builder page (agent edit, workflows) so
 * the ONE global assistant becomes that page's builder while the page is the
 * focused tab: it injects the builder preamble, drives the `*_builder__*` tools
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
	/** Agent vs workflow — selects the preamble + empty-state copy. */
	kind: AssistantBuilderKind;
	/** Called after each settled turn with the edited id so the page re-hydrates. */
	onChanged: (id: string) => void;
	/** Lazily resolve (creating a draft) the id to build. Returns null on failure. */
	resolveId: () => Promise<string | null>;
	/** Compact snapshot of the current definition, injected into the preamble. */
	snapshot: string;
	/** Target record id being built; null until a draft is created on first send. */
	targetId: string | null;
	/** Human name of the target, for the header + empty-state copy. */
	targetName: string;
}

const MODE_KEY = "ryu:assistant-mode";

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
	/** Hide the panel without discarding the conversation. */
	close: () => void;
	/**
	 * Whether the user has dismissed the page context for the current session.
	 * Reset whenever the active page changes (a new page offers fresh context).
	 */
	contextDismissed: boolean;
	/**
	 * The assistant's dedicated Core conversation id. Stable across open/close so
	 * the thread survives toggling the panel, and identical to the id handed to
	 * `openTab("/chat", { conversationId })` so the full-screen hand-off reopens
	 * the SAME conversation (Core rehydrates it via `loadMessages`).
	 */
	conversationId: string | null;
	/** Drop all context for now (chip "x"); re-offered on the next page change. */
	dismissContext: () => void;
	/** Closed, or open in one of the two layouts. */
	mode: AssistantMode;
	/** Start a fresh assistant thread (clears the conversation + un-dismisses). */
	newConversation: () => void;

	/** Open the panel, restoring the last layout unless one is given. */
	open: (mode?: "floating" | "sidebar") => void;
	/** Richer context published by the active page (doc/file editors, etc.). */
	pageContext: PageContextItem[];
	/**
	 * Register (or replace) the builder takeover and auto-dock the panel as a
	 * sidebar, so opening a builder page shows the builder docked by default.
	 */
	registerBuilder: (session: AssistantBuilderSession) => void;
	/** Remove one published context item by id. */
	removePageContext: (id: string) => void;
	/** Bring context back after a dismiss (the "Add page" affordance). */
	restoreContext: () => void;
	/** Set (or clear) this conversation's id — used on first send + hand-off. */
	setConversationId: (id: string | null) => void;
	/** Switch between floating and sidebar without closing. */
	setLayout: (mode: "floating" | "sidebar") => void;
	/** Replace the page-published context (latest page wins). */
	setPageContext: (items: PageContextItem[]) => void;
	/** Patch the live builder fields (id/name/snapshot) without re-docking. */
	updateBuilder: (patch: Partial<AssistantBuilderSession>) => void;
}

export const useAssistantStore = create<AssistantState>((set) => ({
	mode: "closed",
	conversationId: null,
	pageContext: [],
	contextDismissed: false,
	builder: null,

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
	newConversation: () => set({ conversationId: null, contextDismissed: false }),
	setPageContext: (items) => set({ pageContext: items }),
	removePageContext: (id) =>
		set((s) => ({ pageContext: s.pageContext.filter((c) => c.id !== id) })),
	dismissContext: () => set({ contextDismissed: true }),
	restoreContext: () => set({ contextDismissed: false }),

	registerBuilder: (session) =>
		set((s) => {
			// Keep the user's current layout when the SAME page re-registers (e.g.
			// after a re-focus while already open); otherwise auto-dock as a sidebar.
			// `nextMode` is always an open layout, so it is safe to persist directly.
			const sameOwner = s.builder?.conversationId === session.conversationId;
			const nextMode: "floating" | "sidebar" =
				sameOwner && s.mode !== "closed" ? s.mode : "sidebar";
			persistMode(nextMode);
			return { builder: session, mode: nextMode };
		}),
	updateBuilder: (patch) =>
		set((s) => (s.builder ? { builder: { ...s.builder, ...patch } } : {})),
	clearBuilder: (owner) =>
		set((s) =>
			// Owner-guarded so a background builder tab losing focus can't clear the
			// builder the newly-focused page just registered.
			s.builder?.conversationId === owner
				? { builder: null, mode: "closed" }
				: {}
		),
}));

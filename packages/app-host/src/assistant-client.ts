/**
 * App-side client for the ONE global "Ask Ryu" assistant (`window.ryu.assistant`).
 *
 * Companion apps do not ship their own chat panes. A page that wants "ask about
 * this" publishes what it is showing as context, optionally lends the assistant
 * its own instructions and starter prompts while it is open, and lets the
 * desktop's floating/docked assistant own the conversation. Every app then gets
 * the same launcher, composer, history and permission prompts, and there is
 * never a second "Ask" toggle competing with the global one.
 *
 * The bridge itself (`assistant.*`, grant `assistant:context`) is documented in
 * `docs/ryu-apps-extensibility.md` §3b. This module only removes the per-app
 * boilerplate: chunking to the host's caps, re-publishing only on change, and
 * tearing the slice + surface down when the page goes away.
 */

import { useEffect, useMemo, useRef, useState } from "react";

/** Host-side caps for assistant bridge writes. `rpc.ts` truncates to these. */
export const ASSISTANT_LIMITS = {
	/** Max context items one app may publish at once. */
	contextItems: 8,
	/** Max characters per context item's body. */
	contextText: 8000,
	/** Max characters for a short label (chip title, surface label). */
	label: 120,
	/** Max advisory tool names / starter prompts a surface may declare. */
	listEntries: 12,
	/** Max characters for an app-supplied preamble. */
	preamble: 4000,
} as const;

export interface AppAssistantContextItem {
	/** Stable id so the chip can be removed and de-duplicated. */
	id: string;
	/** Prompt-ready body; treated by the assistant as untrusted page data. */
	text: string;
	/** Short chip label. */
	title: string;
}

export interface AppAssistantSurface {
	/** Sentence under the empty-state title. */
	description?: string;
	/** Header / empty-state title, e.g. "Ask about this PR". */
	label: string;
	/** Instructions the assistant follows while this page is open. */
	preamble?: string;
	/** One-tap starter prompts shown while the thread is empty. */
	prompts?: string[];
	/**
	 * What the conversation is about, e.g. one pull request's id. A new value
	 * starts a separate thread; returning to an earlier value resumes it.
	 */
	thread?: string;
	/** Advisory tool ids the assistant should reach for. */
	tools?: string[];
}

export interface AppAssistantOpenInput {
	mode?: "floating" | "sidebar";
	/** Ask on the user's behalf; the host prefixes the app's real name. */
	prompt?: string;
}

/** The subset of `window.ryu.assistant` this client drives. */
export interface AppAssistantBridge {
	clearContext(): Promise<unknown>;
	clearSurface(): Promise<unknown>;
	open(input?: AppAssistantOpenInput): Promise<unknown>;
	publishContext(items: AppAssistantContextItem[]): Promise<unknown>;
	registerSurface(surface: AppAssistantSurface): Promise<unknown>;
}

function isAssistantBridge(value: unknown): value is AppAssistantBridge {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.publishContext === "function" &&
		typeof record.clearContext === "function" &&
		typeof record.registerSurface === "function" &&
		typeof record.clearSurface === "function" &&
		typeof record.open === "function"
	);
}

/** The host's assistant bridge, or null outside the desktop / without the grant. */
export function getAppAssistant(): AppAssistantBridge | null {
	const ryu: unknown = (globalThis as { ryu?: unknown }).ryu;
	if (typeof ryu !== "object" || ryu === null) {
		return null;
	}
	const assistant = (ryu as { assistant?: unknown }).assistant;
	return isAssistantBridge(assistant) ? assistant : null;
}

/**
 * Split one long body into context items that each fit the host's per-item cap,
 * preferring line boundaries so a diff or log is not cut mid-line. Text past
 * `maxItems` chunks is dropped and the last chunk says so.
 */
export function chunkAssistantContext(input: {
	id: string;
	maxItems?: number;
	text: string;
	title: string;
}): AppAssistantContextItem[] {
	const limit = ASSISTANT_LIMITS.contextText;
	const maxItems = Math.max(
		1,
		Math.min(
			input.maxItems ?? ASSISTANT_LIMITS.contextItems,
			ASSISTANT_LIMITS.contextItems
		)
	);
	const truncationNote = "\n[truncated]";
	const chunks: string[] = [];
	let rest = input.text;
	while (rest.length > 0 && chunks.length < maxItems) {
		const isLast = chunks.length === maxItems - 1;
		if (rest.length <= limit) {
			chunks.push(rest);
			rest = "";
			break;
		}
		const room = isLast ? limit - truncationNote.length : limit;
		// Search below `room` so a cut just after the newline still fits.
		const newline = rest.lastIndexOf("\n", room - 1);
		const cut = newline > room / 2 ? newline + 1 : room;
		chunks.push(
			isLast ? `${rest.slice(0, cut)}${truncationNote}` : rest.slice(0, cut)
		);
		rest = rest.slice(cut);
	}
	// The host truncates ids to the label cap; keep the `#N` suffix inside it so
	// every chunk id stays unique after validation.
	const suffixRoom = `#${ASSISTANT_LIMITS.contextItems}`.length;
	if (chunks.length <= 1) {
		return [
			{
				id: input.id.slice(0, ASSISTANT_LIMITS.label),
				text: chunks[0] ?? "",
				title: input.title,
			},
		];
	}
	const baseId = input.id.slice(0, ASSISTANT_LIMITS.label - suffixRoom);
	return chunks.map((text, index) => ({
		id: `${baseId}#${index + 1}`,
		text,
		title: `${input.title} (${index + 1}/${chunks.length})`,
	}));
}

export interface AppAssistantSync {
	/** Drop this page's context and surface (unmount). */
	dispose(): void;
	/** Publish (or clear, with an empty list / null) this page's context. */
	setContext(items: AppAssistantContextItem[] | null): void;
	/** Register (or clear, with null) this page's assistant surface. */
	setSurface(surface: AppAssistantSurface | null): void;
}

/**
 * Keep one page's context slice and surface in step with the host, sending a
 * write only when the content actually changed. Bridge failures (no grant, an
 * older host) are reported through `onError` and never thrown into the page.
 */
export function createAppAssistantSync(
	bridge: AppAssistantBridge,
	onError?: (error: unknown) => void
): AppAssistantSync {
	let contextKey = "";
	let surfaceKey = "";
	const report = (promise: Promise<unknown>) => {
		promise.catch((error: unknown) => onError?.(error));
	};
	return {
		setContext(items) {
			const next = items?.length ? JSON.stringify(items) : "";
			if (next === contextKey) {
				return;
			}
			contextKey = next;
			report(
				next && items ? bridge.publishContext(items) : bridge.clearContext()
			);
		},
		setSurface(surface) {
			const next = surface ? JSON.stringify(surface) : "";
			if (next === surfaceKey) {
				return;
			}
			surfaceKey = next;
			report(
				next && surface
					? bridge.registerSurface(surface)
					: bridge.clearSurface()
			);
		},
		dispose() {
			if (contextKey) {
				contextKey = "";
				report(bridge.clearContext());
			}
			if (surfaceKey) {
				surfaceKey = "";
				report(bridge.clearSurface());
			}
		},
	};
}

/**
 * Ask the host to show the assistant. A refusal here is transient (the host
 * only opens it while the app's tab is focused), so it goes to `onError` and
 * never marks the bridge unavailable the way a denied publish does.
 */
export function openAppAssistant(
	bridge: AppAssistantBridge | null,
	input: AppAssistantOpenInput | undefined,
	onError?: (error: unknown) => void
): void {
	bridge?.open(input).catch((error: unknown) => onError?.(error));
}

export interface UseAppAssistantInput {
	/** What the page is showing, or null while there is nothing to share. */
	context: AppAssistantContextItem[] | null;
	/** Bridge failures; omit to ignore them (the page still works without AI). */
	onError?: (error: unknown) => void;
	/** The page's assistant surface, or null to leave the generic assistant. */
	surface: AppAssistantSurface | null;
}

export interface UseAppAssistantResult {
	/**
	 * Whether this app can reach the global assistant: the host installed the
	 * bridge and has not rejected a write. Frames are not told their grants up
	 * front, so a missing `assistant:context` grant reads `true` until the first
	 * publish is denied, then `false`. A refused `open()` (the app's tab is not
	 * focused) is transient: it reaches `onError` and leaves this `true`.
	 */
	available: boolean;
	/** Show the global assistant, optionally asking a question for the user. */
	open(input?: AppAssistantOpenInput): void;
}

/**
 * React binding: the standard way a companion page plugs into the global
 * assistant instead of rendering its own chat.
 */
export function useAppAssistant({
	context,
	onError,
	surface,
}: UseAppAssistantInput): UseAppAssistantResult {
	const bridge = useMemo(getAppAssistant, []);
	const [rejected, setRejected] = useState(false);
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;
	const reportRef = useRef((error: unknown) => {
		setRejected(true);
		onErrorRef.current?.(error);
	});
	const syncRef = useRef<AppAssistantSync | null>(null);
	if (bridge && !syncRef.current) {
		syncRef.current = createAppAssistantSync(bridge, (error) =>
			reportRef.current(error)
		);
	}

	const contextKey = context ? JSON.stringify(context) : "";
	const surfaceKey = surface ? JSON.stringify(surface) : "";

	// Keys, not object identity: pages rebuild these literals every render.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by serialized content
	useEffect(() => {
		syncRef.current?.setContext(context);
	}, [contextKey]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by serialized content
	useEffect(() => {
		syncRef.current?.setSurface(surface);
	}, [surfaceKey]);
	useEffect(() => () => syncRef.current?.dispose(), []);

	return useMemo(
		() => ({
			available: bridge !== null && !rejected,
			open(input?: AppAssistantOpenInput) {
				openAppAssistant(bridge, input, (error) => onErrorRef.current?.(error));
			},
		}),
		[bridge, rejected]
	);
}

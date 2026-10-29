import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { z } from "zod";
import type { Node } from "../../src/store/useNodeStore.ts";

interface DangerCategory {
	confirm_word: string;
	count: number;
	detail: string;
	id: string;
	noun: string;
	plugin: null | string;
	title: string;
}

interface ApiCall {
	authorization: string | null;
	body: { category?: string; confirm?: string } | null;
	method: string;
	path: string;
}

export interface DangerZoneProofState {
	apiCalls: ApiCall[];
	clearFailureRemaining: number;
	counts: {
		categories?: DangerCategory[];
		chats?: number;
		memory?: number;
		spaces?: number;
	};
	countsFailureRemaining: number;
	failProfile: string | null;
	invokeCalls: Array<{ args?: InvokeArgs; command: string }>;
	nodeMode: "local" | "remote";
	removedCount: number;
	resetFailureRemaining: number;
	resetFailureStatus: number | null;
	restartCalls: number;
	startCalls?: number;
}

declare global {
	interface Window {
		__DANGER_ZONE_PROOF__?: DangerZoneProofState;
	}
}

const PREFIX = "ryu-danger-zone-proof:";

function defaultCategories(): DangerCategory[] {
	return [
		{
			confirm_word: "Chats",
			count: 4,
			detail: "Every conversation and its messages will be removed.",
			id: "chats",
			noun: "chats",
			plugin: null,
			title: "Delete all chats",
		},
		{
			confirm_word: "Meeting notes",
			count: 3,
			detail: "Meeting notes owned by this app will be removed.",
			id: "com.ryu.meetings.notes",
			noun: "meeting notes",
			plugin: "@ryu/meetings",
			title: "Delete all meeting notes",
		},
		{
			confirm_word: "Spaces",
			count: 0,
			detail: "Every Space and its documents will be removed.",
			id: "spaces",
			noun: "spaces",
			plugin: null,
			title: "Delete all spaces",
		},
	];
}

function createState(): DangerZoneProofState {
	const search = new URLSearchParams(window.location.search);
	const resetFailureStatus = Number(search.get("resetFailure"));
	if (!window.name.startsWith(PREFIX)) {
		const categories = defaultCategories();
		const counts: {
			categories?: DangerCategory[];
			chats?: number;
			memory?: number;
			spaces?: number;
		} = search.has("legacy")
			? { chats: 9, memory: 3, spaces: 2 }
			: { categories };
		return {
			apiCalls: [],
			counts,
			countsFailureRemaining: search.has("countsFail") ? 1 : 0,
			clearFailureRemaining: search.has("clearFail") ? 1 : 0,
			failProfile: search.get("failProfile"),
			invokeCalls: [],
			nodeMode: search.has("remote") ? "remote" : "local",
			removedCount: 4,
			resetFailureStatus:
				resetFailureStatus === 403 || resetFailureStatus === 404
					? resetFailureStatus
					: null,
			resetFailureRemaining: search.has("resetFailure") ? 1 : 0,
			restartCalls: 0,
		};
	}
	try {
		return /* SAFETY: This isolated proof restores its own private PREFIX on window.name JSON written by persistState serializes the locally owned DangerZoneProofState after its typed initialization. The fixture controls this stored state; the cast is not schema validation for injected or external storage. */ JSON.parse(
			window.name.slice(PREFIX.length)
		) as DangerZoneProofState;
	} catch {
		return {
			apiCalls: [],
			counts: { categories: defaultCategories() },
			countsFailureRemaining: 0,
			clearFailureRemaining: 0,
			failProfile: null,
			invokeCalls: [],
			nodeMode: "local",
			removedCount: 4,
			resetFailureStatus: null,
			resetFailureRemaining: 0,
			restartCalls: 0,
		};
	}
}

const state = window.__DANGER_ZONE_PROOF__ ?? createState();
window.__DANGER_ZONE_PROOF__ = state;

function persistState(): void {
	window.name = `${PREFIX}${JSON.stringify(state)}`;
}

persistState();

function getProofNode(): Node {
	const isRemote = state.nodeMode === "remote";
	return {
		name: isRemote ? "Remote proof node" : "Local proof node",
		token: "danger-zone-proof-token",
		url: isRemote ? "http://remote.test:7980" : "http://127.0.0.1:7980",
	};
}

export function useActiveNodeGetter(): () => Node {
	return getProofNode;
}

/** The proof page selects one node per load, so the subscription is static. */
export function useActiveNode(): Node {
	return getProofNode();
}

export function isLocalNode(node: Pick<Node, "url">): boolean {
	return node.url === "http://127.0.0.1:7980";
}

export class Resource {
	readonly rid: number;

	constructor(rid: number) {
		this.rid = rid;
	}
}

export async function invoke(
	command: string,
	args?: InvokeArgs
): Promise<void> {
	state.invokeCalls.push({ args, command });
	persistState();
	// SAFETY: The complete installed InvokeArgs union owns this input. This
	// optional opaque cell only types its native profile lookup, not a decoded
	// command contract: field values stay unknown and native null/undefined
	// optional access, inherited getters, receivers and errors remain unchanged.
	if (
		command === "deep_clean_node" &&
		(args as (InvokeArgs & { profile?: unknown }) | null | undefined)
			?.profile === state.failProfile
	) {
		state.failProfile = null;
		persistState();
		throw new Error("Proof could not remove the selected profile.");
	}
	return;
}

export async function restartRyuCore(): Promise<string> {
	state.restartCalls += 1;
	persistState();
	return "proof-core-restarted";
}

export async function startRyuCore(): Promise<string> {
	state.startCalls = (state.startCalls ?? 0) + 1;
	persistState();
	return "proof-core-started";
}

export function installDangerZoneFetch(): () => void {
	const originalFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = isNativeText(input)
			? new URL(input, window.location.href)
			: input instanceof URL
				? input
				: new URL(input.url);
		if (!url.pathname.startsWith("/api/")) {
			return originalFetch(input, init);
		}
		const method = (init?.method ?? "GET").toUpperCase();
		let body: { category?: string; confirm?: string } | null = null;
		if (isNativeText(init?.body)) {
			body = z
				.object({
					category: z.string().optional(),
					confirm: z.string().optional(),
				})
				.parse(JSON.parse(init.body));
		}
		const headers = new Headers(init?.headers);
		state.apiCalls.push({
			authorization: headers.get("Authorization"),
			body,
			method,
			path: url.pathname,
		});
		persistState();

		if (method === "GET" && url.pathname === "/api/data/counts") {
			if (state.countsFailureRemaining > 0) {
				state.countsFailureRemaining -= 1;
				persistState();
				return Response.json(
					{ error: "Counts service unavailable" },
					{ status: 503 }
				);
			}
			return Response.json(structuredClone(state.counts));
		}
		if (method === "POST" && url.pathname === "/api/data/clear") {
			if (state.clearFailureRemaining > 0) {
				state.clearFailureRemaining -= 1;
				persistState();
				return Response.json({ error: "Store locked" }, { status: 500 });
			}
			const categories = state.counts.categories;
			if (Array.isArray(categories)) {
				const category = categories.find(
					(entry) => entry.id === body?.category
				);
				if (category) {
					state.removedCount = Number(category.count);
					category.count = 0;
				}
			}
			persistState();
			return Response.json({ removed: state.removedCount });
		}
		if (method === "POST" && url.pathname === "/api/node/reset") {
			if (state.resetFailureRemaining > 0 && state.resetFailureStatus) {
				state.resetFailureRemaining -= 1;
				persistState();
				const message =
					state.resetFailureStatus === 403
						? "Reset is disabled for a shared organization node."
						: "This Core version has no node reset route.";
				return Response.json(
					{ error: message },
					{ status: state.resetFailureStatus }
				);
			}
			return Response.json({ ok: true, restart_required: true });
		}
		return Response.json(
			{ error: `Unexpected proof request: ${method} ${url.pathname}` },
			{ status: 404 }
		);
	};
	return () => {
		window.fetch = originalFetch;
	};
}

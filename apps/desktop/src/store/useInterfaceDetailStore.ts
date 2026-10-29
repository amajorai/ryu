// Message-derived detail for interface threads (spec §3.2 "Detail store
// hydration"), kept apart from the thread list so a step change does not
// rebuild every thread. Cloned from useSidebarTodoProgressStore: one entry per
// node + conversation, keyed by a revision, with in-flight dedupe and a
// stale-token guard.
//
// It also holds in-memory LIVE-TAB entries that a mounted ChatPage publishes
// for its own thread (permission asks with their respond callback, the live
// step, errors, the exact run start). Those carry callbacks, so they are never
// serialized or persisted, and they disappear on reload. Live entries and
// answered permissions are keyed by node and thread: request and tool-call
// ids repeat across nodes, threads and Core restarts.

import type {
	InterfaceActivity,
	InterfaceAsk,
	InterfaceBlocker,
} from "@ryuhq/protocol/interfaces";
import { create } from "zustand";
import type {
	DetailMessage,
	ThreadDetail,
} from "@/src/lib/interface-detail.ts";

export interface InterfaceDetailEntry {
	detail: ThreadDetail | null;
	/** Older messages exist before the page that was read. */
	hasOlder: boolean;
	/** Host clock when the read finished (ms). */
	readAt: number;
	revision: string;
	status: "error" | "loading" | "ready";
}

export interface LivePermissionEntry {
	ask: InterfaceAsk;
	/** Bound to ChatPage's own respondToPermission; never serialized. */
	respond: (optionId: string) => Promise<void> | void;
}

export interface LiveTabEntry {
	activity?: InterfaceActivity | null;
	blocker?: InterfaceBlocker | null;
	/** RFC 3339 time of the newest live step. */
	lastProgressAt?: string | null;
	permission?: LivePermissionEntry | null;
	/** The publishing tab's turn is in flight. */
	running?: boolean;
	/** Exact start of the current turn (data-ryu-turn-control startedAtMs). */
	startedAtMs?: number | null;
	threadId: string;
}

/** A live entry as the store holds it: the node its tab talks to, too. */
export interface NodeLiveTabEntry extends LiveTabEntry {
	nodeUrl: string;
}

export type LiveTabPatch = Partial<Omit<LiveTabEntry, "threadId">>;

/**
 * Where a live entry belongs. Core mints permission ids (`perm-<seq>`) from a
 * per-process counter and tool-call ids repeat across threads, so every live
 * lookup is scoped to one node and one thread, never searched globally.
 */
export interface LiveTabScope {
	nodeUrl: string;
	threadId: string;
}

/** The store key of one node's thread (same shape as the detail entry keys). */
export function liveTabKey(scope: LiveTabScope): string {
	return JSON.stringify([scope.nodeUrl, scope.threadId]);
}

/** The key of one answered permission: node, conversation and request id. */
export function answeredPermissionKey(
	scope: LiveTabScope & { requestId: string }
): string {
	return JSON.stringify([scope.nodeUrl, scope.threadId, scope.requestId]);
}

function answeredKeyMatches(
	key: string,
	scope: { nodeUrl: string; threadId?: string }
): boolean {
	const parsed = parseKey(key);
	return (
		parsed?.[0] === scope.nodeUrl &&
		(scope.threadId === undefined || parsed[1] === scope.threadId)
	);
}

/** A JSON array key of strings (live, answered and detail entry keys). */
function parseKey(key: string): string[] | null {
	try {
		const parsed: unknown = JSON.parse(key);
		return Array.isArray(parsed) &&
			parsed.every((part) => typeof part === "string")
			? parsed
			: null;
	} catch {
		return null;
	}
}

/** The publisher used when a caller passes none. */
export const DEFAULT_LIVE_PUBLISHER = "default";

interface PublishedEntry extends NodeLiveTabEntry {
	/** Publish order, so the newest publisher wins a tie. */
	seq: number;
}

export interface InterfaceDetailStore {
	/** Permissions answered in a tab or an interface, keyed by
	 *  `answeredPermissionKey` (node, conversation, request id), so every chat
	 *  tab on that thread drops the prompt together. Pruned when the turn
	 *  ends and when the node changes: a later turn, or a restarted Core, may
	 *  mint the same request id again. */
	answeredPermissions: Record<string, true | undefined>;
	/** Clear one permission ask from a thread's publishers (from one publisher
	 *  given a token). */
	clearLivePermission: (
		scope: LiveTabScope,
		askId: string,
		publisher?: string
	) => void;
	entries: Record<string, InterfaceDetailEntry | undefined>;
	/** One entry per node and thread (`liveTabKey`), chosen from its
	 *  publishers (see `pickLive`). */
	live: Record<string, NodeLiveTabEntry | undefined>;
	/** Record an answered permission and clear its ask from the publishers of
	 *  that node's thread. */
	markPermissionAnswered: (scope: LiveTabScope & { requestId: string }) => void;
	/** Drop answered permissions of one node (and one thread, when given). */
	pruneAnsweredPermissions: (scope: {
		nodeUrl: string;
		threadId?: string;
	}) => void;
	/** Per `liveTabKey`, per publisher token. */
	publishers: Record<string, Record<string, PublishedEntry> | undefined>;
	/** Merge one tab's live state for its thread. Two tabs on one thread (a
	 *  companion panel mounts a second chat) publish under their own tokens. */
	publishLive: (
		scope: LiveTabScope,
		patch: LiveTabPatch,
		publisher?: string
	) => void;
	/** Drop one publisher's entry for a thread (all of them without a token). */
	removeLive: (scope: LiveTabScope, publisher?: string) => void;
	setEntry: (key: string, entry: InterfaceDetailEntry) => void;
}

/** The entry that speaks for a thread: one holding a permission, else one
 *  whose turn runs, else the newest. */
function pickLive(
	entries: Record<string, PublishedEntry> | undefined
): NodeLiveTabEntry | undefined {
	const list = Object.values(entries ?? {}).sort((a, b) => b.seq - a.seq);
	const chosen =
		list.find((entry) => entry.permission) ??
		list.find((entry) => entry.running) ??
		list[0];
	if (!chosen) {
		return;
	}
	const { seq: _seq, ...entry } = chosen;
	return entry;
}

function withPublishers(
	state: InterfaceDetailStore,
	key: string,
	entries: Record<string, PublishedEntry> | undefined
): Partial<InterfaceDetailStore> {
	const publishers = { ...state.publishers };
	const live = { ...state.live };
	if (entries && Object.keys(entries).length > 0) {
		publishers[key] = entries;
		live[key] = pickLive(entries);
	} else {
		delete publishers[key];
		delete live[key];
	}
	return { live, publishers };
}

function withoutPermission(
	state: InterfaceDetailStore,
	scope: LiveTabScope,
	askId: string,
	publisher?: string
): Partial<InterfaceDetailStore> | null {
	const key = liveTabKey(scope);
	const entries = state.publishers[key];
	let cleared: Record<string, PublishedEntry> | null = null;
	for (const [token, entry] of Object.entries(entries ?? {})) {
		if (
			entry.permission?.ask.id === askId &&
			(publisher === undefined || publisher === token)
		) {
			cleared ??= { ...entries };
			cleared[token] = { ...entry, permission: null };
		}
	}
	return cleared ? withPublishers(state, key, cleared) : null;
}

let publishSeq = 0;

export const useInterfaceDetailStore = create<InterfaceDetailStore>((set) => ({
	answeredPermissions: {},
	clearLivePermission: (scope, askId, publisher) =>
		set((state) => withoutPermission(state, scope, askId, publisher) ?? state),
	entries: {},
	live: {},
	markPermissionAnswered: (scope) =>
		set((state) => ({
			...(withoutPermission(state, scope, `permission:${scope.requestId}`) ??
				{}),
			answeredPermissions: {
				...state.answeredPermissions,
				[answeredPermissionKey(scope)]: true,
			},
		})),
	pruneAnsweredPermissions: (scope) =>
		set((state) => {
			const kept = Object.fromEntries(
				Object.entries(state.answeredPermissions).filter(
					([key]) => !answeredKeyMatches(key, scope)
				)
			);
			return Object.keys(kept).length ===
				Object.keys(state.answeredPermissions).length
				? state
				: { answeredPermissions: kept };
		}),
	publishLive: (scope, patch, publisher = DEFAULT_LIVE_PUBLISHER) =>
		set((state) => {
			publishSeq += 1;
			const key = liveTabKey(scope);
			const mine = state.publishers[key] ?? {};
			const current = mine[publisher] ?? { seq: publishSeq, ...scope };
			return withPublishers(state, key, {
				...mine,
				[publisher]: {
					...current,
					...patch,
					nodeUrl: scope.nodeUrl,
					seq: publishSeq,
					threadId: scope.threadId,
				},
			});
		}),
	publishers: {},
	removeLive: (scope, publisher) =>
		set((state) => {
			const key = liveTabKey(scope);
			const thread = state.publishers[key];
			if (!thread) {
				return state;
			}
			if (publisher === undefined) {
				return withPublishers(state, key, undefined);
			}
			if (!thread[publisher]) {
				return state;
			}
			const { [publisher]: _removed, ...rest } = thread;
			return withPublishers(state, key, rest);
		}),
	setEntry: (key, entry) =>
		set((state) => ({ entries: { ...state.entries, [key]: entry } })),
}));

/** Whether a permission was answered on this node's conversation. */
export function isPermissionAnswered(
	answered: InterfaceDetailStore["answeredPermissions"],
	scope: LiveTabScope & { requestId: string }
): boolean {
	return answered[answeredPermissionKey(scope)] === true;
}

/**
 * The live permission entry for the ask on screen: published for the ask's
 * own thread on `nodeUrl`, carrying exactly this ask id. Never a search across
 * threads or nodes, where the same `perm-<seq>` id can belong to another call.
 */
export function getLivePermission(
	ask: Pick<InterfaceAsk, "id" | "threadId">,
	nodeUrl: string
): LivePermissionEntry | null {
	if (!ask.threadId) {
		return null;
	}
	const entries =
		useInterfaceDetailStore.getState().publishers[
			liveTabKey({ nodeUrl, threadId: ask.threadId })
		];
	for (const entry of Object.values(entries ?? {})) {
		if (entry.permission?.ask.id === ask.id) {
			return entry.permission;
		}
	}
	return null;
}

/**
 * The conversation and tool call behind a question ask on screen, from the
 * detail entries of `nodeUrl` whose ask belongs to the same thread. Null when
 * none holds it, or when more than one does (a tool-call id repeated by two
 * helper sessions): an ambiguous answer is refused, never guessed.
 */
export function getQuestionHolder(
	ask: Pick<InterfaceAsk, "id" | "threadId">,
	nodeUrl: string
): { conversationId: string; toolCallId: string } | null {
	if (!ask.threadId) {
		return null;
	}
	const found: { conversationId: string; toolCallId: string }[] = [];
	for (const [key, entry] of Object.entries(
		useInterfaceDetailStore.getState().entries
	)) {
		if (parseKey(key)?.[0] !== nodeUrl) {
			continue;
		}
		for (const item of entry?.detail?.questionAsks ?? []) {
			if (item.ask.id === ask.id && item.ask.threadId === ask.threadId) {
				found.push({
					conversationId: item.holderId,
					toolCallId: item.toolCallId,
				});
			}
		}
	}
	return found.length === 1 ? (found[0] ?? null) : null;
}

const inFlight = new Map<string, Promise<void>>();
const activeTokens = new Map<string, symbol>();

export interface EnsureInterfaceDetailInput {
	derive: (
		messages: readonly DetailMessage[],
		hasOlder: boolean
	) => ThreadDetail;
	/** Re-read even at the same revision (running threads change under it). */
	force?: boolean;
	key: string;
	load: () => Promise<{
		hasOlder: boolean;
		messages: readonly DetailMessage[];
		status: "error" | "ok";
	}>;
	now?: () => number;
	revision: string;
}

/** A failed read is retried at the same revision after this long. */
export const DETAIL_ERROR_RETRY_MS = 30_000;

/**
 * Whether an entry already answers for `revision`: a ready read at it, or a
 * failed read at it that is still inside its retry backoff.
 */
export function isInterfaceDetailCurrent(
	entry: InterfaceDetailEntry | undefined,
	revision: string,
	nowMs: number
): boolean {
	if (entry?.revision !== revision) {
		return false;
	}
	if (entry.status === "ready") {
		return true;
	}
	return (
		entry.status === "error" && nowMs - entry.readAt < DETAIL_ERROR_RETRY_MS
	);
}

/**
 * Read and derive one conversation's detail unless it is already current.
 * Concurrent calls for the same key and revision share one read; a read that
 * finishes after a newer one started is dropped. `started` says whether this
 * call began a read (so a caller can spend a read budget only on real reads).
 */
export function ensureInterfaceDetail(input: EnsureInterfaceDetailInput): {
	done: Promise<void>;
	started: boolean;
} {
	const requestKey = `${input.key}\u0000${input.revision}`;
	const pending = inFlight.get(requestKey);
	if (pending) {
		return { done: pending, started: false };
	}
	const now = input.now ?? Date.now;
	const existing = useInterfaceDetailStore.getState().entries[input.key];
	if (
		!input.force &&
		isInterfaceDetailCurrent(existing, input.revision, now())
	) {
		return { done: Promise.resolve(), started: false };
	}
	const token = Symbol(input.key);
	activeTokens.set(input.key, token);
	if (!existing || existing.revision !== input.revision) {
		useInterfaceDetailStore.getState().setEntry(input.key, {
			detail: existing?.detail ?? null,
			hasOlder: existing?.hasOlder ?? false,
			readAt: existing?.readAt ?? 0,
			revision: existing?.revision ?? "",
			status: "loading",
		});
	}
	const operation = (async () => {
		try {
			const result = await input.load();
			if (activeTokens.get(input.key) !== token) {
				return;
			}
			if (result.status !== "ok") {
				throw new Error("read failed");
			}
			useInterfaceDetailStore.getState().setEntry(input.key, {
				detail: input.derive(result.messages, result.hasOlder),
				hasOlder: result.hasOlder,
				readAt: now(),
				revision: input.revision,
				status: "ready",
			});
		} catch {
			if (activeTokens.get(input.key) !== token) {
				return;
			}
			const current = useInterfaceDetailStore.getState().entries[input.key];
			// readAt marks the failure, so the retry waits out its backoff.
			useInterfaceDetailStore.getState().setEntry(input.key, {
				detail: current?.detail ?? null,
				hasOlder: current?.hasOlder ?? false,
				readAt: now(),
				revision: input.revision,
				status: "error",
			});
		} finally {
			inFlight.delete(requestKey);
			if (activeTokens.get(input.key) === token) {
				activeTokens.delete(input.key);
			}
		}
	})();
	inFlight.set(requestKey, operation);
	return { done: operation, started: true };
}

/** Forget every read (node switch, tests). Live-tab entries stay. */
export function resetInterfaceDetail(): void {
	inFlight.clear();
	activeTokens.clear();
	useInterfaceDetailStore.setState({ entries: {} });
}

/**
 * The active node changed from `previousNodeUrl`: forget every detail read,
 * and that node's live entries and answered permissions. Tabs still on it
 * publish again under their own node; nothing from it can answer an ask
 * shown for another node.
 */
export function resetInterfaceNode(previousNodeUrl: string): void {
	resetInterfaceDetail();
	const state = useInterfaceDetailStore.getState();
	const publishers = { ...state.publishers };
	const live = { ...state.live };
	for (const key of Object.keys(publishers)) {
		if (parseKey(key)?.[0] === previousNodeUrl) {
			delete publishers[key];
			delete live[key];
		}
	}
	useInterfaceDetailStore.setState({ live, publishers });
	state.pruneAnsweredPermissions({ nodeUrl: previousNodeUrl });
}

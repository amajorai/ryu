import {
	CodedRpcError,
	type ToastDismissInput,
	type ToastShowInput,
	type ToastUpdateInput,
} from "./rpc.ts";

export interface ToastRenderer {
	dismiss(slotId: string): void;
	render(input: ToastShowInput, slotId: string): void;
}

interface SileoToastOptions {
	description?: string;
	duration?: number;
	id: string;
	title: string;
	type?: "loading";
}

interface SileoPresenter {
	dismiss(id: string): void;
	error(options: SileoToastOptions): void;
	info(options: SileoToastOptions): void;
	show(options: SileoToastOptions): void;
	success(options: SileoToastOptions): void;
	warning(options: SileoToastOptions): void;
}

/** Adapt the shared Ryu toast vocabulary to Sileo while keeping renderer slot
 * ids host-owned. */
export function createSileoToastRenderer(
	presenter: SileoPresenter
): ToastRenderer {
	return {
		dismiss: (slotId) => {
			presenter.dismiss(slotId);
		},
		render: (input, slotId) => {
			const options = {
				description: input.description,
				duration: input.duration,
				id: slotId,
				title: input.title,
			};
			switch (input.variant) {
				case "error":
					presenter.error(options);
					return;
				case "info":
					presenter.info(options);
					return;
				case "loading":
					presenter.show({ ...options, type: "loading" });
					return;
				case "success":
					presenter.success(options);
					return;
				case "warning":
					presenter.warning(options);
					return;
				case "default":
				case undefined:
					presenter.show(options);
					return;
				default: {
					const exhaustive: never = input.variant;
					return exhaustive;
				}
			}
		},
	};
}

interface ScopedToastHostOptions {
	maxActive?: number;
	maxOperations?: number;
	now?: () => number;
	randomId?: () => string;
	rateWindowMs?: number;
	renderer: ToastRenderer;
	sourceId: string;
}

interface ToastEntry {
	input: ToastShowInput;
	slotId: string;
}

const DEFAULT_MAX_ACTIVE = 8;
const DEFAULT_MAX_OPERATIONS = 20;
const DEFAULT_RATE_WINDOW_MS = 10_000;

function shortHash(value: string): string {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) | 0;
	}
	return (hash >>> 0).toString(36);
}

function defaultRandomId(): string {
	if (globalThis.crypto?.randomUUID !== undefined) {
		return globalThis.crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Build one bounded toast lane for one sandboxed caller.
 *
 * Caller ids and renderer slots are different namespaces. A frame receives only
 * the former, so it cannot address another caller's global Sileo slot. Disposing
 * the lane dismisses every toast that belongs to the caller.
 */
export function createScopedToastHost(options: ScopedToastHostOptions) {
	const {
		maxActive = DEFAULT_MAX_ACTIVE,
		maxOperations = DEFAULT_MAX_OPERATIONS,
		now = Date.now,
		randomId = defaultRandomId,
		rateWindowMs = DEFAULT_RATE_WINDOW_MS,
		renderer,
		sourceId,
	} = options;
	const entries = new Map<string, ToastEntry>();
	const operationTimes: number[] = [];
	const sourceHash = shortHash(sourceId);
	const instanceId = randomId().slice(0, 48);
	let sequence = 0;
	let state: "active" | "disposed" | "disposing" = "active";

	const assertActive = () => {
		if (state !== "active") {
			throw new CodedRpcError("server_error", "Toast host is disposed");
		}
	};

	const consumeBudget = () => {
		const timestamp = now();
		while (
			operationTimes.length > 0 &&
			timestamp - (operationTimes[0] ?? timestamp) >= rateWindowMs
		) {
			operationTimes.shift();
		}
		if (operationTimes.length >= maxOperations) {
			throw new CodedRpcError(
				"over_budget",
				"Toast rate limit exceeded for this app"
			);
		}
		operationTimes.push(timestamp);
	};

	const dismissEntry = (localId: string, entry: ToastEntry) => {
		try {
			renderer.dismiss(entry.slotId);
		} finally {
			entries.delete(localId);
		}
	};

	const evictOldestIfFull = () => {
		if (entries.size < maxActive) {
			return;
		}
		const oldest = entries.entries().next().value;
		if (oldest) {
			try {
				dismissEntry(oldest[0], oldest[1]);
			} catch {
				// A stale renderer slot must not prevent the new toast from showing.
			}
		}
	};

	return {
		dismiss(input: ToastDismissInput): void {
			assertActive();
			consumeBudget();
			const entry = entries.get(input.id);
			if (!entry) {
				return;
			}
			dismissEntry(input.id, entry);
		},
		dispose(): void {
			if (state !== "active") {
				return;
			}
			state = "disposing";
			try {
				for (const [localId, entry] of entries) {
					try {
						dismissEntry(localId, entry);
					} catch {
						// Continue cleanup when one renderer slot has disappeared.
					}
				}
				operationTimes.length = 0;
			} finally {
				state = "disposed";
			}
		},
		show(input: ToastShowInput): string {
			assertActive();
			consumeBudget();
			evictOldestIfFull();
			sequence += 1;
			const suffix = randomId().slice(0, 48);
			const localId = `toast-${sequence.toString(36)}-${suffix}`.slice(0, 128);
			const slotId = `ryu-app-toast-${sourceHash}-${instanceId}-${sequence.toString(36)}`;
			entries.set(localId, { input, slotId });
			try {
				renderer.render(input, slotId);
			} catch (error) {
				entries.delete(localId);
				throw error;
			}
			return localId;
		},
		update(input: ToastUpdateInput): void {
			assertActive();
			consumeBudget();
			const entry = entries.get(input.id);
			if (!entry) {
				return;
			}
			const next: ToastShowInput = { ...entry.input };
			if (input.title !== undefined) {
				next.title = input.title;
			}
			if (input.description !== undefined) {
				next.description = input.description;
			}
			if (input.variant !== undefined) {
				next.variant = input.variant;
			}
			if (input.duration !== undefined) {
				next.duration = input.duration;
			}
			const previous = entry.input;
			entry.input = next;
			try {
				renderer.render(next, entry.slotId);
			} catch (error) {
				entry.input = previous;
				throw error;
			}
		},
	};
}

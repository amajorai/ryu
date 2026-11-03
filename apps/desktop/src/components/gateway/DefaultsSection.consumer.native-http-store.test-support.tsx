import { mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { AgentSelection } from "@/src/lib/api/preferences.ts";

/** Module state other suites' modules write, kept on one shared object. */
export const live = {
	records: undefined as unknown as Records,
	refusedLocalWrites: 0,
	activeHandlers: 0,
	nextCallId: 0,
	persistence: Promise.resolve(),
	publicationId: 0,
	diagnosticCase: 0,
	holdLocalReadCredentials: null as {
		bearer: string;
		delegation: string;
	} | null,
	refuseLocalReadCredentials: null as {
		bearer: string;
		delegation: string;
	} | null,
	root: null as Root | null,
	container: null as HTMLDivElement | null,
	showEvals: true,
	evalGeneration: 0,
	showFreshRefusalEvals: false,
};

// The mounted shipping producer, query consumers and SDK stay intact. Only
// their external HTTP peer is owned by this invocation. This does not execute
// Core authorization, SQLite, provider inference or a native OS keychain.
export const nativeFetch = globalThis.fetch;
export const NativeRequest = globalThis.Request;
export const NativeResponse = globalThis.Response;
export const NativeAbortController = globalThis.AbortController;
export const NativeAbortSignal = globalThis.AbortSignal;
export const NativeReadableStream = globalThis.ReadableStream;
export const NativeTextEncoder = globalThis.TextEncoder;
export const nativeResponseText = NativeResponse.prototype.text;
export const ownsDom = globalThis.document === undefined;
if (ownsDom) {
	GlobalRegistrator.register();
}
export const registeredAbortController = Object.getOwnPropertyDescriptor(
	globalThis,
	"AbortController"
);
export const registeredAbortSignal = Object.getOwnPropertyDescriptor(
	globalThis,
	"AbortSignal"
);
// Bun's native HTTP Request accepts its own genuine abort primitives. Keep
// those intact rather than replacing the SDK or translating cancellation.
Object.defineProperty(globalThis, "AbortController", {
	configurable: true,
	writable: true,
	value: NativeAbortController,
});
Object.defineProperty(globalThis, "AbortSignal", {
	configurable: true,
	writable: true,
	value: NativeAbortSignal,
});
export const previousActFlag = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

export const localKey = "default-local-agent-selection";
export const cloudKey = "default-cloud-agent-selection";
export const idleKey = "engine.llamacpp.sleep-idle-seconds";
export const entitlementKeys = new Set([
	"entitlement-active",
	"managed-inference-entitled",
]);
export const directory = await mkdtemp(
	join(tmpdir(), "ryu-defaults-consumer-")
);
export const stateFile = join(directory, "preferences.json");
export type Owner = "a" | "foreign";
export type Records = Record<Owner, Record<string, string>>;
export interface Call {
	bearer: string | null;
	body: unknown;
	clientId: string | null;
	delegation: string | null;
	id: number;
	method: string;
	owner: Owner | null;
	status: number;
	url: string;
}
export interface BodyRead {
	id: number;
	status: number;
	text: string;
}
export interface HeldBody {
	cancelled: string | null;
	id: number;
	release: () => void;
	released: boolean;
	text: string;
}
export const calls: Call[] = [];
export const bodyReads: BodyRead[] = [];
export const bodyReadStarts: number[] = [];
export const heldBodies: HeldBody[] = [];
export const unexpected: string[] = [];
export const transportErrors: string[] = [];
export const nativeExchanges = new Set<Promise<Response>>();
export const nativeBodyObservations = new Set<Promise<string>>();
export const returnedBodies = new Set<number>();
export const transportWaiters = new Set<() => void>();
export const allowed = new Map<string, Owner>();
export const diagnosticDirectory = process.env.RYU_DEFAULTS_PROOF_ARTIFACTS;

export function notifyTransportChange() {
	for (const wake of [...transportWaiters]) {
		wake();
	}
}
export function waitForTransportChange() {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			transportWaiters.delete(wake);
			reject(
				new Error(
					"Actual returned HTTP body did not finish its decoder observation"
				)
			);
		}, 4000);
		const wake = () => {
			clearTimeout(timer);
			transportWaiters.delete(wake);
			resolve();
		};
		transportWaiters.add(wake);
	});
}
export async function settleNativeTransport() {
	while (
		nativeExchanges.size ||
		nativeBodyObservations.size ||
		returnedBodies.size
	) {
		const pending = [...nativeExchanges, ...nativeBodyObservations];
		if (pending.length) {
			await Promise.allSettled(pending);
		} else {
			await waitForTransportChange();
		}
	}
}

export function selection(model: string): AgentSelection {
	return {
		agent_id: "",
		provider: "",
		model,
		thinking_level: "",
		effort: "",
		access_mode: "",
	};
}
export function seed(model: string): Record<string, string> {
	return {
		[localKey]: JSON.stringify(selection(model)),
		[cloudKey]: JSON.stringify(selection("cloud-preserved")),
		[idleKey]: "300",
		"entitlement-active": "true",
		"managed-inference-entitled": "false",
		"unrelated-defaults-proof": "preserved",
	};
}
export async function persistRecords() {
	const payload = JSON.stringify(live.records);
	const temporary = join(directory, `preferences-${++live.publicationId}.tmp`);
	const publication = live.persistence.then(async () => {
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(payload);
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, stateFile);
			// Windows refuses to fsync a directory handle (EPERM) and NTFS journals
			// the rename, so only POSIX hosts sync the parent directory.
			if (process.platform !== "win32") {
				const parent = await open(directory, "r");
				try {
					await parent.sync();
				} finally {
					await parent.close();
				}
			}
		} finally {
			await rm(temporary, { force: true });
		}
	});
	// A refused publication still rejects its own caller; later owned writes
	// can recover without concurrent truncation or an unhandled queue rejection.
	live.persistence = publication.catch(() => undefined);
	await publication;
}
export async function independentlyReadRecords(): Promise<Records> {
	const value: unknown = JSON.parse(await readFile(stateFile, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid owned preference ledger");
	}
	for (const owner of ["a", "foreign"] as const) {
		const entry: unknown = Reflect.get(value, owner);
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`Missing owned preference namespace ${owner}`);
		}
		if (Object.values(entry).some((field) => typeof field !== "string")) {
			throw new Error("Invalid stored preference value");
		}
	}
	return value as Records;
}
export function recordBody(raw: string): unknown {
	if (raw === "") {
		return null;
	}
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
export function preferenceBody(value: unknown): value is { value: string } {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === 1 &&
		typeof Reflect.get(value, "value") === "string"
	);
}

export function holdNativeJsonBody(call: Call, body: unknown) {
	const text = JSON.stringify(body);
	const bytes = new NativeTextEncoder().encode(text);
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const held: HeldBody = {
		id: call.id,
		text,
		released: false,
		cancelled: null,
		release() {
			if (held.released || held.cancelled !== null) {
				return;
			}
			if (!controller) {
				throw new Error("Native response body has no stream controller");
			}
			controller.enqueue(bytes.subarray(1));
			controller.close();
			held.released = true;
		},
	};
	const stream = new NativeReadableStream<Uint8Array>({
		start(next) {
			controller = next;
			// Send genuine headers and a partial JSON byte over HTTP. The SDK's
			// actual awaited text decoder cannot finish until the rest is released.
			next.enqueue(bytes.subarray(0, 1));
		},
		cancel(reason: unknown) {
			held.cancelled = String(reason);
			transportErrors.push(
				`Held native body ${call.id} cancelled: ${String(reason)}`
			);
		},
	});
	heldBodies.push(held);
	call.status = 200;
	return new NativeResponse(stream, {
		status: 200,
		headers: {
			"content-type": "application/json",
			"x-defaults-proof-call": String(call.id),
		},
	});
}
export function heldBodySnapshot() {
	return heldBodies.map(({ id, text, released, cancelled }) => ({
		id,
		text,
		released,
		cancelled,
	}));
}
export function releaseHeldBodies() {
	live.holdLocalReadCredentials = null;
	for (const body of heldBodies) {
		body.release();
	}
}

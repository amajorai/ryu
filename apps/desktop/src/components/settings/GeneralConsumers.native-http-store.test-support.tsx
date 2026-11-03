import {
	closeSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { z } from "zod";
import { CORE_LOCAL_ENGINES } from "../../lib/api/local-engines.ts";

/** Module state other suites' modules write, kept on one shared object. */
export const live = {
	activeHandlers: 0,
	activeFetches: 0,
	activeBodies: 0,
	sequence: 0,
	ownedOrigin: "",
	root: null as Root | null,
	rootHost: null as HTMLElement | null,
	domObserver: null as MutationObserver | null,
	activeChild: null as ReturnType<typeof Bun.spawn> | null,
};

// SOURCE-ONLY prospective current-integration baseline. No business module,
// method, provider, store hook, consent gate, or SDK response is substituted.
// Native HTTP and the fsynced JSON peer are finite host adapters, not Core auth
// or Core durable-store acceptance. Fresh component mounts and the independent
// Bun/HappyDOM gate boot below are explicitly distinct from physical browser reload.
export const NativeRequest = globalThis.Request;
export const NativeResponse = globalThis.Response;
export const nativeFetch = globalThis.fetch;
export const nativeSetTimeout = globalThis.setTimeout;
export const nativeClearTimeout = globalThis.clearTimeout;
export const priorActDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
export const priorFetchDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"fetch"
);
export const ownsDom = !GlobalRegistrator.isRegistered;
export const ownedDirectory = mkdtempSync("/tmp/ryu-general-consumers-native-");
export const fixtureErrors: string[] = [];
export const runtimeErrors: string[] = [];
export const unexpectedDestinations: string[] = [];
export const fetchErrors: string[] = [];
export const bodyErrors: string[] = [];
export const waiters = new Set<() => void>();
export const fixtureTimers = new Set<ReturnType<typeof nativeSetTimeout>>();

export const preferenceSchema = z.object({ value: z.string() }).strict();
export const consentSchema = z
	.object({ include_sensitive_topics: z.boolean() })
	.strict();
export const recordSchema = z
	.object({
		preferences: z.record(z.string(), z.string()),
		consent: z.record(z.string(), z.boolean()),
		unrelated: z
			.object({
				projectId: z.string(),
				revision: z.number(),
				bytes: z.string(),
			})
			.strict(),
	})
	.strict();
export type PeerDocument = z.infer<typeof recordSchema>;
export type PhysicalNode = "a" | "b";
export interface Exchange {
	body: unknown;
	bodyConsumed: boolean;
	id: number;
	jwt: string;
	method: string;
	node: PhysicalNode;
	path: string;
	rawBody: string;
	responseText: string | null;
	status: number | null;
}
export interface HeldReply {
	admitted: boolean;
	arrived: Promise<Exchange>;
	match: (call: Exchange) => boolean;
	release: () => void;
	released: Promise<void>;
	signalArrival: (call: Exchange) => void;
	status: 200 | 503;
}
export const calls: Exchange[] = [];
export const holds: HeldReply[] = [];
export const localConservation = {
	ryu_timezone: "Europe/London",
	"general-proof-unrelated": '{"draft":"retain exactly","revision":7}',
	ryu_long_term_memory: "false",
	ryu_node_tab_override_enabled: "false",
	ryu_client_id: "general-consumers-native-client",
};
export const memoryKeys = [
	"auto-recall-enabled",
	"auto-recall-top-k",
	"skills-disclosure",
	"tools.active_ranker",
	"context.max-tokens",
	"context.max-output-tokens",
	"context.auto-compact",
	"context.compact-model",
	"context.compact-effort",
	"context.compact-on-cache-expire",
	"context.handoff-on-model-change",
	// The context card also reads (never writes) every scoped
	// `context.max-tokens` override Core gives precedence over the global key:
	// `.local` plus each local engine's `.engine.<id>`. None is seeded, so each
	// reads as unset and the card shows no scoped-override note.
	"context.max-tokens.local",
	...CORE_LOCAL_ENGINES.map((engine) => `context.max-tokens.engine.${engine}`),
];
export const privacyKeys = [
	"product-analytics-enabled",
	"community-stats-enabled",
	"profile-activity-enabled",
	"crash-reports-enabled",
	"diagnostics-export-enabled",
	"diagnostics-otlp-endpoint",
	"diagnostics-otlp-content-mode",
	"diagnostics-otlp-preset",
	"diagnostics-otlp-project",
	"diagnostics-otlp-region",
	"diagnostics-otlp-api-key-ref",
	"diagnostics-otlp-public-key-ref",
	"support-access-local-enabled",
	"support-access-local-expiry",
] as const;
export const knownKeys = new Set<string>([...memoryKeys, ...privacyKeys]);
export const healing = {
	enabled: true,
	auto_decide: false,
	cooldown_secs: 300,
	diagnose_effort: "low",
	diagnose_model: "",
	max_attempts: 1,
};
export function pulse() {
	for (const wake of [...waiters]) {
		wake();
	}
}
export function errorText(error: unknown) {
	return error instanceof Error
		? `${error.name}: ${error.message}`
		: String(error);
}
export function atomicWrite(path: string, text: string) {
	const temporary = `${path}.pending`;
	const fd = openSync(temporary, "w", 0o600);
	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	// Windows cannot fsync a directory handle (EPERM); NTFS journals the rename.
	if (process.platform === "win32") {
		return;
	}
	const directoryFd = openSync(ownedDirectory, "r");
	try {
		fsyncSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
}
export function documentPath(node: PhysicalNode) {
	return join(ownedDirectory, `${node}.json`);
}
export function rawDocument(node: PhysicalNode) {
	return readFileSync(documentPath(node), "utf8");
}
export function readDocument(node: PhysicalNode): PeerDocument {
	return recordSchema.parse(JSON.parse(rawDocument(node)));
}
export function writeDocument(node: PhysicalNode, document: PeerDocument) {
	atomicWrite(
		documentPath(node),
		`${JSON.stringify(recordSchema.parse(document))}\n`
	);
}
export function seedDocument(node: PhysicalNode): PeerDocument {
	return {
		preferences: {
			"auto-recall-enabled": node === "a" ? "true" : "false",
			"auto-recall-top-k": node === "a" ? "4" : "7",
			"skills-disclosure": "progressive",
			"tools.active_ranker": "needle2",
			"context.max-tokens": "0",
			"context.max-output-tokens": "0",
			"context.auto-compact": "false",
			"context.compact-model": "",
			"context.compact-effort": "",
			"context.compact-on-cache-expire": "false",
			"context.handoff-on-model-change": "false",
			"product-analytics-enabled": "false",
			"community-stats-enabled": "false",
			"profile-activity-enabled": "false",
			"crash-reports-enabled": "false",
			"diagnostics-export-enabled": "false",
			"diagnostics-otlp-endpoint": "https://collector.invalid/retained",
			"diagnostics-otlp-content-mode": "metadata_only",
			"support-access-local-enabled": "false",
			"support-access-local-expiry": "0",
			"unrelated-node-preference": `{"retain":"whole document","node":"${node}"}`,
		},
		consent: { "delegation-a": false, "delegation-b": true },
		unrelated: {
			projectId: `project-${node}`,
			revision: 19,
			bytes: "unchanged raw companion state",
		},
	};
}
export function heldReply(
	match: HeldReply["match"],
	status: HeldReply["status"]
) {
	let signalArrival: HeldReply["signalArrival"] = () => {
		throw new Error("Arrival resolver unavailable");
	};
	let release: HeldReply["release"] = () => {
		throw new Error("Release resolver unavailable");
	};
	const hold: HeldReply = {
		match,
		status,
		admitted: false,
		arrived: new Promise((resolve) => {
			signalArrival = resolve;
		}),
		signalArrival: (call) => signalArrival(call),
		released: new Promise((resolve) => {
			release = resolve;
		}),
		release: () => release(),
	};
	holds.push(hold);
	return hold;
}
export function exactHeaderContract(
	request: Request,
	node: PhysicalNode
): string {
	const headers = request.headers;
	if (headers.get("authorization") !== `Bearer general-peer-node-${node}`) {
		throw new Error("Undeclared node Bearer");
	}
	const jwt = headers.get("x-ryu-user-jwt");
	if (jwt !== "delegation-a" && jwt !== "delegation-b") {
		throw new Error("Undeclared delegated identity");
	}
	if (node === "b" && jwt !== "delegation-b") {
		throw new Error("Foreign delegated identity on node B");
	}
	if (headers.get("content-type") !== "application/json") {
		throw new Error("Noncanonical SDK content type");
	}
	if (
		headers.get("x-ryu-client-id") !== localConservation.ryu_client_id ||
		headers.get("x-ryu-client-label") !== "Desktop" ||
		headers.get("x-ryu-surface") !== "desktop"
	) {
		throw new Error("Incorrect actual Desktop client attribution");
	}
	const allowed = new Set([
		"host",
		"accept",
		"accept-encoding",
		"connection",
		"content-length",
		"user-agent",
		"authorization",
		"content-type",
		"x-ryu-user-jwt",
		"x-ryu-client-id",
		"x-ryu-client-label",
		"x-ryu-surface",
	]);
	for (const [name] of headers) {
		if (!allowed.has(name)) {
			throw new Error(`Undeclared request header ${name}`);
		}
	}
	return jwt;
}
export function jsonReply(call: Exchange, data: unknown, status = 200) {
	const text = JSON.stringify(data);
	call.status = status;
	call.responseText = text;
	pulse();
	return new NativeResponse(text, {
		status,
		headers: {
			"content-type": "application/json",
			"x-general-proof-response-id": String(call.id),
		},
	});
}

export function storageSnapshot(): Record<string, string> {
	const values: Record<string, string> = {};
	for (let index = 0; index < localStorage.length; index += 1) {
		const key = localStorage.key(index);
		if (key === null) {
			throw new Error("Native Storage key disappeared during snapshot");
		}
		const value = localStorage.getItem(key);
		if (value === null) {
			throw new Error("Native Storage value disappeared during snapshot");
		}
		values[key] = value;
	}
	return values;
}
export function restoreStorage(values: Record<string, string>) {
	localStorage.clear();
	for (const [key, value] of Object.entries(values)) {
		localStorage.setItem(key, value);
	}
}

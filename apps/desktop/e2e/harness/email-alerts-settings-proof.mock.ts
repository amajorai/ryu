import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import type { Node } from "../../src/store/useNodeStore.ts";
import { type ProofJsonRecord, parseProofJsonRecord } from "../fixture-json.ts";

export interface CapturedRequest {
	authorization: string | null;
	body: ProofJsonRecord | null;
	method: string;
	path: string;
}

interface Failure {
	message: string;
	remaining: number;
	status: number;
}

interface StoredTransport {
	from: string;
	host: string;
	passwordSet: boolean;
	port: number;
	starttls: boolean;
	username: string;
}

interface StoredDelivery {
	emails: string[];
	targets: {
		bot_token?: string;
		chat_id?: string;
		kind: "email" | "expo_push" | "telegram" | "webhook";
		token?: string;
		to?: string;
		url?: string;
	}[];
}

export interface EmailAlertsProofState {
	calls: CapturedRequest[];
	delivery: StoredDelivery;
	failures: Record<string, Failure>;
	holds: string[];
	transport: StoredTransport;
}

declare global {
	interface Window {
		__EMAIL_ALERTS_PROOF__?: {
			hold: (key: string) => void;
			fail: (key: string, failure: Failure) => void;
			release: (key: string) => void;
			snapshot: () => EmailAlertsProofState;
		};
	}
}

const TransportSchema = z.object({
	from: z.string(),
	host: z.string(),
	passwordSet: z.boolean(),
	port: z.number(),
	starttls: z.boolean(),
	username: z.string(),
});
const DeliverySchema = z.object({
	emails: z.array(z.string()),
	targets: z.array(
		z.object({
			kind: z.enum(["email", "expo_push", "telegram", "webhook"]),
			bot_token: z.string().optional(),
			chat_id: z.string().optional(),
			token: z.string().optional(),
			to: z.string().optional(),
			url: z.string().optional(),
		})
	),
}) satisfies z.ZodType<StoredDelivery>;
const FailureSchema = z.object({
	message: z.string(),
	remaining: z.number(),
	status: z.number(),
});
const EmailAlertsStateSchema = z.object({
	calls: z.array(
		z.object({
			authorization: z.string().nullable(),
			body: z.record(z.string(), z.json()).nullable(),
			method: z.string(),
			path: z.string(),
		})
	),
	delivery: DeliverySchema,
	failures: z.record(z.string(), FailureSchema),
	holds: z.array(z.string()),
	transport: TransportSchema,
}) satisfies z.ZodType<EmailAlertsProofState>;

const STORAGE_KEY = "ryu-email-alerts-proof-state";
const defaultState: EmailAlertsProofState = {
	calls: [],
	delivery: {
		emails: ["ops@example.com", "finance@example.com"],
		targets: [
			{ kind: "webhook", url: "https://hooks.example.com/old" },
			{ kind: "telegram", bot_token: "proof-bot-token", chat_id: "channel-7" },
			{ kind: "expo_push", token: "ExponentPushToken[proof]" },
			{ kind: "email", to: "legacy@example.com" },
		],
	},
	failures: {},
	holds: [],
	transport: {
		from: "Ryu <alerts@example.com>",
		host: "smtp.initial.example.com",
		passwordSet: true,
		port: 2525,
		starttls: true,
		username: "relay-user",
	},
};

function readState(): EmailAlertsProofState {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			return EmailAlertsStateSchema.parse(JSON.parse(stored));
		}
	} catch {
		// The proof is still usable when storage is unavailable; it just won't
		// model persistence across reloads.
	}
	const state = structuredClone(defaultState);
	const query = new URLSearchParams(window.location.search);
	if (query.has("holdEmailLoad")) {
		state.holds.push("GET /api/email/transport");
	}
	if (query.has("holdEmailSave")) {
		state.holds.push("PUT /api/email/transport");
	}
	if (query.has("holdEmailTest")) {
		state.holds.push("POST /api/email/test");
	}
	if (query.has("holdDeliverySave")) {
		state.holds.push("PUT /api/alerts/delivery");
	}
	if (query.has("failEmailLoad")) {
		state.failures["GET /api/email/transport"] = {
			message: "Email transport is still starting.",
			remaining: 1,
			status: 503,
		};
	}
	if (query.has("failDeliveryLoad")) {
		state.failures["GET /api/alerts/delivery"] = {
			message: "Alert delivery is still starting.",
			remaining: 1,
			status: 503,
		};
	}
	persistState(state);
	return state;
}

function persistState(state: EmailAlertsProofState): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// A storage-disabled browser can still run the within-page behavior proof.
	}
}

const state = readState();
const pending = new Map<string, Array<() => void>>();

function json<FixturePayload>(value: FixturePayload, status = 200): Response {
	return Response.json(value, { status });
}

function hold(key: string, resume: () => void): Promise<void> {
	return new Promise((resolve) => {
		const waiting = pending.get(key) ?? [];
		waiting.push(() => {
			resume();
			resolve();
		});
		pending.set(key, waiting);
	});
}

function release(key: string): void {
	state.holds = state.holds.filter((held) => held !== key);
	persistState(state);
	for (const resume of pending.get(key) ?? []) {
		resume();
	}
	pending.delete(key);
}

window.__EMAIL_ALERTS_PROOF__ = {
	hold: (key) => {
		state.holds = [...new Set([...state.holds, key])];
		persistState(state);
	},
	fail: (key, failure) => {
		state.failures[key] = structuredClone(failure);
		persistState(state);
	},
	release,
	snapshot: () => structuredClone(state),
};

export const useNodeStore = Object.assign(
	function useNodeStore<T>(
		selector: (snapshot: { getActiveNode: () => Node }) => T
	): T {
		const managed = new URLSearchParams(window.location.search).has("managed");
		return selector({
			getActiveNode: () => ({
				managed,
				name: managed ? "Managed proof node" : "Self-hosted proof node",
				token: "email-alerts-proof-token",
				url: "http://email-alerts.test:7980",
			}),
		});
	},
	{
		getState: () => ({
			getActiveNode: (): Node => {
				const managed = new URLSearchParams(window.location.search).has(
					"managed"
				);
				return {
					managed,
					name: managed ? "Managed proof node" : "Self-hosted proof node",
					token: "email-alerts-proof-token",
					url: "http://email-alerts.test:7980",
				};
			},
		}),
	}
);

export function installEmailAlertsProofFetch(): () => void {
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
		const path = url.pathname;
		const key = `${method} ${path}`;
		const headers = new Headers(init?.headers);
		const body = isNativeText(init?.body)
			? parseProofJsonRecord(init.body)
			: null;
		state.calls.push({
			authorization: headers.get("Authorization"),
			body,
			method,
			path,
		});
		persistState(state);

		const failure = state.failures[key];
		if (failure && failure.remaining > 0) {
			failure.remaining -= 1;
			persistState(state);
			return json({ error: failure.message }, failure.status);
		}

		let result: Response | null = null;
		const applyRequest = () => {
			if (method === "GET" && path === "/api/email/transport") {
				result = json(state.transport);
				return;
			}
			if (method === "PUT" && path === "/api/email/transport") {
				if (!body) {
					result = json({ error: "Missing SMTP transport body" }, 400);
					return;
				}
				state.transport = {
					from: String(body.from ?? ""),
					host: String(body.host ?? ""),
					passwordSet:
						state.transport.passwordSet ||
						(isNativeText(body.password) && body.password.length > 0),
					port: Number(body.port ?? 0),
					starttls: body.starttls === true,
					username: String(body.username ?? ""),
				};
				result = json({ ok: true });
				persistState(state);
				return;
			}
			if (method === "POST" && path === "/api/email/test") {
				result = json({ ok: true, messageId: "email-alerts-proof-message-id" });
				return;
			}
			if (method === "GET" && path === "/api/alerts/delivery") {
				result = json(state.delivery);
				return;
			}
			if (method === "PUT" && path === "/api/alerts/delivery") {
				if (!body) {
					result = json({ error: "Missing alert delivery body" }, 400);
					return;
				}
				state.delivery = DeliverySchema.parse(body);
				result = json({ ok: true });
				persistState(state);
				return;
			}
			result = json({ error: `Unexpected proof request: ${key}` }, 404);
		};

		if (state.holds.includes(key)) {
			await hold(key, applyRequest);
		} else {
			applyRequest();
		}
		return result ?? json({ error: `No response configured for ${key}` }, 500);
	};
	return () => {
		window.fetch = originalFetch;
	};
}

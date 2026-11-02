declare const window: Window;

// The browser-side caller fixture for side-chats-caller-proof.spec.ts. It is
// serialized into an init script with toString(), so it must stay
// self-contained: only type imports.
import type { useNodeStore } from "../src/store/useNodeStore.ts";
import type {
	SideChatCodecs,
	SideChatManifest,
	SideChatRequest,
} from "./side-chat-proof.contracts.ts";

type BrowserProofFetch = Window["fetch"] &
	Partial<Pick<typeof fetch, "preconnect">>;

export interface Call {
	body: SideChatRequest | Record<string, never>;
	method: string;
	path: string;
}
export interface Fixture {
	aborted: number;
	calls: Call[];
	mode: "allow" | "deny" | "error" | "pending" | "pending-abort";
	release: (() => void) | null;
}

export interface SideChatWindow extends Window {
	__SIDE_CHAT_PROOF_CODECS__: SideChatCodecs;
	__sideChatCallerFixture: Fixture;
	__sideChatNodeFixture: typeof useNodeStore;
}

export function installSideChatCaller({
	manifest,
	conversationId,
	answer,
}: {
	manifest: SideChatManifest;
	conversationId: string;
	answer: string;
}) {
	// SAFETY: the bundled prefix in this same init script installs these concrete native JSON codecs in this same browser realm.
	const codecs = (window as SideChatWindow).__SIDE_CHAT_PROOF_CODECS__;
	const fixture: Fixture = {
		mode: "allow",
		aborted: 0,
		calls: [],
		release: null,
	};
	Object.defineProperty(window, "__sideChatCallerFixture", {
		value: fixture,
	});
	const key = "ryu-side-chat-caller-proof-entries";
	const wrap = (fallback: BrowserProofFetch): BrowserProofFetch =>
		Object.assign(
			async (
				input: Parameters<Window["fetch"]>[0],
				init?: Parameters<Window["fetch"]>[1]
			) => {
				const url = new URL(
					input instanceof Request ? input.url : String(input),
					location.href
				);
				if (url.pathname === "/api/plugins/contributions") {
					return Response.json(
						Object.fromEntries(
							Object.entries(manifest.contributes).map(([name, entries]) => [
								name,
								entries.map((entry) => ({ ...entry, plugin: manifest.id })),
							])
						)
					);
				}
				if (url.pathname === "/api/preferences/voice-mode-readback") {
					return Response.json({
						key: "voice-mode-readback",
						value: JSON.stringify({ enabled: false }),
					});
				}
				if (url.pathname === "/api/btw" && init?.method === "POST") {
					const body = codecs.sideChatRequestSchema.parse(
						JSON.parse(String(init.body))
					);
					fixture.calls.push({ body, path: url.pathname, method: "POST" });
					const mode = fixture.mode;
					if (mode === "deny") {
						return Response.json(
							{ error: "Side chat access denied" },
							{ status: 403 }
						);
					}
					if (mode === "error") {
						return Response.json(
							{ error: "Side chat service unavailable" },
							{ status: 503 }
						);
					}
					if (mode === "pending" || mode === "pending-abort") {
						await new Promise<void>((resolve, reject) => {
							fixture.release = resolve;
							init.signal?.addEventListener(
								"abort",
								() => {
									fixture.aborted += 1;
									if (mode === "pending-abort") {
										reject(new DOMException("Aborted", "AbortError"));
									}
								},
								{ once: true }
							);
						});
					}
					const entries = codecs.sideChatEntriesSchema.parse(
						JSON.parse(localStorage.getItem(key) ?? "[]")
					);
					const id = `side-chat-${entries.length + 1}`;
					entries.unshift({
						id,
						conversation_id: conversationId,
						question: body.question,
						answer,
						model: "fixture-side-model",
						created_at: 1_724_000_020_000 + entries.length,
					});
					localStorage.setItem(key, JSON.stringify(entries));
					return Response.json({ id, answer, model: "fixture-side-model" });
				}
				if (url.pathname === `/api/conversations/${conversationId}/btw`) {
					fixture.calls.push({ body: {}, path: url.pathname, method: "GET" });
					return Response.json(
						codecs.sideChatEntriesSchema.parse(
							JSON.parse(localStorage.getItem(key) ?? "[]")
						)
					);
				}
				return fallback(input, init);
			},
			{ preconnect: fallback.preconnect }
		);
	// The existing harness assigns its own fixture fetch. Wrap that assignment
	// too, preserving its native/static asset fallback and all other endpoints.
	const nativeFetch = globalThis.fetch;
	let current = wrap(
		Object.assign(nativeFetch.bind(globalThis), {
			preconnect: nativeFetch.preconnect,
		})
	);
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		get: () => current,
		set: (value: Window["fetch"]) => {
			current = wrap(value);
		},
	});
}

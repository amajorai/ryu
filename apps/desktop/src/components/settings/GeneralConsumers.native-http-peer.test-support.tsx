import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	bodyErrors,
	calls,
	consentSchema,
	type Exchange,
	errorText,
	exactHeaderContract,
	fetchErrors,
	fixtureErrors,
	healing,
	holds,
	jsonReply,
	knownKeys,
	live,
	localConservation,
	NativeRequest,
	NativeResponse,
	nativeFetch,
	ownsDom,
	preferenceSchema,
	pulse,
	readDocument,
	runtimeErrors,
	storageSnapshot,
	unexpectedDestinations,
	writeDocument,
} from "./GeneralConsumers.native-http-store.test-support.tsx";

export const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		live.activeHandlers += 1;
		pulse();
		try {
			const url = new URL(request.url);
			if (url.origin !== live.ownedOrigin || url.search || url.hash) {
				throw new Error("Undeclared origin/query/hash");
			}
			const route =
				/^\/(a|b)(\/api\/(?:preferences\/([^/]+)|memory\/settings|spaces|healing\/config))$/.exec(
					url.pathname
				);
			const physicalNode = route?.[1];
			const path = route?.[2];
			if ((physicalNode !== "a" && physicalNode !== "b") || !path) {
				throw new Error("Undeclared native peer route");
			}
			const jwt = exactHeaderContract(request, physicalNode);
			const rawBody = await request.text();
			let body: unknown = null;
			if (request.method === "GET") {
				if (rawBody !== "") {
					throw new Error("GET body is forbidden");
				}
			} else if (request.method === "PUT") {
				try {
					body = JSON.parse(rawBody);
				} catch {
					throw new Error("Invalid native JSON write");
				}
			} else {
				throw new Error("Undeclared method");
			}
			const rawKey = route?.[3];
			const key = rawKey === undefined ? null : decodeURIComponent(rawKey);
			if (key !== null) {
				if (rawKey !== encodeURIComponent(key)) {
					throw new Error("Noncanonical SDK preference path encoding");
				}
				if (!knownKeys.has(key)) {
					throw new Error("Undeclared preference key");
				}
				if (request.method === "PUT") {
					const value = preferenceSchema.parse(body).value;
					if (
						(key !== "auto-recall-enabled" &&
							key !== "product-analytics-enabled") ||
						(value !== "true" && value !== "false")
					) {
						throw new Error("Undeclared preference write/value");
					}
				}
			} else if (path === "/api/memory/settings") {
				if (request.method === "PUT") {
					consentSchema.parse(body);
				}
			} else if (request.method !== "GET") {
				throw new Error("Read-only peer route");
			}
			const call: Exchange = {
				id: ++live.sequence,
				node: physicalNode,
				path,
				method: request.method,
				jwt,
				rawBody,
				body,
				status: null,
				responseText: null,
				bodyConsumed: false,
			};
			calls.push(call);
			const hold = holds.find(
				(candidate) => !candidate.admitted && candidate.match(call)
			);
			if (hold) {
				hold.admitted = true;
				hold.signalArrival(call);
				pulse();
				await hold.released;
				if (hold.status === 503) {
					return jsonReply(
						call,
						{ error: "Declared external peer refusal; no durable mutation" },
						503
					);
				}
			}
			const document = readDocument(physicalNode);
			if (key !== null) {
				if (request.method === "GET") {
					return jsonReply(call, {
						key,
						value: document.preferences[key] ?? null,
					});
				}
				document.preferences[key] = preferenceSchema.parse(body).value;
				writeDocument(physicalNode, document);
				return jsonReply(call, { ok: true, key });
			}
			if (path === "/api/memory/settings") {
				if (request.method === "PUT") {
					document.consent[jwt] =
						consentSchema.parse(body).include_sensitive_topics;
					writeDocument(physicalNode, document);
				}
				return jsonReply(call, {
					include_sensitive_topics: document.consent[jwt],
				});
			}
			if (path === "/api/spaces") {
				return jsonReply(call, { spaces: [] });
			}
			if (path === "/api/healing/config") {
				return jsonReply(call, healing);
			}
			throw new Error("Peer branch not implemented");
		} catch (error) {
			fixtureErrors.push(errorText(error));
			return NativeResponse.json(
				{ error: "Finite native peer refused undeclared input" },
				{ status: 500 }
			);
		} finally {
			live.activeHandlers -= 1;
			pulse();
		}
	},
});
live.ownedOrigin = server.url.origin;
if (ownsDom) {
	GlobalRegistrator.register({ url: `${live.ownedOrigin}/mounted-general` });
}
export const priorWindowFetchDescriptor = Object.getOwnPropertyDescriptor(
	window,
	"fetch"
);
export const savedStorage = storageSnapshot();
for (const [key, value] of Object.entries(localConservation)) {
	localStorage.setItem(key, value);
}
localStorage.removeItem("ryu_session_token");
localStorage.removeItem("ryu_oidc_user");
localStorage.setItem("ryu:product-analytics-enabled", "false");
localStorage.setItem("ryu:crash-reports-enabled", "false");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Return unchanged native promises from body methods; the ledger only observes
// their completion. A received503 remains503 and its original parser error path.
export function observeBody<T>(
	call: Exchange,
	promise: Promise<T>,
	extractText: (value: T) => string
) {
	live.activeBodies += 1;
	void promise.then(
		(value) => {
			try {
				if (call.bodyConsumed) {
					throw new Error(`Duplicate body receipt ${call.id}`);
				}
				const text = extractText(value);
				if (text !== call.responseText) {
					throw new Error(`Body bytes differ at ${call.id}`);
				}
				call.bodyConsumed = true;
			} catch (error) {
				bodyErrors.push(errorText(error));
			} finally {
				live.activeBodies -= 1;
				pulse();
			}
		},
		(error) => {
			bodyErrors.push(errorText(error));
			live.activeBodies -= 1;
			pulse();
		}
	);
	return promise;
}
export const guardedFetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const nativeRequest = new NativeRequest(input, init);
		const url = new URL(nativeRequest.url);
		if (url.origin !== live.ownedOrigin) {
			unexpectedDestinations.push(url.href);
			throw new Error("General consumer proof refuses unowned egress");
		}
		live.activeFetches += 1;
		pulse();
		try {
			const response = await nativeFetch(nativeRequest);
			const id = Number(response.headers.get("x-general-proof-response-id"));
			const call = calls.find((entry) => entry.id === id);
			if (!call) {
				throw new Error("Native response has no admitted request/body ID");
			}
			if (response.status !== call.status) {
				throw new Error("Native response status differs");
			}
			const text = response.text.bind(response);
			const json = response.json.bind(response);
			response.text = () => observeBody(call, text(), (value) => value);
			response.json = () =>
				observeBody(call, json(), (value) => {
					const text = JSON.stringify(value);
					if (typeof text !== "string") {
						throw new Error(
							"Native JSON body cannot represent the admitted response"
						);
					}
					return text;
				});
			return response;
		} catch (error) {
			fetchErrors.push(errorText(error));
			throw error;
		} finally {
			live.activeFetches -= 1;
			pulse();
		}
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = guardedFetch;
window.fetch = guardedFetch;
export const windowError = (event: ErrorEvent) => {
	runtimeErrors.push(event.message || errorText(event.error));
	pulse();
};
export const windowRejection = (event: PromiseRejectionEvent) => {
	runtimeErrors.push(errorText(event.reason));
	pulse();
};
window.addEventListener("error", windowError);
window.addEventListener("unhandledrejection", windowRejection);

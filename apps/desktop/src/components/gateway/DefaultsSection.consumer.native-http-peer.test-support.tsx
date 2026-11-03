import {
	allowed,
	bodyReadStarts,
	bodyReads,
	type Call,
	calls,
	cloudKey,
	entitlementKeys,
	holdNativeJsonBody,
	idleKey,
	independentlyReadRecords,
	live,
	localKey,
	NativeRequest,
	NativeResponse,
	nativeBodyObservations,
	nativeExchanges,
	nativeFetch,
	nativeResponseText,
	notifyTransportChange,
	persistRecords,
	preferenceBody,
	recordBody,
	returnedBodies,
	transportErrors,
	unexpected,
} from "./DefaultsSection.consumer.native-http-store.test-support.tsx";

export const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		live.activeHandlers += 1;
		const url = new URL(request.url);
		const bearer = request.headers.get("authorization");
		const delegation = request.headers.get("x-ryu-user-jwt");
		const owner = allowed.get(`${bearer}|${delegation}`) ?? null;
		const call: Call = {
			id: ++live.nextCallId,
			owner,
			url: request.url,
			method: request.method,
			bearer,
			delegation,
			clientId: request.headers.get("x-ryu-client-id"),
			body: null,
			status: 0,
		};
		calls.push(call);
		const send = (status: number, body: unknown) => {
			call.status = status;
			return NativeResponse.json(body, {
				status,
				headers: { "x-defaults-proof-call": String(call.id) },
			});
		};
		const refuse = (reason: string, status = 422) => {
			unexpected.push(reason);
			return send(status, { error: reason });
		};
		try {
			const raw = await request.text();
			call.body = recordBody(raw);
			const routeOwner = url.pathname.startsWith("/node/api/")
				? "a"
				: url.pathname.startsWith("/foreign/api/")
					? "foreign"
					: null;
			if (
				url.origin !== server.url.origin ||
				routeOwner === null ||
				owner !== routeOwner ||
				request.headers.get("x-ryu-buyer-token") !== null ||
				call.clientId !== "defaults-proof-client" ||
				request.headers.get("content-type") !== "application/json"
			) {
				return refuse(
					`Undeclared admission ${request.method} ${request.url}`,
					401
				);
			}
			const route = url.pathname.slice(
				routeOwner === "a" ? "/node".length : "/foreign".length
			);
			if (route === "/api/gateway/audit") {
				if (
					request.method !== "GET" ||
					url.search !== "?limit=50" ||
					raw !== ""
				) {
					return refuse("Undeclared audit request");
				}
				return send(200, { reachable: true, entries: [], count: 0 });
			}
			if (url.search !== "") {
				return refuse(`Undeclared query ${url.search}`);
			}
			if (route.startsWith("/api/preferences/")) {
				const key = decodeURIComponent(route.slice("/api/preferences/".length));
				if (
					!(
						[localKey, cloudKey, idleKey].includes(key) ||
						entitlementKeys.has(key)
					)
				) {
					return refuse(`Undeclared preference ${key}`);
				}
				if (request.method === "GET" && raw === "") {
					const persisted = await independentlyReadRecords();
					const body = { key, value: persisted[routeOwner][key] ?? null };
					if (
						key === localKey &&
						routeOwner === "a" &&
						live.refuseLocalReadCredentials !== null &&
						bearer === live.refuseLocalReadCredentials.bearer &&
						delegation === live.refuseLocalReadCredentials.delegation
					) {
						return send(503, { error: "Owned preference read refused" });
					}
					if (
						key === localKey &&
						routeOwner === "a" &&
						live.holdLocalReadCredentials !== null &&
						bearer === live.holdLocalReadCredentials.bearer &&
						delegation === live.holdLocalReadCredentials.delegation
					) {
						return holdNativeJsonBody(call, body);
					}
					return send(200, body);
				}
				if (request.method !== "PUT" || !preferenceBody(call.body)) {
					return refuse("Undeclared preference write");
				}
				if (key !== localKey && !entitlementKeys.has(key)) {
					return refuse(`Undeclared writable preference ${key}`);
				}
				if (key === localKey && live.refusedLocalWrites > 0) {
					live.refusedLocalWrites -= 1;
					return send(503, { error: "Owned preference write refused" });
				}
				live.records[routeOwner][key] = call.body.value;
				await persistRecords();
				return send(200, { ok: true, key });
			}
			if (request.method === "GET" && raw === "") {
				if (route === "/api/agents") {
					return send(200, { agents: [] });
				}
				if (route === "/api/engines") {
					return send(200, { engines: [] });
				}
				if (route === "/api/engine/active") {
					return send(200, { active: null, running: false, available: [] });
				}
				if (route === "/api/pi-config/catalog") {
					return send(200, { apiTypes: [], providers: [], thinkingLevels: [] });
				}
				if (route === "/api/gateway/evaluators") {
					return send(200, { evaluators: [] });
				}
			}
			if (route === "/api/gateway/evals/run" && request.method === "POST") {
				const expectedBody = {
					agent_id: null,
					model: JSON.parse(
						(await independentlyReadRecords())[routeOwner][localKey] ?? "{}"
					).model,
					dataset: [],
					evaluators: [],
					code_evaluators: [],
				};
				if (JSON.stringify(call.body) !== JSON.stringify(expectedBody)) {
					return refuse(
						"Eval consumer sent an undeclared default or request body"
					);
				}
				// This proves the real run client/error consumer, not an inference result.
				return send(503, { error: "Owned inference provider unavailable" });
			}
			return refuse(`Undeclared route ${request.method} ${route}`, 404);
		} finally {
			live.activeHandlers -= 1;
		}
	},
});

// Observe the SDK's genuine awaited text read without changing its bytes or
// status. The response belongs to the native HTTP connection, not a mock fetch.
NativeResponse.prototype.text = function (this: Response) {
	const id = this.headers.get("x-defaults-proof-call");
	if (id !== null) {
		bodyReadStarts.push(Number(id));
	}
	const observation = (async () => {
		const text = await nativeResponseText.call(this);
		if (id !== null) {
			bodyReads.push({ id: Number(id), status: this.status, text });
		}
		return text;
	})();
	nativeBodyObservations.add(observation);
	const complete = () => {
		nativeBodyObservations.delete(observation);
		if (id !== null) {
			returnedBodies.delete(Number(id));
		}
		notifyTransportChange();
	};
	void observation.then(complete, (error: unknown) => {
		transportErrors.push(
			`Native body ${id ?? "unidentified"}: ${String(error)}`
		);
		complete();
	});
	return observation;
};
globalThis.fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new NativeRequest(input, init);
		if (new URL(request.url).origin !== server.url.origin) {
			unexpected.push(`Unowned fetch ${request.method} ${request.url}`);
			throw new Error("Refused unowned defaults proof destination");
		}
		const exchange = nativeFetch(request);
		nativeExchanges.add(exchange);
		try {
			const response = await exchange;
			const id = response.headers.get("x-defaults-proof-call");
			if (id !== null) {
				returnedBodies.add(Number(id));
			}
			return response;
		} catch (error) {
			transportErrors.push(
				`Native exchange ${request.method} ${request.url}: ${String(error)}`
			);
			throw error;
		} finally {
			nativeExchanges.delete(exchange);
			notifyTransportChange();
		}
	},
	{
		preconnect: (...args: Parameters<typeof nativeFetch.preconnect>) => {
			if (new URL(String(args[0])).origin !== server.url.origin) {
				unexpected.push(`Unowned preconnect ${String(args[0])}`);
				throw new Error("Refused unowned defaults proof preconnect");
			}
			return nativeFetch.preconnect(...args);
		},
	}
);
export const previousBackend = process.env.VITE_APP_BACKEND_URL;
process.env.VITE_APP_BACKEND_URL = server.url.origin;
export const { createRoot } = await import("react-dom/client");

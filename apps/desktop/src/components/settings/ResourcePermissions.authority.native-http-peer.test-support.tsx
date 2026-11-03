import {
	admittedCredentials,
	bodyReads,
	bodyStarts,
	type Call,
	calls,
	clientId,
	exchanges,
	type HeldBody,
	heldBodies,
	live,
	NativeReadableStream,
	NativeRequest,
	NativeResponse,
	NativeTextEncoder,
	nativeFetch,
	nativeResponseText,
	notify,
	type Overwrite,
	type Owner,
	observations,
	otherResourceId,
	otherResourcePath,
	principals,
	publish,
	readPhysical,
	resourceId,
	resourcePath,
	spaceResourceKey,
	spaceResourcePath,
	transportErrors,
	unexpected,
	unreadIds,
	validRows,
	vocabulary,
} from "./ResourcePermissions.authority.native-http-store.test-support.tsx";

export const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		live.activeHandlers += 1;
		const url = new URL(request.url);
		const prefix = url.pathname.split("/")[1];
		const owner: Owner | null =
			prefix === "a" || prefix === "b" || prefix === "foreign" ? prefix : null;
		const call: Call = {
			id: ++live.nextId,
			owner,
			method: request.method,
			url: request.url,
			bearer: request.headers.get("authorization"),
			delegation: request.headers.get("x-ryu-user-jwt"),
			rawBody: "",
			body: null,
			status: 0,
			reply: null,
			handlerTerminal: false,
		};
		calls.push(call);
		const reply = (body: unknown, status = 200, hold = false): Response => {
			const text = JSON.stringify(body);
			call.status = status;
			call.reply = text;
			const headers = {
				"content-type": "application/json",
				"x-permissions-proof-call": String(call.id),
			};
			if (!hold) {
				return new NativeResponse(text, { status, headers });
			}
			const bytes = new NativeTextEncoder().encode(text);
			let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
			const held: HeldBody = {
				id: call.id,
				released: false,
				cancelled: null,
				release() {
					if (held.released || held.cancelled !== null) {
						return;
					}
					if (!controller) {
						throw new Error("Missing native held-body controller");
					}
					controller.enqueue(bytes.subarray(1));
					controller.close();
					held.released = true;
					notify();
				},
			};
			const stream = new NativeReadableStream<Uint8Array>({
				start(next) {
					controller = next;
					next.enqueue(bytes.subarray(0, 1));
				},
				cancel(reason: unknown) {
					held.cancelled = String(reason);
					transportErrors.push(
						`Native held body ${call.id} cancelled: ${String(reason)}`
					);
					notify();
				},
			});
			heldBodies.push(held);
			return new NativeResponse(stream, { status, headers });
		};
		const refuse = (reason: string, status = 400) => {
			unexpected.push(`${call.id} ${request.method} ${request.url}: ${reason}`);
			return reply({ error: reason }, status);
		};
		try {
			const raw = await request.text();
			call.rawBody = raw;
			if (raw !== "") {
				try {
					call.body = JSON.parse(raw);
				} catch {
					return refuse("Malformed permission JSON");
				}
			}
			if (
				!owner ||
				url.origin !== server.url.origin ||
				url.search !== "" ||
				url.hash !== ""
			) {
				return refuse("Unowned authority or query");
			}
			const identityNames = [...request.headers.keys()]
				.filter((name) => name.startsWith("x-ryu-"))
				.sort();
			if (
				request.headers.get("content-type") !== "application/json" ||
				request.headers.get("origin") !== null ||
				identityNames.join("|") !==
					"x-ryu-client-id|x-ryu-client-label|x-ryu-surface|x-ryu-user-jwt" ||
				request.headers.get("x-ryu-client-id") !== clientId ||
				request.headers.get("x-ryu-client-label") !== "Desktop" ||
				request.headers.get("x-ryu-surface") !== "desktop"
			) {
				return refuse("Unexpected permission identity headers");
			}
			if (!admittedCredentials(owner, call.bearer, call.delegation)) {
				return refuse("Wrong node credential tuple", 401);
			}
			const path = url.pathname.slice(`/${owner}`.length);
			if (request.method === "GET" && raw !== "") {
				return refuse("Read body is not empty");
			}
			if (path === "/api/acl/vocabulary" && request.method === "GET") {
				return reply(vocabulary());
			}
			if (path === "/api/acl/principals" && request.method === "GET") {
				return reply(principals(owner));
			}
			if (
				path !== resourcePath &&
				path !== otherResourcePath &&
				path !== spaceResourcePath
			) {
				return refuse("Undeclared ACL route", 404);
			}
			const id =
				path === resourcePath
					? resourceId
					: path === otherResourcePath
						? otherResourceId
						: spaceResourceKey;
			const kind = path === spaceResourcePath ? "space" : "agent";
			if (request.method !== "GET" && request.method !== "PUT") {
				return refuse("Undeclared ACL method", 405);
			}
			if (
				request.method === "PUT" &&
				((path !== resourcePath && path !== spaceResourcePath) ||
					!call.body ||
					typeof call.body !== "object" ||
					Array.isArray(call.body) ||
					Object.keys(call.body).join("|") !== "overwrites" ||
					!validRows(Reflect.get(call.body, "overwrites")))
			) {
				return refuse("Unexpected whole-set ACL write");
			}
			const plan = live.holdPlan;
			const held = Boolean(
				plan &&
					path === (plan.path ?? resourcePath) &&
					plan.owner === owner &&
					plan.method === request.method &&
					`Bearer ${plan.bearer}` === call.bearer &&
					plan.delegation === call.delegation
			);
			if (held) {
				live.holdPlan = null;
			}
			if (held && plan?.status === 503) {
				return reply({ error: "Owned ACL peer unavailable" }, 503, true);
			}
			if (request.method === "PUT") {
				const body = call.body as { overwrites: Overwrite[] };
				await publish((previous) => {
					if (!previous) {
						throw new Error("Missing initialized ACL receipt");
					}
					return {
						...previous,
						[owner]: {
							...previous[owner],
							[id]: structuredClone(body.overwrites),
						},
					};
				});
				return reply({ ok: true }, 200, held);
			}
			// Every GET independently opens the committed file, including fresh
			// renderer reads. Same-node credentials never own separate ACL records.
			const physical = await readPhysical();
			return reply(
				{
					kind,
					id: kind === "space" ? resourceId : id,
					overwrites: physical[owner][id],
				},
				200,
				held
			);
		} catch (error) {
			transportErrors.push(`Native handler ${call.id}: ${String(error)}`);
			return reply(
				{ error: "Owned ACL fixture publication/read failure" },
				500
			);
		} finally {
			call.handlerTerminal = true;
			live.activeHandlers -= 1;
			notify();
		}
	},
});

// Passive observation delegates the actual Bun body decoder. The response's
// declared physical ID joins bytes/status consumed by the genuine SDK.
NativeResponse.prototype.text = function (this: Response) {
	const raw = this.headers.get("x-permissions-proof-call");
	const id = raw === null ? null : Number(raw);
	if (id !== null) {
		bodyStarts.push(id);
	}
	const observation = (async () => {
		const text = await nativeResponseText.call(this);
		if (id !== null) {
			bodyReads.push({ id, status: this.status, text });
		}
		return text;
	})();
	observations.add(observation);
	const complete = () => {
		observations.delete(observation);
		if (id !== null) {
			unreadIds.delete(id);
		}
		notify();
	};
	void observation.then(complete, (error: unknown) => {
		transportErrors.push(`Native decoder ${id}: ${String(error)}`);
		complete();
	});
	return observation;
};
globalThis.fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new NativeRequest(input, init);
		if (new URL(request.url).origin !== server.url.origin) {
			unexpected.push(`Unowned fetch ${request.method} ${request.url}`);
			throw new Error("Refused unowned permission destination");
		}
		const exchange = nativeFetch(request);
		exchanges.add(exchange);
		try {
			const response = await exchange;
			const id = response.headers.get("x-permissions-proof-call");
			if (id === null) {
				throw new Error("Native peer returned no physical response identity");
			}
			unreadIds.add(Number(id));
			return response;
		} catch (error) {
			transportErrors.push(
				`Native exchange ${request.method} ${request.url}: ${String(error)}`
			);
			throw error;
		} finally {
			exchanges.delete(exchange);
			notify();
		}
	},
	{
		preconnect: (...args: Parameters<typeof nativeFetch.preconnect>) => {
			if (new URL(String(args[0])).origin !== server.url.origin) {
				unexpected.push(`Unowned preconnect ${String(args[0])}`);
				throw new Error("Refused unowned permission preconnect");
			}
			return nativeFetch.preconnect(...args);
		},
	}
);
export const previousBackend = process.env.VITE_APP_BACKEND_URL;
process.env.VITE_APP_BACKEND_URL = server.url.origin;

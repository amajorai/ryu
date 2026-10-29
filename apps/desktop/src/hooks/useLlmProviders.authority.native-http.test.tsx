import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Node } from "@/src/store/useNodeStore.ts";
const nativeFetch = globalThis.fetch,
	NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { useLlmProviders } = await import("./useLlmProviders.ts");
const { usePiConfig } = await import("./usePiConfig.ts");
const { renameProviderAccount } = await import("@/src/lib/api/pi-config.ts");
const initial = useNodeStore.getState();
type Slot = "A" | "B";
let mode: "url" | "token" | "jwt" = "url",
	hold = false,
	holdAfter = false,
	refuse = false,
	release: (() => void) | null = null;
let labels: Record<Slot, string> = {
	A: "A saved account",
	B: "B saved account",
};
const calls: Array<{
	slot: Slot;
	method: string;
	path: string;
	body: unknown;
	authorization: string | null;
	jwt: string | null;
}> = [];
let refuseRead = false;
let holdRead = false,
	readRelease: (() => void) | null = null,
	completedReads = 0;
const unexpected: string[] = [];
const settled: string[] = [];
function nodes(): Node[] {
	return ["A", "B"].map((name) => ({
		name,
		url: server.url.origin + (mode === "url" ? `/${name}` : "/shared"),
		token: mode === "jwt" ? "shared-token" : `token-${name}`,
		userJwt: mode === "token" ? "shared-jwt" : `jwt-${name}`,
	}));
}
function catalog(slot: Slot) {
	return {
		apiTypes: ["openai-completions"],
		thinkingLevels: [],
		providers: [
			{
				id: "custom/service",
				label: `${slot} provider`,
				api: "openai-completions",
				authEnv: "",
				authKind: "api-key",
				configured: true,
				custom: true,
				routing: "direct",
				suggestedModels: [],
				accounts: [
					{
						accountId: `${slot}-account`,
						label: labels[slot],
						active: true,
						gatewayActive: false,
						kind: "api_key",
						updatedAt: 1,
					},
				],
			},
		],
	};
}
const server: Bun.Server<undefined> = Bun.serve<undefined>({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const target = nodes().find(
			(n) =>
				new URL(n.url).pathname === url.pathname.split("/api/")[0] &&
				request.headers.get("authorization") === `Bearer ${n.token}` &&
				request.headers.get("x-ryu-user-jwt") === n.userJwt
		);
		const slot = target?.name;
		const path = url.pathname.slice(url.pathname.indexOf("/api/"));
		const body =
			request.method === "POST" || request.method === "PUT"
				? await request.json()
				: null;
		if (
			(slot !== "A" && slot !== "B") ||
			!(
				(request.method === "GET" &&
					(path === "/api/pi-config" || path === "/api/pi-config/catalog")) ||
				(request.method === "POST" &&
					path ===
						"/api/pi-config/providers/custom%2Fservice/accounts/rename" &&
					body?.accountId === `${slot}-account` &&
					typeof body?.label === "string") ||
				(request.method === "PUT" &&
					path === "/api/pi-config" &&
					body?.provider === `${slot}-provider` &&
					body?.model === null)
			)
		) {
			unexpected.push(`${request.method} ${url.pathname}`);
			return NativeResponse.json(
				{ error: "Unexpected actual provider request" },
				{ status: 400 }
			);
		}
		calls.push({
			slot,
			method: request.method,
			path,
			body,
			authorization: request.headers.get("authorization"),
			jwt: request.headers.get("x-ryu-user-jwt"),
		});
		if (request.method === "PUT") {
			if (hold) {
				hold = false;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return NativeResponse.json(
				refuse
					? { error: "Finite old provider save refusal" }
					: {
							config: {
								provider: `${slot}-provider`,
								model: null,
								routing: "direct",
								thinkingLevel: null,
								configDir: "owned",
							},
						},
				{ status: refuse ? 503 : 200 }
			);
		}
		if (request.method === "POST") {
			let response;
			if (holdAfter) {
				labels[slot] = body.label;
				response = catalog(slot);
			}
			if (hold) {
				hold = false;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			if (!response) {
				labels[slot] = body.label;
				response = catalog(slot);
			}
			return NativeResponse.json(response);
		}
		if (path.endsWith("/catalog") && refuseRead)
			return NativeResponse.json(
				{ error: "Finite fresh catalog refused" },
				{ status: 503 }
			);
		if (path.endsWith("/catalog") && holdRead) {
			holdRead = false;
			const snapshot = catalog(slot);
			await new Promise<void>((resolve) => {
				readRelease = resolve;
			});
			completedReads++;
			return NativeResponse.json(snapshot);
		}
		return NativeResponse.json(
			path.endsWith("/catalog")
				? catalog(slot)
				: {
						config: {
							provider: `${slot}-provider`,
							model: null,
							routing: "direct",
							thinkingLevel: null,
							configDir: "owned",
						},
					}
		);
	},
});
function select(slot: Slot) {
	useNodeStore.setState({
		nodes: nodes(),
		defaultNode: slot,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
}
function Consumer() {
	const p = useLlmProviders(),
		pi = usePiConfig();
	return (
		<>
			<output data-testid="read-error">{p.error ?? "none"}</output>
			<output data-testid="loading">{String(p.loading)}</output>
			<output data-testid="mutating">{String(p.mutating)}</output>
			<output data-testid="saving">{String(pi.saving)}</output>
			<output data-testid="save-error">{pi.saveError ?? "none"}</output>
			<output data-testid="catalog">
				{p.catalog?.providers[0]?.accounts?.[0]?.label ?? "loading"}
			</output>
			<output data-testid="pi-catalog">
				{pi.catalog?.providers[0]?.accounts?.[0]?.label ?? "loading"}
			</output>
			<button type="button" onClick={() => select("A")}>
				A
			</button>
			<button type="button" onClick={() => select("B")}>
				B
			</button>
			<button type="button" onClick={() => p.reload()}>
				Reload
			</button>
			<button
				type="button"
				onClick={() => {
					void p
						.renameAccount("custom/service", "A-account", "A accepted rename")
						.then(() => settled.push("old"))
						.catch(() => undefined);
				}}
			>
				Rename A
			</button>
			<button
				type="button"
				onClick={() => {
					void p
						.renameAccount("custom/service", "A-account", "A newest rename")
						.then(() => settled.push("new"))
						.catch(() => undefined);
				}}
			>
				New rename A
			</button>
			<button
				type="button"
				onClick={() => {
					void pi
						.save({ provider: "A-provider", model: null })
						.then(() => settled.push("save accepted"))
						.catch(() => settled.push("save refused"));
				}}
			>
				Save A
			</button>
			<button
				type="button"
				onClick={() => {
					void p
						.activate({ provider: "A-provider", model: null })
						.then(() => settled.push("activate accepted"))
						.catch(() => settled.push("activate refused"));
					flushSync(() => select("B"));
				}}
			>
				Activate then B
			</button>
			<button
				type="button"
				onClick={() => {
					void pi
						.save({ provider: "A-provider", model: null })
						.then(() => settled.push("save accepted"))
						.catch(() => settled.push("save refused"));
					flushSync(() => select("B"));
				}}
			>
				Save then B
			</button>
		</>
	);
}
let root: Root,
	container: HTMLDivElement,
	client: InstanceType<typeof QueryClient>;
async function until(check: () => boolean) {
	for (let i = 0; i < 80; i++) {
		await act(async () => {
			await Bun.sleep(5);
		});
		if (check()) return;
	}
	expect(check()).toBe(true);
}
async function click(name: string) {
	const button = [...container.querySelectorAll("button")].find(
		(b) => b.textContent === name
	);
	if (!button) throw new Error(`Missing actual hook control ${name}`);
	await act(async () => {
		button.click();
	});
}
function text(id: string) {
	return container.querySelector(`[data-testid="${id}"]`)?.textContent;
}
async function mount() {
	select("A");
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity },
			mutations: { retry: false },
		},
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Consumer />
			</QueryClientProvider>
		);
	});
	await until(
		() =>
			text("catalog") === "A saved account" &&
			text("pi-catalog") === "A saved account"
	);
}
beforeEach(() => {
	calls.length = 0;
	unexpected.length = 0;
	labels = { A: "A saved account", B: "B saved account" };
	hold = false;
	holdAfter = false;
	refuse = false;
	release = null;
	settled.length = 0;
	holdRead = false;
	refuseRead = false;
	readRelease = null;
	completedReads = 0;
});
afterEach(async () => {
	if (readRelease) {
		readRelease();
		readRelease = null;
		await act(async () => {
			await Bun.sleep(10);
		});
	}
	if (release) {
		release();
		release = null;
		await act(async () => {
			await Bun.sleep(10);
		});
	}
	if (root)
		await act(async () => {
			root.unmount();
		});
	container?.remove();
	client?.clear();
	useNodeStore.setState(initial, true);
	expect(unexpected).toEqual([]);
});
afterAll(() => server.stop(true));
for (const authority of ["token", "jwt"] as const) {
	test(`both actual provider hooks isolate a same-URL ${authority} change`, async () => {
		mode = authority;
		await mount();
		await click("B");
		await until(
			() =>
				text("catalog") === "B saved account" &&
				text("pi-catalog") === "B saved account"
		);
		expect(
			calls.filter((c) => c.slot === "B" && c.path === "/api/pi-config/catalog")
		).toHaveLength(1);
		expect(text("catalog")).not.toContain("A");
	});
	test(`held old ${authority} rename cannot replace current owner's reloaded catalog`, async () => {
		mode = authority;
		await mount();
		hold = true;
		await click("Rename A");
		await until(() => release !== null);
		await click("B");
		await click("Reload");
		await until(
			() =>
				text("catalog") === "B saved account" &&
				text("pi-catalog") === "B saved account"
		);
		const acknowledge = release;
		release = null;
		if (!acknowledge) throw new Error("Missing real held POST");
		acknowledge();
		await until(() => settled.includes("old"));
		expect(text("catalog")).toBe("B saved account");
		expect(text("pi-catalog")).toBe("B saved account");
		expect(calls.filter((c) => c.method === "POST")).toEqual([
			{
				slot: "A",
				method: "POST",
				path: "/api/pi-config/providers/custom%2Fservice/accounts/rename",
				body: { accountId: "A-account", label: "A accepted rename" },
				authorization:
					authority === "jwt" ? "Bearer shared-token" : "Bearer token-A",
				jwt: authority === "token" ? "shared-jwt" : "jwt-A",
			},
		]);
	});
}

test("both actual provider hooks isolate a URL change and still share one catalog fetch", async () => {
	mode = "url";
	await mount();
	await click("B");
	await until(
		() =>
			text("catalog") === "B saved account" &&
			text("pi-catalog") === "B saved account"
	);
	expect(
		calls.filter((c) => c.slot === "B" && c.path === "/api/pi-config/catalog")
	).toHaveLength(1);
});

for (const authority of ["token", "jwt"] as const) {
	test(`returning ${authority} authority waits for old rename and reloads actual server state before editing`, async () => {
		mode = authority;
		await mount();
		hold = true;
		holdAfter = true;
		await click("Rename A");
		await until(() => release !== null);
		await click("B");
		await click("Reload");
		await until(() => text("catalog") === "B saved account");
		await click("A");
		expect(text("mutating")).toBe("true");
		expect(text("catalog")).toBe("loading");
		expect(text("pi-catalog")).toBe("loading");
		await click("New rename A");
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
		const a = nodes().find((n) => n.name === "A");
		if (!a) throw new Error("Missing actual A authority");
		await renameProviderAccount(
			a,
			"custom/service",
			"A-account",
			"A server-current account"
		);
		const gets = calls.filter(
			(c) => c.slot === "A" && c.path.endsWith("catalog")
		).length;
		const acknowledge = release;
		release = null;
		if (!acknowledge) throw new Error("Missing held actual response");
		acknowledge();
		await until(
			() =>
				settled.includes("old") &&
				text("catalog") === "A server-current account" &&
				text("pi-catalog") === "A server-current account"
		);
		expect(
			calls.filter((c) => c.slot === "A" && c.path.endsWith("catalog")).length
		).toBeGreaterThan(gets);
		expect(text("mutating")).toBe("false");
		await click("New rename A");
		await until(
			() => settled.includes("new") && text("catalog") === "A newest rename"
		);
		expect(labels.A).toBe("A newest rename");
		await click("Reload");
		await until(() => text("pi-catalog") === "A newest rename");
	});
	test(`old ${authority} config save pending and refusal do not block or expose errors on B`, async () => {
		mode = authority;
		await mount();
		hold = true;
		refuse = true;
		await click("Save A");
		await until(() => release !== null);
		expect(text("saving")).toBe("true");
		await click("B");
		await click("Reload");
		await until(() => text("catalog") === "B saved account");
		expect(text("saving")).toBe("false");
		expect(text("save-error")).toBe("none");
		const acknowledge = release;
		release = null;
		if (!acknowledge) throw new Error("Missing actual PUT");
		acknowledge();
		await until(() => settled.includes("save refused"));
		expect(text("save-error")).toBe("none");
		expect(text("catalog")).toBe("B saved account");
	});
}

for (const operation of ["Activate", "Save"] as const) {
	test(`same-turn actual ${operation} invocation keeps the clicked A HTTP authority`, async () => {
		mode = "token";
		await mount();
		await click(`${operation} then B`);
		await until(() =>
			settled.includes(
				operation === "Activate" ? "activate accepted" : "save accepted"
			)
		);
		expect(calls.filter((c) => c.method === "PUT")).toEqual([
			{
				slot: "A",
				method: "PUT",
				path: "/api/pi-config",
				body: { provider: "A-provider", model: null },
				authorization: "Bearer token-A",
				jwt: "shared-jwt",
			},
		]);
	});
}

test("an accepted account rename survives an older in-flight background catalog response", async () => {
	mode = "url";
	await mount();
	holdRead = true;
	await click("Reload");
	await until(() => readRelease !== null);
	await click("Rename A");
	await until(
		() => settled.includes("old") && text("catalog") === "A accepted rename"
	);
	const acknowledge = readRelease;
	readRelease = null;
	if (!acknowledge) throw new Error("Missing actual held catalog GET");
	acknowledge();
	await until(
		() =>
			completedReads === 1 &&
			client
				.getQueryCache()
				.findAll({ queryKey: ["pi-config-catalog", server.url.origin + "/A"] })
				.every((query) => query.state.fetchStatus !== "fetching")
	);
	expect(text("catalog")).toBe("A accepted rename");
	expect(text("pi-catalog")).toBe("A accepted rename");
	expect(labels.A).toBe("A accepted rename");
	await click("Reload");
	await until(
		() =>
			text("catalog") === "A accepted rename" &&
			text("pi-catalog") === "A accepted rename"
	);
});

for (const authority of ["token", "jwt"] as const) {
	test(`returning ${authority} refresh refusal hides cached accounts, refuses editing and recovers by reload`, async () => {
		mode = authority;
		await mount();
		hold = true;
		holdAfter = true;
		await click("Rename A");
		await until(() => release !== null);
		await click("B");
		await click("Reload");
		await until(() => text("catalog") === "B saved account");
		await click("A");
		refuseRead = true;
		const acknowledge = release;
		release = null;
		if (!acknowledge) throw new Error("Missing held mutation acknowledgement");
		acknowledge();
		await until(
			() =>
				settled.includes("old") && text("read-error")?.includes("503") === true
		);
		expect(text("catalog")).toBe("loading");
		expect(text("pi-catalog")).toBe("loading");
		expect(text("loading")).toBe("false");
		const writes = calls.filter((c) => c.method === "POST").length;
		await click("New rename A");
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(writes);
		expect(labels.A).toBe("A accepted rename");
		refuseRead = false;
		await click("Reload");
		await until(
			() =>
				text("catalog") === "A accepted rename" &&
				text("pi-catalog") === "A accepted rename"
		);
		expect(text("read-error")).toBe("none");
		await click("New rename A");
		await until(
			() => settled.includes("new") && text("catalog") === "A newest rename"
		);
		expect(labels.A).toBe("A newest rename");
	});
}

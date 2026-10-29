import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentType } from "react";
import type { Root } from "react-dom/client";
import { sileo } from "sileo";

const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
const nativeFetch = globalThis.fetch;
const priorBackend = process.env.NEXT_PUBLIC_SERVER_URL;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
interface NativeSession {
	createdAt: Date;
	expiresAt: Date;
	id: string;
	token: string;
	userAgent: string;
	userId: string;
}
let identity = { id: "older-current", token: "older-current-token" };
let sessions: NativeSession[] = [];
let refuse = false;
let held = false;
let release: (() => void) | undefined;
const calls: Array<{
	method: string;
	path: string;
	authorization: string | null;
	status: number;
}> = [];
const authRevocations: string[] = [];
mock.module("@ryu/auth", () => ({
	auth: {
		api: {
			listSessions: async () => sessions.map((session) => ({ ...session })),
			revokeSession: async ({ body }: { body: { token: string } }) => {
				if (held) {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				}
				if (refuse) {
					throw new Error("Selected session revocation refused");
				}
				authRevocations.push(body.token);
				sessions = sessions.filter((session) => session.token !== body.token);
			},
			revokeOtherSessions: async () => {
				if (held) {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				}
				if (refuse) {
					throw new Error("Other sessions revocation refused");
				}
				sessions = sessions.filter(
					(session) => session.token === identity.token
				);
			},
		},
	},
}));
mock.module(
	new URL("../../../../../packages/api/src/request-context.ts", import.meta.url)
		.pathname,
	() => ({
		createContext: async ({
			context,
		}: {
			context: { req: { raw: Request } };
		}) => ({
			session:
				context.req.raw.headers.get("authorization") ===
				`Bearer ${identity.token}`
					? { user: { id: "signed-in-user" }, session: { ...identity } }
					: null,
		}),
		requireAuth: (context: { session: unknown }) => {
			if (!context.session) {
				throw new Error("Unexpected account authority");
			}
			return context;
		},
	})
);
const { sessionsRouter } = await import(
	"../../../../../packages/api/src/routers/sessions.ts"
);
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request) => {
		const path = new URL(request.url).pathname;
		if (
			!(
				[
					"/api/sessions",
					"/api/sessions/newer-remote",
					"/api/sessions/older-current",
				].includes(path) && ["GET", "DELETE"].includes(request.method)
			)
		) {
			throw new Error(`Unexpected route ${request.method} ${path}`);
		}
		const call = {
			method: request.method,
			path,
			authorization: request.headers.get("authorization"),
			status: 0,
		};
		calls.push(call);
		const routeUrl = new URL(request.url);
		routeUrl.pathname = path.slice("/api/sessions".length) || "/";
		const result = await sessionsRouter.fetch(
			new NativeRequest(routeUrl, {
				method: request.method,
				headers: request.headers,
			})
		);
		call.status = result.status;
		return new NativeResponse(await result.arrayBuffer(), {
			status: result.status,
			headers: result.headers,
		});
	},
});
process.env.NEXT_PUBLIC_SERVER_URL = server.url.origin;
const { configureSettingsApi } = await import("@ryu/settings");
configureSettingsApi({ getToken: () => identity.token });
const shared = await import(
	"../../../../../packages/settings/src/components/SessionsTab.tsx"
);
const desktop = await import("./SessionsTab.tsx");
const extension = await import(
	"../../../../../apps/extension/components/settings/SessionsTab.tsx"
);
const surfaces: [string, ComponentType][] = [
	["Web shared", shared.SessionsTab],
	["Desktop", desktop.SessionsTab],
	["Extension", extension.SessionsTab],
];
let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
function fixture(
	id: string,
	token: string,
	userAgent: string,
	date: string
): NativeSession {
	return {
		id,
		token,
		userAgent,
		userId: "signed-in-user",
		createdAt: new Date(date),
		expiresAt: new Date("2027-01-01"),
	};
}
beforeEach(() => {
	identity = { id: "older-current", token: "older-current-token" };
	sessions = [
		fixture(
			"older-current",
			identity.token,
			"Chrome current device",
			"2026-08-18"
		),
		fixture(
			"newer-remote",
			"remote-token",
			"Firefox remote device",
			"2026-08-20"
		),
	];
	calls.length = authRevocations.length = 0;
	refuse = held = false;
	release = undefined;
	container = document.createElement("div");
	document.body.append(container);
	errorToast = spyOn(sileo, "error");
});
afterEach(async () => {
	refuse = held = false;
	release?.();
	await act(async () => {
		root?.unmount();
	});
	root = undefined;
	client?.clear();
	container.remove();
	errorToast.mockRestore();
});
afterAll(() => {
	server.stop(true);
	mock.restore();
	globalThis.fetch = nativeFetch;
	if (priorBackend === undefined) {
		delete process.env.NEXT_PUBLIC_SERVER_URL;
	} else {
		process.env.NEXT_PUBLIC_SERVER_URL = priorBackend;
	}
});
async function until(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
		if (predicate()) {
			return;
		}
	}
	throw new Error(
		`Expected mounted session state did not settle: ${container.textContent}`
	);
}
async function render(Component: ComponentType) {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	root = createRoot(container);
	await act(async () => {
		root!.render(
			<QueryClientProvider client={client}>
				<Component />
			</QueryClientProvider>
		);
	});
	await until(
		() =>
			container.textContent?.includes("Firefox") === true ||
			container.textContent?.includes("Chrome") === true
	);
}
function button(name: string): HTMLButtonElement {
	const found = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find(
		(button) =>
			button.getAttribute("aria-label") === name ||
			button.textContent?.trim() === name
	);
	if (!found) {
		throw new Error(`Missing actual ${name} control`);
	}
	return found;
}
/** Opens the row's revoke confirmation and confirms it, as a user must. */
async function revokeWithConfirmation() {
	await act(async () => {
		button("Revoke session").click();
	});
	await until(() => document.querySelector('[role="alertdialog"]') !== null);
	const dialog = document.querySelector('[role="alertdialog"]');
	const confirm = [
		...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []),
	].find((candidate) => candidate.textContent?.trim() === "Revoke session");
	if (!confirm) {
		throw new Error("Missing revoke confirmation control");
	}
	await act(async () => {
		confirm.click();
	});
}
function writes() {
	return calls.filter((call) => call.method === "DELETE");
}
for (const [surface, Component] of surfaces) {
	test(`${surface}: older authenticated session stays current while the newer remote session refuses, retries, persists and reloads`, async () => {
		await render(Component);
		const rows = [...container.querySelectorAll("p,span")];
		expect(rows.some((node) => node.textContent === "This device")).toBe(true);
		const currentLabel = rows.find(
			(node) => node.textContent === "This device"
		);
		expect(currentLabel?.parentElement?.textContent).toContain("Chrome");
		expect(currentLabel?.parentElement?.textContent).not.toContain("Firefox");
		expect(
			container.querySelectorAll('[aria-label="Revoke session"]')
		).toHaveLength(1);
		held = refuse = true;
		await revokeWithConfirmation();
		await until(() => writes().length === 1 && release !== undefined);
		expect(writes()[0]).toMatchObject({
			method: "DELETE",
			path: "/api/sessions/newer-remote",
			authorization: "Bearer older-current-token",
			status: 0,
		});
		expect(button("Revoke session").disabled).toBe(true);
		await act(async () => {
			button("Revoke session").click();
		});
		expect(writes()).toHaveLength(1);
		expect(authRevocations).toEqual([]);
		await act(async () => {
			held = false;
			release!();
		});
		await until(
			() =>
				errorToast.mock.calls.length === 1 && !button("Revoke session").disabled
		);
		expect(writes()[0]?.status).toBe(500);
		expect(sessions.map((session) => session.id)).toEqual([
			"older-current",
			"newer-remote",
		]);
		expect(container.textContent).toContain("Firefox");
		refuse = false;
		await revokeWithConfirmation();
		await until(
			() =>
				container.querySelectorAll('[aria-label="Revoke session"]').length ===
					0 && !container.textContent?.includes("Firefox")
		);
		expect(writes().map(({ path, status }) => ({ path, status }))).toEqual([
			{ path: "/api/sessions/newer-remote", status: 500 },
			{ path: "/api/sessions/newer-remote", status: 200 },
		]);
		expect(authRevocations).toEqual(["remote-token"]);
		expect(sessions.map((session) => session.id)).toEqual(["older-current"]);
		await act(async () => {
			root!.unmount();
		});
		client.clear();
		await render(Component);
		expect(container.textContent).toContain("This device");
		expect(container.textContent).not.toContain("Firefox");
		expect(
			container.querySelectorAll('[aria-label="Revoke session"]')
		).toHaveLength(0);
		expect(
			calls.filter((call) => call.method === "GET").length
		).toBeGreaterThanOrEqual(3);
	});
	test(`${surface}: bulk cancellation writes nothing and refused retry preserves the older authenticated session`, async () => {
		await render(Component);
		await act(async () => {
			button("Revoke all others").click();
		});
		await act(async () => {
			button("Cancel").click();
		});
		expect(writes()).toEqual([]);
		held = refuse = true;
		await act(async () => {
			button("Revoke all others").click();
		});
		await act(async () => {
			button("Confirm").click();
		});
		await until(() => writes().length === 1 && release !== undefined);
		expect(writes()[0]).toMatchObject({
			path: "/api/sessions",
			authorization: "Bearer older-current-token",
			status: 0,
		});
		expect(sessions.map((session) => session.id)).toEqual([
			"older-current",
			"newer-remote",
		]);
		await act(async () => {
			held = false;
			release!();
		});
		await until(() => errorToast.mock.calls.length === 1);
		expect(writes()[0]?.status).toBe(500);
		expect(container.textContent).toContain("Firefox");
		refuse = false;
		await act(async () => {
			button("Revoke all others").click();
		});
		await act(async () => {
			button("Confirm").click();
		});
		await until(() => !container.textContent?.includes("Firefox"));
		expect(writes().map(({ path, status }) => ({ path, status }))).toEqual([
			{ path: "/api/sessions", status: 500 },
			{ path: "/api/sessions", status: 200 },
		]);
		expect(sessions.map((session) => session.id)).toEqual(["older-current"]);
		expect(container.textContent).toContain("Chrome");
		expect(container.textContent).toContain("This device");
	});
	test(`${surface}: an authenticated native session absent from the browser list never marks the newest browser as this device`, async () => {
		identity = {
			id: "native-session-not-listed",
			token: "native-session-token",
		};
		await render(Component);
		expect(container.textContent).not.toContain("This device");
		expect(
			container.querySelectorAll('[aria-label="Revoke session"]')
		).toHaveLength(2);
		expect(writes()).toEqual([]);
	});
}

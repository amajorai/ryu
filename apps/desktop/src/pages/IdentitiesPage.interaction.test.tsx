import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";
import type {
	Connection,
	ConnectionPoll,
	LoginFlow,
	Profile,
} from "@/src/lib/api/identities.ts";
import { createFetchFixture } from "../test-fixtures/native-fetch-fixture.ts";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Object.assign(globalThis, {
	fetch: nativeFetch,
	Response: NativeResponse,
	AbortController: NativeAbortController,
});
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

const toastEvents: { kind: string; title: string }[] = [];
const openedUrls: string[] = [];
let node: import("@/src/lib/api/client.ts").ApiTarget & { name?: string } = {
	url: "",
	token: "test-node-token",
	userJwt: null,
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/lib/tauri-bridge.ts", () => ({
	getLocalNodeToken: async () => ({ source: "test", token: null }),
	openExternal: async (url: string) => {
		openedUrls.push(url);
	},
}));
mock.module("sileo", () => ({
	sileo: {
		error: ({ title }: { title: string }) =>
			toastEvents.push({ kind: "error", title }),
		info: ({ title }: { title: string }) =>
			toastEvents.push({ kind: "info", title }),
		success: ({ title }: { title: string }) =>
			toastEvents.push({ kind: "success", title }),
	},
}));
mock.module("@ryu/ui/components/input", () => ({
	Input: ({ onChange, ...props }: ComponentProps<"input">) => (
		<input
			{...props}
			onChange={onChange}
			onInput={(event) =>
				// SAFETY: This fixture only dispatches input through fill() on the native
				// input itself. Only its target is refined; the entire inferred React
				// InputEvent, native InputEvent and currentTarget remain unchanged.
				onChange?.(
					event as typeof event & { target: EventTarget & HTMLInputElement }
				)
			}
		/>
	),
}));
mock.module("@ryu/ui/components/textarea", () => ({
	Textarea: ({ onChange, ...props }: ComponentProps<"textarea">) => (
		<textarea
			{...props}
			onChange={onChange}
			onInput={(event) =>
				// SAFETY: This fixture only dispatches input through fill() on the native
				// textarea itself. Only its target is refined; the entire inferred React
				// InputEvent, native InputEvent and currentTarget remain unchanged.
				onChange?.(
					event as typeof event & { target: EventTarget & HTMLTextAreaElement }
				)
			}
		/>
	),
}));

const { default: IdentitiesPage } = await import("./IdentitiesPage.tsx");

interface ApiCall {
	body: unknown;
	method: string;
	path: string;
}

interface Fixture {
	calls: ApiCall[];
	failCreate: number;
	failDelete: number;
	failImport: number;
	failLogin: number;
	loginFlow: LoginFlow;
	pollStatus: Connection["status"];
	profiles: Profile[];
}

let fixture: Fixture;
let queryClient: QueryClient;
let container: HTMLDivElement;
let root: Root;

function connection(
	id: string,
	domain: string,
	profileId: string,
	status: Connection["status"] = "NEEDS_AUTH"
): Connection {
	return {
		created_at: 1,
		domain,
		flow_status: "IDLE",
		id,
		last_checked: 0,
		profile_id: profileId,
		source: "manual",
		status,
		updated_at: 1,
	};
}

function profile(profileId: string, connections: Connection[]): Profile {
	return { connections, profile_id: profileId };
}

function createPoll(conn: Connection): ConnectionPoll {
	return {
		connection: conn,
		flow_status: conn.flow_status,
		status: conn.status,
	};
}

function json<TFixture>(value: TFixture, status = 200): Response {
	return NativeResponse.json(value, { status });
}

beforeEach(() => {
	fixture = {
		calls: [],
		failCreate: 0,
		failDelete: 0,
		failImport: 0,
		failLogin: 0,
		loginFlow: {
			flow_id: "flow-hosted",
			kind: { kind: "hosted", url: "https://login.example.test/start" },
		},
		profiles: [],
		pollStatus: "AUTHENTICATED",
	};
	toastEvents.length = 0;
	openedUrls.length = 0;
	globalThis.fetch = createFetchFixture(nativeFetch, async (input, init) => {
		const inputUrl = isNativeText(input)
			? input
			: input instanceof URL
				? input.href
				: input.url;
		const url = new URL(inputUrl);
		const method = init?.method ?? "GET";
		const body = isNativeText(init?.body) ? JSON.parse(init.body) : undefined;
		fixture.calls.push({ body, method, path: url.pathname });

		if (method === "GET" && url.pathname === "/api/identities") {
			return json({ profiles: fixture.profiles });
		}

		if (method === "POST" && url.pathname === "/api/identities/connections") {
			if (fixture.failCreate > 0) {
				fixture.failCreate -= 1;
				return json({ error: "domain rejected" }, 422);
			}
			const input = z
				.object({ domain: z.string(), profile_id: z.string() })
				.parse(body);
			const created = connection(
				`connection-${fixture.calls.length}`,
				input.domain,
				input.profile_id
			);
			const existing = fixture.profiles.find(
				(candidate) => candidate.profile_id === input.profile_id
			);
			if (existing) {
				existing.connections.push(created);
			} else {
				fixture.profiles.push(profile(input.profile_id, [created]));
			}
			return json({ connection: created });
		}

		const prefix = "/api/identities/connections/";
		if (url.pathname.startsWith(prefix)) {
			const suffix = url.pathname.slice(prefix.length);
			if (method === "POST" && suffix.endsWith("/login")) {
				if (fixture.failLogin > 0) {
					fixture.failLogin -= 1;
					return json({ error: "login unavailable" }, 503);
				}
				return json(fixture.loginFlow);
			}

			const id = decodeURIComponent(
				method === "POST" && suffix.endsWith("/import")
					? suffix.slice(0, -"/import".length)
					: suffix
			);
			const owner = fixture.profiles.find((candidate) =>
				candidate.connections.some((item) => item.id === id)
			);
			if (!owner) {
				return json({ error: "connection not found" }, 404);
			}
			const current = owner.connections.find((item) => item.id === id);
			if (!current) {
				return json({ error: "connection not found" }, 404);
			}

			if (method === "GET") {
				current.status = fixture.pollStatus;
				current.flow_status = "DONE";
				return json(createPoll(current));
			}

			if (method === "POST" && suffix.endsWith("/import")) {
				if (fixture.failImport > 0) {
					fixture.failImport -= 1;
					return json({ error: "credential import rejected" }, 422);
				}
				current.status = "AUTHENTICATED";
				current.flow_status = "DONE";
				return json(createPoll(current));
			}

			if (method === "DELETE") {
				if (fixture.failDelete > 0) {
					fixture.failDelete -= 1;
					return json({ error: "delete unavailable" }, 503);
				}
				owner.connections = owner.connections.filter((item) => item.id !== id);
				fixture.profiles = fixture.profiles.filter(
					(candidate) => candidate.connections.length > 0
				);
				return new NativeResponse(null, { status: 204 });
			}
		}

		return json({ error: `unexpected request ${method} ${url.pathname}` }, 404);
	});
	node = {
		url: "http://identities.fixture.test",
		token: "test-node-token",
		userJwt: "test-user-jwt",
	};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 0 } },
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	document.body.replaceChildren();
	queryClient.clear();
	globalThis.fetch = nativeFetch;
});

async function renderPage(
	props: { initialNew?: boolean; initialProfileId?: string } = {}
) {
	await act(async () => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<IdentitiesPage {...props} />
			</QueryClientProvider>
		);
	});
}

async function waitFor(
	condition: () => boolean,
	message: string
): Promise<void> {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		if (condition()) {
			return;
		}
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		});
	}
	if (!condition()) {
		throw new Error(`Timed out waiting for ${message}`);
	}
}

function button(
	label: string,
	parent: ParentNode = container
): HTMLButtonElement {
	const found = Array.from(
		parent.querySelectorAll<HTMLButtonElement>("button")
	).find((candidate) => candidate.textContent?.trim() === label);
	if (!found) {
		throw new Error(`Missing button: ${label}`);
	}
	return found;
}

function buttonByTitle(title: string): HTMLButtonElement {
	const found = container.querySelector<HTMLButtonElement>(
		`button[title="${title}"]`
	);
	if (!found) {
		throw new Error(`Missing button with title: ${title}`);
	}
	return found;
}

async function click(element: HTMLElement): Promise<void> {
	await act(async () => {
		element.click();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	});
}

async function fill(selector: string, value: string): Promise<void> {
	const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		selector
	);
	if (!field) {
		throw new Error(`Missing field: ${selector}`);
	}
	const prototype =
		field instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new InputEvent("input", { bubbles: true }));
		field.blur();
		await Promise.resolve();
	});
}

function fieldValue(selector: string): string {
	const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		selector
	);
	if (!field) {
		throw new Error(`Missing field: ${selector}`);
	}
	return field.value;
}

function latestCall(method: string, path: string): ApiCall | undefined {
	return fixture.calls
		.filter((call) => call.method === method && call.path === path)
		.at(-1);
}

test("profile focus selects the first connection, domain tabs switch details, and cancelling create restores selection", async () => {
	fixture.profiles = [
		profile("work", [
			connection("work-1", "alpha.example.test", "work", "AUTHENTICATED"),
			connection("work-2", "beta.example.test", "work"),
		]),
		profile("personal", [
			connection("personal-1", "mail.example.test", "personal"),
		]),
	];
	await renderPage({ initialProfileId: "work" });
	await waitFor(
		() => container.textContent?.includes("alpha.example.test") ?? false,
		"focused profile connection"
	);
	const tabs = Array.from(
		container.querySelectorAll<HTMLButtonElement>("button")
	).filter((candidate) =>
		["alpha.example.test", "beta.example.test"].includes(
			candidate.textContent?.trim() ?? ""
		)
	);
	expect(tabs).toHaveLength(2);
	await click(tabs[1]!);
	expect(container.textContent).toContain("beta.example.test");
	await click(buttonByTitle("New connection"));
	await waitFor(
		() => container.querySelector("#conn-profile") !== null,
		"new connection form"
	);
	expect(
		Array.from(container.querySelectorAll("#identity-profile-ids option")).map(
			(item) => item.getAttribute("value")
		)
	).toEqual(["work", "personal"]);
	await click(button("Cancel"));
	expect(container.textContent).toContain("beta.example.test");
	expect(fixture.calls.map(({ method, path }) => [method, path])).toEqual([
		["GET", "/api/identities"],
	]);
});

test("empty profile and empty identities expose their create actions and cancel without writing", async () => {
	fixture.profiles = [profile("empty-profile", [])];
	await renderPage({ initialProfileId: "empty-profile" });
	await waitFor(
		() =>
			container.textContent?.includes(
				"No connections under this profile yet."
			) ?? false,
		"empty profile state"
	);
	await click(button("Add connection"));
	await waitFor(
		() => container.querySelector("#conn-profile") !== null,
		"profile create form"
	);
	await click(button("Cancel"));
	expect(container.textContent).toContain(
		"No connections under this profile yet."
	);

	fixture.profiles = [];
	queryClient.clear();
	await act(async () => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<IdentitiesPage />
			</QueryClientProvider>
		);
	});
	await waitFor(
		() => container.textContent?.includes("No identities yet") ?? false,
		"empty identities state"
	);
	await click(button("New connection"));
	await waitFor(
		() => container.querySelector("#conn-profile") !== null,
		"new identity form"
	);
	await click(button("Cancel"));
	expect(container.textContent).toContain("No identities yet");
	expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(
		0
	);
});

test("create sends trimmed fields, reports a rejected write, retries, and reads the created connection back", async () => {
	fixture.profiles = [
		profile("work", [connection("existing", "docs.example.test", "work")]),
	];
	fixture.failCreate = 1;
	await renderPage({ initialNew: true });
	await waitFor(
		() => container.querySelector("#conn-profile") !== null,
		"initial create form"
	);
	expect(container.querySelector("#conn-profile")?.getAttribute("list")).toBe(
		"identity-profile-ids"
	);
	expect(
		Array.from(container.querySelectorAll("#identity-profile-ids option")).map(
			(item) => item.getAttribute("value")
		)
	).toEqual(["work"]);
	await fill("#conn-profile", "  work  ");
	await fill("#conn-domain", "  app.example.test  ");
	await click(button("Create"));
	await waitFor(
		() => toastEvents.some((event) => event.kind === "error"),
		"create error toast"
	);
	expect(container.querySelector("#conn-profile")).not.toBeNull();
	expect(fieldValue("#conn-profile")).toBe("  work  ");
	expect(fieldValue("#conn-domain")).toBe("  app.example.test  ");
	expect(latestCall("POST", "/api/identities/connections")?.body).toEqual({
		domain: "app.example.test",
		profile_id: "work",
	});
	await click(button("Create"));
	await waitFor(
		() => container.textContent?.includes("app.example.test") ?? false,
		"created connection detail"
	);
	expect(
		toastEvents.some(
			(event) =>
				event.kind === "success" &&
				event.title === "Connection for app.example.test created"
		)
	).toBeTrue();
	expect(
		fixture.calls.filter(
			(call) =>
				call.method === "POST" && call.path === "/api/identities/connections"
		)
	).toHaveLength(2);
	await waitFor(
		() =>
			fixture.calls.filter(
				(call) => call.method === "GET" && call.path === "/api/identities"
			).length === 2,
		"identity readback after create"
	);
});

test("hosted login calls the selected connection and opens its returned URL; a failed login can be retried", async () => {
	fixture.profiles = [
		profile("work", [connection("connection-1", "app.example.test", "work")]),
	];
	fixture.failLogin = 1;
	await renderPage({ initialProfileId: "work" });
	await waitFor(
		() => container.textContent?.includes("app.example.test") ?? false,
		"connection detail"
	);
	await click(button("Start login"));
	await waitFor(
		() => toastEvents.some((event) => event.kind === "error"),
		"login error toast"
	);
	expect(openedUrls).toEqual([]);
	await click(button("Start login"));
	await waitFor(() => openedUrls.length === 1, "hosted login opened");
	expect(
		latestCall("POST", "/api/identities/connections/connection-1/login")?.body
	).toBeUndefined();
	expect(openedUrls).toEqual(["https://login.example.test/start"]);
	expect(toastEvents.at(-1)).toEqual({
		kind: "info",
		title:
			"Login page opened in your browser — finish signing in, then select Check status",
	});
});

test("manual login stays in the page and status polling reads the updated connection back", async () => {
	fixture.profiles = [
		profile("work", [connection("connection-1", "app.example.test", "work")]),
	];
	fixture.loginFlow = { flow_id: "flow-manual", kind: { kind: "manual" } };
	await renderPage({ initialProfileId: "work" });
	await waitFor(
		() => container.textContent?.includes("app.example.test") ?? false,
		"connection detail"
	);
	await click(button("Start login"));
	await waitFor(
		() => toastEvents.some((event) => event.kind === "info"),
		"manual login guidance"
	);
	expect(openedUrls).toEqual([]);
	await click(button("Check status"));
	await waitFor(
		() => container.textContent?.includes("Authenticated") ?? false,
		"polled status badge"
	);
	expect(
		latestCall("GET", "/api/identities/connections/connection-1")?.method
	).toBe("GET");
	await waitFor(
		() =>
			fixture.calls.filter(
				(call) => call.method === "GET" && call.path === "/api/identities"
			).length >= 3,
		"identity readback after status check"
	);
	expect(fixture.calls.map(({ method, path }) => [method, path])).toEqual([
		["GET", "/api/identities"],
		["POST", "/api/identities/connections/connection-1/login"],
		["GET", "/api/identities"],
		["GET", "/api/identities/connections/connection-1"],
		["GET", "/api/identities"],
	]);
});

test("refresh re-reads the list from Core", async () => {
	fixture.profiles = [
		profile("work", [connection("connection-1", "app.example.test", "work")]),
	];
	await renderPage({ initialProfileId: "work" });
	await waitFor(
		() => container.textContent?.includes("app.example.test") ?? false,
		"connection detail"
	);
	await click(buttonByTitle("Refresh"));
	await waitFor(
		() =>
			fixture.calls.filter(
				(call) => call.method === "GET" && call.path === "/api/identities"
			).length === 2,
		"identity refresh"
	);
	expect(
		fixture.calls.filter(
			(call) => call.method === "GET" && call.path === "/api/identities"
		)
	).toHaveLength(2);
});

test("manual import preserves entered credentials after a rejected write and clears them after success", async () => {
	fixture.profiles = [
		profile("work", [connection("connection-1", "app.example.test", "work")]),
	];
	fixture.failImport = 1;
	await renderPage({ initialProfileId: "work" });
	await waitFor(
		() => container.textContent?.includes("app.example.test") ?? false,
		"connection detail"
	);
	const secret = "session=secret-cookie; token=secret-token";
	await fill("#manual-state", secret);
	await click(button("Import credentials"));
	await waitFor(
		() => toastEvents.some((event) => event.kind === "error"),
		"import error toast"
	);
	expect(
		latestCall("POST", "/api/identities/connections/connection-1/import")?.body
	).toEqual({ state: secret });
	expect(fieldValue("#manual-state")).toBe(secret);
	await click(button("Import credentials"));
	await waitFor(
		() => container.textContent?.includes("Authenticated") ?? false,
		"authenticated status after import"
	);
	expect(fieldValue("#manual-state")).toBe("");
	expect(
		fixture.calls.filter(
			(call) =>
				call.method === "POST" &&
				call.path === "/api/identities/connections/connection-1/import"
		)
	).toHaveLength(2);
	await waitFor(
		() =>
			fixture.calls.filter(
				(call) => call.method === "GET" && call.path === "/api/identities"
			).length === 2,
		"identity readback after import"
	);
});

test("delete requires confirmation, reports failure without losing selection, then removes the connection on retry", async () => {
	fixture.profiles = [
		profile("work", [connection("connection-1", "app.example.test", "work")]),
	];
	fixture.failDelete = 1;
	await renderPage({ initialProfileId: "work" });
	await waitFor(
		() => container.textContent?.includes("app.example.test") ?? false,
		"connection detail"
	);
	await click(button("Delete"));
	await waitFor(
		() =>
			document.body.textContent?.includes("Delete this connection?") ?? false,
		"delete confirmation"
	);
	expect(document.body.textContent).toContain(
		"This permanently deletes the connection to app.example.test and its saved sign-in."
	);
	const firstDialog = document.body.querySelector<HTMLElement>(
		'[role="alertdialog"]'
	);
	if (!firstDialog) {
		throw new Error("Missing delete alert dialog");
	}
	await click(button("Cancel", firstDialog));
	expect(fixture.calls.filter((call) => call.method === "DELETE")).toHaveLength(
		0
	);
	expect(container.textContent).toContain("app.example.test");

	await click(button("Delete"));
	await waitFor(
		() =>
			document.body.textContent?.includes("Delete this connection?") ?? false,
		"second delete confirmation"
	);
	const secondDialog = document.body.querySelector<HTMLElement>(
		'[role="alertdialog"]'
	);
	if (!secondDialog) {
		throw new Error("Missing delete alert dialog");
	}
	await click(button("Delete", secondDialog));
	await waitFor(
		() => toastEvents.some((event) => event.kind === "error"),
		"delete error toast"
	);
	expect(container.textContent).toContain("app.example.test");
	expect(
		fixture.calls.filter(
			(call) =>
				call.method === "DELETE" &&
				call.path === "/api/identities/connections/connection-1"
		)
	).toHaveLength(1);

	await click(button("Delete"));
	await waitFor(
		() =>
			document.body.textContent?.includes("Delete this connection?") ?? false,
		"delete retry confirmation"
	);
	const retryDialog = document.body.querySelector<HTMLElement>(
		'[role="alertdialog"]'
	);
	if (!retryDialog) {
		throw new Error("Missing delete alert dialog");
	}
	await click(button("Delete", retryDialog));
	await waitFor(
		() => container.textContent?.includes("No identities yet") ?? false,
		"deleted connection readback"
	);
	expect(
		fixture.calls.filter(
			(call) =>
				call.method === "DELETE" &&
				call.path === "/api/identities/connections/connection-1"
		)
	).toHaveLength(2);
	await waitFor(
		() =>
			fixture.calls.filter(
				(call) => call.method === "GET" && call.path === "/api/identities"
			).length === 2,
		"identity readback after delete"
	);
});

import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { NativeAccount } from "@ryuhq/core-client/native-accounts.ts";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { NativeProviderAccountsPanel } = await import(
	"./NativeProviderAccounts.tsx"
);
const realFetch = globalThis.fetch;
const roots: Root[] = [];
const target = {
	url: "https://native.fixture",
	token: "node-token",
	userJwt: "managed-user",
};
const pending: NativeAccount = {
	accountId: "work",
	label: "Work",
	kind: "native_cli",
	active: false,
	verified: false,
	state: "pending",
};

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	globalThis.fetch = realFetch;
});

function fixture(
	handler: (path: string, init?: RequestInit) => Response | Promise<Response>
) {
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) =>
			handler(new URL(String(input)).pathname, init),
		{ preconnect: realFetch.preconnect }
	);
}
async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<NativeProviderAccountsPanel agentId="acp:qwen" target={target} />
		);
		await Bun.sleep(20);
	});
	return root;
}
async function click(name: string) {
	const button = Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent?.trim() === name
	);
	if (!button) {
		throw new Error(`Missing ${name}`);
	}
	await act(async () => {
		button.click();
		await Bun.sleep(20);
	});
}

test("pending accounts cannot be selected; login retains instructions and cancellation uses identity", async () => {
	const writes: string[] = [];
	fixture((path, init) => {
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer node-token");
		expect(headers.get("x-ryu-user-jwt")).toBe("managed-user");
		if (init?.method === "POST" && path.endsWith("/login")) {
			return Response.json({
				operationId: "op",
				accountId: "work",
				state: "running",
				verified: false,
			});
		}
		if (path.endsWith("/operations/op")) {
			if (init?.method === "DELETE") {
				writes.push("cancel");
				return Response.json({ cancelled: true });
			}
			return Response.json({
				operation: {
					operationId: "op",
					accountId: "work",
					state: "running",
					error: null,
					instructions: "Open the provider page and enter DEMO-CODE",
				},
			});
		}
		return Response.json({ nativeAccounts: true, accounts: [pending] });
	});
	await mount();
	expect(document.body.textContent).toContain("Pending sign-in");
	expect(document.body.textContent).not.toContain("Use account");
	await click("Sign in");
	expect(document.body.textContent).toContain("DEMO-CODE");
	expect(document.body.textContent).not.toContain("Connected");
	await click("Cancel sign-in");
	expect(writes).toEqual(["cancel"]);
});

test("verified connected accounts select through the agent account endpoint", async () => {
	const writes: unknown[] = [];
	fixture((path, init) => {
		if (path.endsWith("/accounts/switch")) {
			writes.push(JSON.parse(String(init?.body)));
			return Response.json({ switched: true });
		}
		return Response.json({
			nativeAccounts: true,
			accounts: [{ ...pending, verified: true, state: "connected" }],
		});
	});
	await mount();
	await click("Use account");
	expect(writes).toEqual([{ accountId: "work" }]);
});

test("unsupported nodes hide the panel while permission errors remain visible", async () => {
	fixture(() =>
		Response.json(
			{ error: "This agent does not support native account custody" },
			{ status: 400 }
		)
	);
	await mount();
	expect(
		document.querySelector('section[aria-label="Native provider accounts"]')
	).toBeNull();
});

test("permission failures are visible and never rendered as connected accounts", async () => {
	fixture(() =>
		Response.json({ error: "Agent edit permission required" }, { status: 403 })
	);
	await mount();
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"permission required"
	);
	expect(document.body.textContent).not.toContain("Connected");
});

test("completed login refreshes verified state before enabling account selection", async () => {
	let verified = false;
	fixture(async (path, init) => {
		if (init?.method === "POST" && path.endsWith("/login")) {
			return Response.json({
				operationId: "op",
				accountId: "work",
				state: "running",
				verified: false,
			});
		}
		if (path.endsWith("/operations/op")) {
			verified = true;
			return Response.json({
				operation: {
					operationId: "op",
					accountId: "work",
					state: "completed",
					instructions: "",
					error: null,
				},
			});
		}
		await Bun.sleep(10);
		return Response.json({
			nativeAccounts: true,
			accounts: [
				{ ...pending, verified, state: verified ? "connected" : "pending" },
			],
		});
	});
	await mount();
	await act(async () => {
		await Bun.sleep(30);
	});
	await click("Sign in");
	await act(async () => {
		await Bun.sleep(30);
	});
	expect(document.body.textContent).toContain("Sign-in verified");
	expect(document.body.textContent).toContain("Connected");
	expect(document.body.textContent).toContain("Use account");
});

test("a transient progress failure clears once sign-in completes", async () => {
	let verified = false;
	let progressCalls = 0;
	fixture((path, init) => {
		if (init?.method === "POST" && path.endsWith("/login")) {
			return Response.json({
				operationId: "op",
				accountId: "work",
				state: "running",
				verified: false,
			});
		}
		if (path.endsWith("/operations/op")) {
			progressCalls += 1;
			if (progressCalls === 1) {
				return Response.json({ error: "Core restarting" }, { status: 503 });
			}
			verified = true;
			return Response.json({
				operation: {
					operationId: "op",
					accountId: "work",
					state: "completed",
					instructions: "",
					error: null,
				},
			});
		}
		return Response.json({
			nativeAccounts: true,
			accounts: [
				{ ...pending, verified, state: verified ? "connected" : "pending" },
			],
		});
	});
	await mount();
	await click("Sign in");
	expect(document.querySelector('[role="alert"]')).not.toBeNull();
	// The poll retries a failed progress read after three seconds.
	await act(async () => {
		await Bun.sleep(3200);
	});
	expect(document.body.textContent).toContain("Sign-in verified");
	expect(document.body.textContent).toContain("Connected");
	expect(document.querySelector('[role="alert"]')).toBeNull();
}, 10_000);

test("changing agents ignores a previous account response", async () => {
	let resolveOld: ((response: Response) => void) | undefined;
	fixture((path) => {
		if (path.includes("acp%3Aqwen")) {
			return new Promise<Response>((resolve) => {
				resolveOld = resolve;
			});
		}
		return Response.json({ nativeAccounts: true, accounts: [] });
	});
	const root = await mount();
	await act(async () => {
		root.render(
			<NativeProviderAccountsPanel agentId="codex" target={target} />
		);
		await Bun.sleep(20);
	});
	await act(async () => {
		resolveOld?.(Response.json({ nativeAccounts: true, accounts: [pending] }));
		await Bun.sleep(20);
	});
	expect(document.body.textContent).toContain("No native accounts yet");
	expect(document.body.textContent).not.toContain("Work");
});

test("disconnect, logout, and removal refresh the account list", async () => {
	let account: NativeAccount | null = {
		...pending,
		state: "connected",
		verified: true,
	};
	const writes: string[] = [];
	fixture((path, init) => {
		if (init?.method === "POST") {
			writes.push(path.split("/").at(-1) ?? "");
			if (path.endsWith("/disconnect") && account) {
				account = { ...account, state: "disconnected", verified: false };
			}
			if (path.endsWith("/accounts/remove")) {
				account = null;
				return Response.json({ removed: true });
			}
			return Response.json({ disconnected: true, loggedOut: true });
		}
		return Response.json({
			nativeAccounts: true,
			accounts: account ? [account] : [],
		});
	});
	await mount();
	await click("Disconnect");
	expect(document.body.textContent).toContain("Disconnected");
	await click("Log out");
	await click("Remove");
	expect(writes).toEqual(["disconnect", "logout", "remove"]);
	expect(document.body.textContent).toContain("No native accounts yet");
});

test("adding a named account renders pending and offers provider sign-in", async () => {
	let created: NativeAccount | null = null;
	fixture((path, init) => {
		if (init?.method === "POST" && path.endsWith("/native-accounts")) {
			expect(JSON.parse(String(init.body))).toEqual({ label: "Personal" });
			created = { ...pending, label: "Personal" };
			return Response.json({ account: created });
		}
		return Response.json({
			nativeAccounts: true,
			accounts: created ? [created] : [],
		});
	});
	await mount();
	const input = document.querySelector(
		'input[aria-label="Native account name"]'
	);
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Missing account name input");
	}
	await act(async () => {
		input.focus();
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, " Personal ");
		input.dispatchEvent(new InputEvent("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
		input.dispatchEvent(
			new KeyboardEvent("keyup", { bubbles: true, key: "l" })
		);
	});
	await click("Add account");
	expect(document.body.textContent).toContain("Personal");
	expect(document.body.textContent).toContain("Pending sign-in");
	expect(document.body.textContent).not.toContain("Connected");
});

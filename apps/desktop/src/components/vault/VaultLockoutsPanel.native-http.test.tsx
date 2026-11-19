import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import type { Root } from "react-dom/client";
import {
	button,
	click,
	flush,
	installAnimationApis,
	isDisabled,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// The REAL lockouts panel against a loopback node that keeps the lockout
// settings and locked identities as Core's `sys/lockouts` routes do.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "lockouts-node-token";
const DEFAULTS = {
	enabled: true,
	threshold: 5,
	windowSecs: 900,
	durationSecs: 900,
};

let config = { ...DEFAULTS };
let locked: Record<string, unknown>[] = [];
let writes: { body: unknown; route: string }[] = [];
let forbidden = false;

function json(body: unknown, status = 200): Response {
	return NativeResponse.json(body, { status });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			return json({ error: "Unauthorized" }, 401);
		}
		if (forbidden) {
			return json({ error: "vault_denied: admin required" }, 403);
		}
		if (route === "GET /api/vault/sys/lockouts") {
			return json({ config, locked });
		}
		const raw = await request.text();
		const body = raw ? JSON.parse(raw) : null;
		writes.push({ body, route });
		if (route === "PUT /api/vault/sys/lockouts/config") {
			config = body;
			return json({ config });
		}
		if (route === "POST /api/vault/sys/lockouts/ci%2Frunner/unlock") {
			locked = [];
			return json({ wasLocked: true });
		}
		return json({ error: `undeclared ${route}` }, 404);
	},
});
const target = {
	token: TOKEN,
	url: `http://127.0.0.1:${server.port}`,
	userJwt: null,
};

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { VaultLockoutsPanel, minutesToSecs } = await import(
	"./VaultLockoutsPanel.tsx"
);
installAnimationApis();

let root: Root | null = null;

async function mount(): Promise<void> {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<Toaster />
				<VaultLockoutsPanel target={target} />
			</QueryClientProvider>
		)
	);
	await flush(4);
}

async function setValue(id: string, value: string): Promise<void> {
	const element = document.getElementById(id) as HTMLInputElement | null;
	if (!element) {
		throw new Error(`No #${id}: ${text()}`);
	}
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setter?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await flush(2);
}

beforeEach(() => {
	config = { ...DEFAULTS };
	locked = [
		{
			identity: "ci/runner",
			failures: 5,
			lockedAt: "2026-11-12T00:00:00Z",
			lockedUntil: "2026-11-12T00:15:00Z",
		},
	];
	writes = [];
	forbidden = false;
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	window.fetch = nativeFetch;
});

test("a locked identity is listed and Unlock posts its encoded name", async () => {
	await mount();
	await until(() => text().includes("ci/runner"), "locked row");
	expect(text()).toContain("5 failed logins, locked until");
	await click(button("Unlock ci/runner"));
	await until(
		() => text().includes("No machine identity is locked."),
		"unlocked"
	);
	expect(writes).toEqual([
		{ route: "POST /api/vault/sys/lockouts/ci%2Frunner/unlock", body: null },
	]);
});

test("Save sends every setting, with minutes as seconds", async () => {
	await mount();
	await until(() => text().includes("Login lockout"), "panel");
	expect(isDisabled(button("Save"))).toBe(true);
	await setValue("vault-lockout-threshold", "3");
	await setValue("vault-lockout-duration", "60");
	await click(button("Save"));
	await until(() => writes.length === 1, "saved");
	expect(writes[0]).toEqual({
		route: "PUT /api/vault/sys/lockouts/config",
		body: { enabled: true, threshold: 3, windowSecs: 900, durationSecs: 3600 },
	});
});

test("invalid numbers block Save, and a non-admin sees nothing", async () => {
	await mount();
	await until(() => text().includes("Login lockout"), "panel");
	await setValue("vault-lockout-window", "0");
	expect(text()).toContain("Use whole numbers above zero.");
	expect(isDisabled(button("Save"))).toBe(true);
	expect(writes).toEqual([]);
	await act(async () => root?.unmount());
	document.body.replaceChildren();

	forbidden = true;
	await mount();
	await flush(6);
	expect(text()).not.toContain("Login lockout");
	expect(minutesToSecs("15")).toBe(900);
	expect(minutesToSecs("1.5")).toBeNull();
});

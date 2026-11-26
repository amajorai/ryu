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
	openDialogs,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// The REAL import dialog against a loopback node. Every value is made up.
// The node answers like Core: a preview without values, then a result.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "import-node-token";
const CSV =
	"name,url,username,password\nExample,https://example.com,ada,made-up-dialog-1\nShop,https://shop.example.org,grace,made-up-dialog-2\nBroken,,ada,made-up-dialog-3\n";

let posted: { body: Record<string, unknown>; route: string }[] = [];
let refuse = false;

const PREVIEW = {
	counts: { duplicate: 1, invalid: 1, new: 1, repeated: 0, total: 3 },
	environment: "prod",
	format: "chrome",
	path: "/",
	rows: [
		{
			existing: { id: "itm_1", key: "example", version: 4 },
			hasNotes: false,
			hasTotp: false,
			host: "example.com",
			row: 2,
			site: "https://example.com/",
			status: "duplicate",
			title: "Example",
			totpDropped: false,
			username: "ada",
		},
		{
			hasNotes: false,
			hasTotp: false,
			host: "shop.example.org",
			row: 3,
			site: "https://shop.example.org/",
			status: "new",
			title: "Shop",
			totpDropped: false,
			username: "grace",
		},
		{
			hasNotes: false,
			hasTotp: false,
			problem: "no_site",
			row: 4,
			status: "invalid",
			title: "Broken",
			totpDropped: false,
			username: "ada",
		},
	],
};

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
		if (request.method !== "POST") {
			return json({ items: [] });
		}
		const body = (await request.json()) as Record<string, unknown>;
		posted.push({ body, route });
		if (refuse) {
			return json(
				{
					error:
						"vault_invalid_request: login_import_unknown_format: the first row is not the header",
				},
				400
			);
		}
		if (route === "POST /api/vault/login-imports/preview") {
			return json({ preview: PREVIEW });
		}
		if (route === "POST /api/vault/login-imports") {
			const replace = body.replace as unknown[];
			return json({
				result: {
					created: 1,
					replaced: replace.length,
					rows: [],
					skipped: 0,
				},
			});
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
const { VaultLoginImportDialog } = await import("./VaultLoginImportDialog.tsx");
installAnimationApis();

let root: Root | null = null;
let closed = 0;

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
				<VaultLoginImportDialog
					environment="prod"
					onOpenChange={(open) => {
						if (!open) {
							closed += 1;
						}
					}}
					open
					target={target}
				/>
			</QueryClientProvider>
		)
	);
	await flush(4);
}

/** Pick `content` as the export file, the way a file chooser would. */
async function chooseFile(content: string): Promise<void> {
	const input = document.getElementById(
		"vault-login-import-file"
	) as HTMLInputElement;
	const file = new File([content], "passwords.csv", { type: "text/csv" });
	Object.defineProperty(input, "files", {
		configurable: true,
		value: [file],
	});
	await act(async () => {
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await flush(4);
}

function dialogText(): string {
	return (openDialogs()[0]?.textContent ?? "").replace(/\s+/g, " ");
}

beforeEach(() => {
	posted = [];
	refuse = false;
	closed = 0;
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

test("a chosen file is previewed, nothing is saved until Import, and a duplicate is replaced only when selected", async () => {
	await mount();
	expect(isDisabled(button("Import logins"))).toBe(true);
	await chooseFile(CSV);
	await until(() => dialogText().includes("Records read from"), "preview");

	const shown = dialogText();
	expect(shown).toContain("Records read from the Chrome export: 3");
	expect(shown).toContain("New logins to add to the prod environment: 1");
	expect(shown).toContain("Logins already saved: 1.");
	expect(shown).toContain("example.com");
	expect(shown).toContain(
		"Records that cannot be imported and will be skipped: 1"
	);
	expect(shown).toContain("Record 4: No website address.");
	expect(shown).not.toContain("made-up");
	// Only the preview was asked for so far.
	expect(posted.map((call) => call.route)).toEqual([
		"POST /api/vault/login-imports/preview",
	]);
	expect(posted[0]?.body).toEqual({ csv: CSV, environment: "prod" });

	await click(button("Import logins"));
	await until(() => dialogText().includes("Import finished"), "result");
	expect(posted[1]).toEqual({
		body: { csv: CSV, environment: "prod", replace: [], rows: [3] },
		route: "POST /api/vault/login-imports",
	});
	expect(dialogText()).toContain("1 added, 0 replaced, 0 skipped");
	expect(dialogText()).toContain("Delete the export file now.");
	await click(button("Done"));
	expect(closed).toBe(1);
});

test("selecting a duplicate sends its id and version", async () => {
	await mount();
	await chooseFile(CSV);
	await until(() => dialogText().includes("Logins already saved"), "preview");
	const box = document.querySelector<HTMLElement>(
		'[aria-label="Replace the saved password for ada on example.com"]'
	);
	expect(box).not.toBeNull();
	await click(box as HTMLElement);
	await click(button("Import logins"));
	await until(() => dialogText().includes("Import finished"), "result");
	expect(posted[1]?.body).toEqual({
		csv: CSV,
		environment: "prod",
		replace: [{ expectedId: "itm_1", expectedVersion: 4, row: 2 }],
		rows: [3],
	});
	expect(dialogText()).toContain("1 added, 1 replaced, 0 skipped");
});

test("a file that is not a password export is explained and cannot be imported", async () => {
	refuse = true;
	await mount();
	await chooseFile("made-up-column\nmade-up-cell\n");
	await until(
		() => dialogText().includes("This file is not a password export"),
		"refusal"
	);
	expect(isDisabled(button("Import logins"))).toBe(true);
	expect(posted).toHaveLength(1);
	expect(text()).not.toContain("made-up");
});

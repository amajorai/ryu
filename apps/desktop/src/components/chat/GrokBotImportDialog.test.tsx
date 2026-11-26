import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The dialog talks to a real HTTP peer, so keep Bun's network stack across
// DOM registration.
if (GlobalRegistrator.isRegistered) {
	await GlobalRegistrator.unregister();
}
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeBlob = globalThis.Blob;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const STAGED_ROOT = "/data/tmp/import-staging/0123456789abcdef";
const STAGED = {
	archive: {
		bots: [
			{
				conversations: 1,
				description: "Finds and sums up papers.",
				files: 2,
				has_instructions: true,
				key: "research",
				memories: 5,
				name: "Research helper",
				skills: 1,
			},
			{ has_instructions: true, key: "writer", memories: 3, name: "Writer" },
		],
		source_app: "Grok Bot",
	},
	items: [
		{
			id: "agent/bots/research/SOUL.md",
			kind: "agent",
			title: "Agent 'Research helper' from Grok Bot",
		},
		{
			id: "memory/bots/research/MEMORY.md",
			kind: "memory",
			title: "Memory Research helper from Grok Bot (5 entries)",
		},
		{
			id: "conversations/bots/research",
			kind: "conversations",
			title: "Project 'Research helper' from Grok Bot (1 chat)",
		},
	],
	root: STAGED_ROOT,
	source: "grok-bot",
	warnings: ["Routines of Research helper are not imported."],
};

const uploads: number[] = [];
const runs: unknown[] = [];
const discards: unknown[] = [];
let stageReply: { status: number; body: unknown } = { status: 200, body: {} };

const core = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method !== "POST") {
			return new NativeResponse("not found", { status: 404 });
		}
		if (url.pathname === "/api/import/archive/stage") {
			uploads.push((await request.arrayBuffer()).byteLength);
			return NativeResponse.json(stageReply.body, {
				status: stageReply.status,
			});
		}
		if (url.pathname === "/api/import/archive/discard") {
			discards.push(await request.json());
			return NativeResponse.json({ discarded: true });
		}
		if (url.pathname === "/api/import/run") {
			runs.push(await request.json());
			return NativeResponse.json({
				results: [
					{
						id: "agent/bots/research/SOUL.md",
						kind: "agent",
						status: "imported",
						title: "Agent 'Research helper'",
					},
					{
						already_exists: true,
						id: "memory/bots/research/MEMORY.md",
						kind: "memory",
						status: "skipped",
						title: "Grok Bot memory MEMORY.md",
					},
					{
						folder_path: "/home/ada/Documents/Ryu/Research helper",
						id: "conversations/bots/research",
						kind: "conversations",
						status: "imported",
						title: "Project 'Research helper' from Grok Bot",
					},
				],
				root: STAGED_ROOT,
			});
		}
		return new NativeResponse("not found", { status: 404 });
	},
});

const target = { token: "synthetic", url: core.url.origin, userJwt: null };

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { GrokBotImportDialog } = await import("./GrokBotImportDialog.tsx");
const { GROK_BOT_MIGRATOR_PROMPT } = await import(
	"@/src/lib/grok-bot-migrator.ts"
);

afterAll(async () => {
	core.stop(true);
	await GlobalRegistrator.unregister();
});

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50 && !check(); attempt += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}
}

function button(label: string): HTMLButtonElement | undefined {
	return Array.from(document.querySelectorAll("button")).find(
		(item) => item.textContent?.trim() === label
	);
}

/** Choose a zip in the hidden file input, the way the file picker does. */
async function chooseZip(bytes: number) {
	const input = document.querySelector<HTMLInputElement>(
		'[data-testid="grok-bot-zip-input"]'
	);
	if (!input) {
		throw new Error("The zip input is missing.");
	}
	// A native Blob, so Bun's own fetch sends its bytes.
	const file = new NativeBlob([new Uint8Array(bytes)]);
	Object.defineProperty(input, "files", { configurable: true, value: [file] });
	await act(async () => {
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

describe("GrokBotImportDialog", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let folders: string[];
	let imported: number;

	beforeEach(async () => {
		uploads.length = 0;
		runs.length = 0;
		discards.length = 0;
		folders = [];
		imported = 0;
		stageReply = { status: 200, body: STAGED };
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root.render(
				<GrokBotImportDialog
					onImported={() => {
						imported += 1;
					}}
					onOpenChange={() => undefined}
					onProjectFolder={(path) => {
						folders.push(path);
					}}
					open
					target={target}
				/>
			);
		});
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	it("shows the migrator prompt and waits for a zip", () => {
		const prompt = document.querySelector<HTMLTextAreaElement>(
			"#grok-bot-migrator-prompt"
		);
		expect(prompt?.value).toBe(GROK_BOT_MIGRATOR_PROMPT);
		expect(button("Choose zip file")).toBeDefined();
		expect(button("Import")?.disabled).toBe(true);
	});

	it("previews the zip, imports every item on confirm, then discards it", async () => {
		await chooseZip(2048);
		await waitFor(() => document.body.textContent?.includes("Writer") === true);

		expect(uploads).toEqual([2048]);
		expect(runs).toEqual([]);
		const stats = Array.from(document.querySelectorAll("dl > div")).map(
			(tile) => tile.textContent
		);
		expect(stats).toEqual([
			"Bots2",
			"Memories8",
			"Skills1",
			"Files2",
			"Chats1",
		]);
		expect(document.body.textContent).toContain("Research helper");
		expect(document.body.textContent).toContain(
			"Routines of Research helper are not imported."
		);

		await act(async () => {
			button("Import")?.click();
		});
		await waitFor(() => runs.length === 1 && discards.length === 1);

		expect(runs).toEqual([
			{
				items: STAGED.items.map((item) => ({ id: item.id, kind: item.kind })),
				path: STAGED_ROOT,
			},
		]);
		expect(document.body.textContent).toContain(
			"Imported 2, skipped 1, failed 0"
		);
		expect(folders).toEqual(["/home/ada/Documents/Ryu/Research helper"]);
		expect(imported).toBe(1);
		expect(discards).toEqual([{ path: STAGED_ROOT }]);
	});

	it("shows Core's reason when the zip is refused and imports nothing", async () => {
		stageReply = {
			status: 400,
			body: { error: "the zip holds a symbolic link: bots/a/files/link" },
		};
		await chooseZip(16);
		await waitFor(() => document.querySelector('[role="alert"]') !== null);

		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"the zip holds a symbolic link: bots/a/files/link"
		);
		expect(button("Import")?.disabled).toBe(true);
		expect(runs).toEqual([]);
	});
});

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
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const bodies: unknown[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

const core = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/api/memory/import" && request.method === "POST") {
			bodies.push(await request.json());
			return NativeResponse.json(reply.body, { status: reply.status });
		}
		return new NativeResponse("not found", { status: 404 });
	},
});

const target = { token: "synthetic", url: core.url.origin, userJwt: null };

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryImportDialog, importSummaryText } = await import(
	"./MemoryImportDialog.tsx"
);
const { MEMORY_IMPORT_PROMPT } = await import("./memory-import-prompt.ts");

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

function setValue(
	element: HTMLTextAreaElement | HTMLSelectElement,
	value: string
) {
	const proto = Object.getPrototypeOf(element);
	Reflect.get(
		Object.getOwnPropertyDescriptor(proto, "value") ?? {},
		"set"
	)?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
	element.dispatchEvent(new Event("change", { bubbles: true }));
}

function button(label: string): HTMLButtonElement | undefined {
	return Array.from(document.querySelectorAll("button")).find(
		(item) => item.textContent?.trim() === label
	);
}

describe("MemoryImportDialog", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let imported: number;
	let closed: number;

	beforeEach(async () => {
		bodies.length = 0;
		imported = 0;
		closed = 0;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root.render(
				<MemoryImportDialog
					onClose={() => {
						closed += 1;
					}}
					onImported={() => {
						imported += 1;
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

	it("shows the prompt Core's parser expects and waits for a paste", () => {
		const prompt = document.querySelector<HTMLTextAreaElement>(
			"#memory-import-prompt"
		);
		expect(prompt?.value).toBe(MEMORY_IMPORT_PROMPT);
		expect(MEMORY_IMPORT_PROMPT).toContain(
			"[YYYY-MM-DD] - Entry content here."
		);
		expect(button("Add to memory")?.disabled).toBe(true);
	});

	it("sends the paste with its source and refreshes the library", async () => {
		reply = {
			status: 200,
			body: { already_present: 1, found: 3, imported: 2, skipped_sensitive: 0 },
		};
		await act(async () => {
			setValue(
				document.querySelector("#memory-import-source") as HTMLSelectElement,
				"grok"
			);
			setValue(
				document.querySelector("#memory-import-text") as HTMLTextAreaElement,
				"## Preferences\n[unknown] - Prefers concise answers."
			);
		});
		await act(async () => {
			button("Add to memory")?.click();
		});
		await waitFor(() => closed === 1);

		expect(bodies).toEqual([
			{
				source: "grok",
				text: "## Preferences\n[unknown] - Prefers concise answers.",
			},
		]);
		expect(imported).toBe(1);
	});

	it("keeps the dialog open with Core's refusal", async () => {
		reply = {
			status: 400,
			body: { error: "no memories were found in the pasted text" },
		};
		await act(async () => {
			setValue(
				document.querySelector("#memory-import-text") as HTMLTextAreaElement,
				"hello"
			);
		});
		await act(async () => {
			button("Add to memory")?.click();
		});
		await waitFor(() => document.querySelector('[role="alert"]') !== null);

		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"no memories were found in the pasted text"
		);
		expect(closed).toBe(0);
		expect(imported).toBe(0);
	});
});

describe("importSummaryText", () => {
	const tl = ((text: string, values?: Record<string, string>) =>
		text.replace(
			/\{(\w+)\}/g,
			(_, key: string) => values?.[key] ?? ""
		)) as never;

	it("mentions repeats and sensitive skips only when there are any", () => {
		expect(
			importSummaryText(
				{ alreadyPresent: 0, found: 2, imported: 2, skippedSensitive: 0 },
				tl
			)
		).toBe("2 added");
		expect(
			importSummaryText(
				{ alreadyPresent: 1, found: 4, imported: 2, skippedSensitive: 1 },
				tl
			)
		).toBe(
			"2 added · 1 already saved · 1 skipped because sensitive topics are off in Settings → Memory"
		);
	});
});

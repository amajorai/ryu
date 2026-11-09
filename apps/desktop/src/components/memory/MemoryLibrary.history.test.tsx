import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Keep Bun's own network stack across DOM registration: the Library talks to a
// real HTTP peer below, not a mocked API module. A sibling suite may have left
// the DOM registered, so start from Bun's globals and restore them afterwards.
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

const queries: string[] = [];

const active = {
	category: "preference",
	content: "Prefers window seats",
	id: "memory-2",
	importance: 3,
	lifecycle: "active",
	scope: "user",
	tags: [],
};
const replaced = {
	category: "preference",
	content: "Prefers aisle seats",
	id: "memory-1",
	importance: 3,
	lifecycle: "superseded",
	scope: "user",
	tags: [],
};

// Core lists active memories unless the caller asks for history.
const core = Bun.serve({
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/api/memory") {
			queries.push(url.search);
			const history = url.searchParams.get("include_history") === "true";
			return NativeResponse.json({
				memories: history ? [active, replaced] : [active],
			});
		}
		return new NativeResponse("not found", { status: 404 });
	},
});

const node = {
	name: "Synthetic node",
	token: "synthetic-memory-node",
	url: core.url.origin,
	userJwt: null,
};
const realActiveNode = await import("@/src/hooks/useActiveNode.ts");
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	...realActiveNode,
	useActiveNode: () => node,
}));

// The Git dialog's card needs the native shell; this stand-in shows which
// memories the Library hands it to export.
const realGitSource = await import("./MemoryGitSourceCard.tsx");
mock.module("./MemoryGitSourceCard.tsx", () => ({
	...realGitSource,
	MemoryGitSourceCard: ({ memories }: { memories: { content: string }[] }) => (
		<div data-testid="git-export">
			{memories.map((memory) => (
				<p key={memory.content}>{memory.content}</p>
			))}
		</div>
	),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryLibrary } = await import("./MemoryLibrary.tsx");

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

function rows(container: HTMLElement): HTMLLIElement[] {
	return Array.from(container.querySelectorAll("li"));
}

function menuItems(): string[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>('[role="menuitem"]')
	).map((item) => item.textContent?.trim() ?? "");
}

async function closeMenus(): Promise<void> {
	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
	await waitFor(() => menuItems().length === 0);
}

async function openActions(button: Element | null | undefined) {
	await act(async () => {
		(button as HTMLElement | null)?.click();
	});
	await waitFor(() => menuItems().length > 0);
}

async function showHistory(container: HTMLElement): Promise<void> {
	await waitFor(() => rows(container).length === 1);
	const toggle = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent?.trim() === "History"
	);
	await act(async () => {
		toggle?.click();
	});
	await waitFor(() => rows(container).length === 2);
}

function rowWith(container: HTMLElement, text: string) {
	return rows(container).find((row) => row.textContent?.includes(text));
}

describe("MemoryLibrary history", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		queries.length = 0;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	it("lists active memories, and history with its lifecycle on request", async () => {
		await act(async () => {
			root.render(<MemoryLibrary />);
		});
		await waitFor(() => rows(container).length === 1);
		expect(rows(container)[0]?.textContent).toContain("Prefers window seats");
		expect(container.querySelector("[data-testid=memory-lifecycle]")).toBe(
			null
		);

		const toggle = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "History"
		);
		expect(toggle?.getAttribute("aria-pressed")).toBe("false");
		await act(async () => {
			toggle?.click();
		});
		await waitFor(() => rows(container).length === 2);

		expect(queries).toEqual(["", "?include_history=true"]);
		expect(toggle?.getAttribute("aria-pressed")).toBe("true");
		const history = rows(container).find((row) =>
			row.textContent?.includes("Prefers aisle seats")
		);
		expect(
			history?.querySelector("[data-testid=memory-lifecycle]")?.textContent
		).toBe("Replaced");
		const current = rows(container).find((row) =>
			row.textContent?.includes("Prefers window seats")
		);
		expect(current?.querySelector("[data-testid=memory-lifecycle]")).toBe(null);
	});
	it("lets a history row be deleted but not edited", async () => {
		await act(async () => {
			root.render(<MemoryLibrary />);
		});
		await showHistory(container);

		const actions = '[aria-label="Memory actions"]';
		await openActions(
			rowWith(container, "Prefers aisle seats")?.querySelector(actions)
		);
		expect(menuItems()).toContain("Delete memory");
		expect(menuItems()).not.toContain("Edit memory");
		await closeMenus();

		await openActions(
			rowWith(container, "Prefers window seats")?.querySelector(actions)
		);
		expect(menuItems()).toEqual(["Edit memory", "Delete memory"]);
		await closeMenus();
	});

	it("hands the Git source only the active memories while History is on", async () => {
		await act(async () => {
			root.render(<MemoryLibrary />);
		});
		await showHistory(container);

		await openActions(
			container.querySelector('[aria-label="More memory actions"]')
		);
		const gitItem = Array.from(
			document.querySelectorAll<HTMLElement>('[role="menuitem"]')
		).find((item) => item.textContent?.includes("Git source"));
		await act(async () => {
			gitItem?.click();
		});
		await waitFor(
			() => document.querySelector("[data-testid=git-export]") !== null
		);
		const exported = document.querySelector("[data-testid=git-export]");
		expect(
			Array.from(exported?.querySelectorAll("p") ?? []).map(
				(item) => item.textContent
			)
		).toEqual(["Prefers window seats"]);
	});
});

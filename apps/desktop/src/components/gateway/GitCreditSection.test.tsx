import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { GitCreditSection } = await import("./GitCreditSection.tsx");

const target = { url: "http://core.test:7980", token: null };
const realFetch = globalThis.fetch;
const roots: Root[] = [];

/** The node's saved preference; null means it was never written. */
let saved: string | null = null;
let writes: string[] = [];
let failWrites = false;

function installCore() {
	globalThis.fetch = ((
		input: Parameters<typeof fetch>[0],
		init?: RequestInit
	) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname !== "/api/preferences/git-credit-ryu") {
			return Promise.resolve(
				Response.json({ error: "Unexpected request" }, { status: 500 })
			);
		}
		if (init?.method === "PUT") {
			if (failWrites) {
				return Promise.resolve(
					Response.json({ error: "disk full" }, { status: 500 })
				);
			}
			const body: { value: string } = JSON.parse(String(init.body));
			writes.push(body.value);
			saved = body.value;
			return Promise.resolve(Response.json({ ok: true }));
		}
		return Promise.resolve(
			saved === null
				? Response.json({ error: "preference not set" }, { status: 404 })
				: Response.json({ key: "git-credit-ryu", value: saved })
		);
	}) as typeof fetch;
}

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	globalThis.fetch = realFetch;
	saved = null;
	writes = [];
	failWrites = false;
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mount(): Promise<HTMLElement> {
	installCore();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<GitCreditSection target={target} />
			</QueryClientProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(25);
	});
	return container;
}

function creditSwitch(container: HTMLElement): HTMLElement {
	const control = container.querySelector(
		'[role="switch"][aria-label="Credit Ryu in git commits"]'
	);
	if (!(control instanceof HTMLElement)) {
		throw new Error("Missing the commit credit switch");
	}
	return control;
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
		await Bun.sleep(25);
	});
}

test("a node that never saved the preference shows credit on", async () => {
	const container = await mount();
	const control = creditSwitch(container);
	expect(control.getAttribute("aria-checked")).toBe("true");
	expect(control.hasAttribute("disabled")).toBe(false);
	expect(container.textContent).toContain(
		"Co-authored-by: Ryu <amajorhq@gmail.com>"
	);
	expect(writes).toEqual([]);
});

test("a saved false shows credit off", async () => {
	saved = "false";
	const container = await mount();
	expect(creditSwitch(container).getAttribute("aria-checked")).toBe("false");
});

test("turning the switch off and on saves each choice to Core", async () => {
	const container = await mount();
	await click(creditSwitch(container));
	expect(writes).toEqual(["false"]);
	expect(creditSwitch(container).getAttribute("aria-checked")).toBe("false");

	await click(creditSwitch(container));
	expect(writes).toEqual(["false", "true"]);
	expect(creditSwitch(container).getAttribute("aria-checked")).toBe("true");
});

test("a failed save keeps the saved state and says so", async () => {
	failWrites = true;
	const container = await mount();
	await click(creditSwitch(container));
	expect(creditSwitch(container).getAttribute("aria-checked")).toBe("true");
	expect(container.textContent).toContain(
		"Could not save the commit credit setting. Try again."
	);
});

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
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AvailableUpdate } from "@/src/hooks/useAvailableUpdates.ts";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// Reach the fake Core with Bun's own fetch; happy-dom's cannot read its replies.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
globalThis.fetch = nativeFetch;
globalThis.Response = NativeResponse;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

// Core's installed-skill list: alpha is enabled, beta is disabled. A case can
// hold its replies behind `skillReadGate` to keep a run pending.
let skillReads = 0;
let skillReadGate: Promise<void> | null = null;
const core = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: async () => {
		skillReads += 1;
		await skillReadGate;
		return Response.json({
			skills: [
				{ id: "alpha", name: "Alpha", enabled: true },
				{ id: "beta", name: "Beta", enabled: false },
			],
		});
	},
});

const skillUpdate = (slug: string, name: string): AvailableUpdate => ({
	currentVersion: null,
	id: `owner/repo/${slug}`,
	key: `skill:${slug}`,
	kind: "skill",
	latestVersion: null,
	name,
	slug,
	source: "skills-sh",
});

const pluginUpdate: AvailableUpdate = {
	currentVersion: "1.0.0",
	id: "@ryu/demo",
	key: "plugin:@ryu/demo",
	kind: "plugin",
	latestVersion: "1.1.0",
	name: "Demo",
};

let updates: AvailableUpdate[] = [];
const applied: string[] = [];
mock.module("@/src/hooks/useAvailableUpdates.ts", () => ({
	useAvailableUpdates: () => ({
		updates,
		applyingKeys: new Set<string>(),
		loading: false,
		refresh: () => undefined,
		applyUpdate: async (update: AvailableUpdate) => {
			applied.push(update.key);
		},
	}),
}));

const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { SkillDistributionProvider } = await import(
	"@/src/components/skills/SkillDistributionProvider.tsx"
);
const { AvailableUpdates } = await import("./AvailableUpdates.tsx");

const services = {
	distribute: mock(async () => ({ skillId: "", targets: [] })),
	fetchTargets: mock(async () => {
		throw new Error("unused");
	}),
	install: mock(async () => {
		throw new Error("unused");
	}),
};

function buttons(name: string): HTMLButtonElement[] {
	return Array.from(document.querySelectorAll("button")).filter(
		(element) => element.textContent?.trim() === name
	);
}

function button(name: string): HTMLButtonElement {
	const [found] = buttons(name);
	if (!found) {
		throw new Error(`Missing button ${name}: ${document.body.innerHTML}`);
	}
	return found;
}

async function click(element: Element) {
	await act(async () => {
		element.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true, button: 0 })
		);
		element.dispatchEvent(
			new PointerEvent("pointerup", { bubbles: true, button: 0 })
		);
		element.dispatchEvent(
			new MouseEvent("click", { bubbles: true, button: 0 })
		);
		await Promise.resolve();
	});
}

async function settle(until: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (until()) {
			return;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
	throw new Error(`Condition not met: ${document.body.innerHTML}`);
}

const confirmOpen = () => document.querySelector('[role="alertdialog"]');

describe("AvailableUpdates skill confirmation", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	async function mount(list: AvailableUpdate[]) {
		updates = list;
		await act(async () => {
			root.render(
				<SkillDistributionProvider services={services}>
					<AvailableUpdates />
				</SkillDistributionProvider>
			);
			await Promise.resolve();
		});
	}

	beforeEach(() => {
		applied.length = 0;
		skillReads = 0;
		skillReadGate = null;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		useNodeStore.setState({
			defaultNode: "local",
			nodes: [{ name: "local", url: core.url.origin, token: "a" }],
		});
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
			await Promise.resolve();
		});
		container.remove();
		document.body.replaceChildren();
	});

	afterAll(() => {
		core.stop(true);
	});

	it("asks before updating an enabled skill, and cancel applies nothing", async () => {
		await mount([skillUpdate("alpha", "Alpha")]);
		await click(button("Update"));
		await settle(() => confirmOpen() !== null);
		expect(confirmOpen()?.textContent).toContain("The Alpha skill");
		await click(button("Cancel"));
		await settle(() => confirmOpen() === null);
		expect(applied).toEqual([]);

		await click(button("Update"));
		await settle(() => confirmOpen() !== null);
		await click(button("Apply now"));
		await settle(() => applied.length === 1);
		expect(applied).toEqual(["skill:alpha"]);
	});

	it("updates a disabled skill without asking", async () => {
		await mount([skillUpdate("beta", "Beta")]);
		await click(button("Update"));
		await settle(() => applied.length === 1);
		expect(applied).toEqual(["skill:beta"]);
		expect(confirmOpen()).toBeNull();
	});

	it("asks once for Update all, naming only the enabled skills", async () => {
		await mount([
			pluginUpdate,
			skillUpdate("alpha", "Alpha"),
			skillUpdate("beta", "Beta"),
		]);
		await click(button("Update all"));
		await settle(() => confirmOpen() !== null);
		const text = confirmOpen()?.textContent ?? "";
		expect(text).toContain("The Alpha skill");
		expect(text).not.toContain("Beta");
		await click(button("Cancel"));
		await settle(() => confirmOpen() === null);
		expect(applied).toEqual([]);

		await click(button("Update all"));
		await settle(() => confirmOpen() !== null);
		await click(button("Apply now"));
		await settle(() => applied.length === 3);
		expect(applied).toEqual(["plugin:@ryu/demo", "skill:alpha", "skill:beta"]);
	});

	it("starts Update all once when it is clicked twice before it begins", async () => {
		const { promise, resolve: releaseSkillReads } =
			Promise.withResolvers<void>();
		skillReadGate = promise;
		await mount([pluginUpdate, skillUpdate("beta", "Beta")]);
		const updateAll = button("Update all");
		// The first run stays pending on Core's held reply, so the second click
		// lands while it is still starting.
		await click(updateAll);
		await click(updateAll);
		await settle(() => skillReads >= 1);
		expect(applied).toEqual([]);
		releaseSkillReads();
		await settle(() => applied.length >= 2);
		expect(skillReads).toBe(1);
		expect(applied).toEqual(["plugin:@ryu/demo", "skill:beta"]);
		expect(confirmOpen()).toBeNull();
	});

	it("does not ask when no update is a skill", async () => {
		await mount([pluginUpdate]);
		await click(button("Update"));
		await settle(() => applied.length === 1);
		expect(confirmOpen()).toBeNull();
	});
});

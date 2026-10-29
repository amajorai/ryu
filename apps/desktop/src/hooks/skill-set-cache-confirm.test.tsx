import { afterEach, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "fetch", nativeFetch);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { SkillDistributionProvider } = await import(
	"@/src/components/skills/SkillDistributionProvider.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { useSkillPacks } = await import("./useSkillPacks.ts");
const { useSkillsCatalog } = await import("./useSkillsCatalog.ts");

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0).reverse()) {
		await clean();
	}
	document.body.replaceChildren();
});

interface Recorded {
	body: unknown;
	path: string;
}

function fixture(
	packMembers: { id: string; installed: boolean; name: string }[]
) {
	const writes: Recorded[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (request.method === "POST") {
				writes.push({ path, body: await request.json() });
			}
			if (path === "/api/skills") {
				return NativeResponse.json({
					skills: [
						{ id: "alpha", name: "Alpha", enabled: true },
						{ id: "beta", name: "Beta", enabled: false },
					],
				});
			}
			if (path === "/api/skills/activate") {
				return NativeResponse.json({ success: true });
			}
			if (path === "/api/skills/packs/detail") {
				return NativeResponse.json({
					id: "starter",
					name: "Starter",
					members: packMembers,
				});
			}
			if (path === "/api/skills/packs/install") {
				return NativeResponse.json({ success: true, installed: ["gamma"] });
			}
			return NativeResponse.json({ skills: [], sources: [], packs: [] });
		},
	});
	cleanup.push(() => server.stop(true));
	return { origin: server.url.origin, writes };
}

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

function cacheConfirm() {
	return document.querySelector('[role="alertdialog"]');
}

async function waitForCacheConfirm() {
	for (let attempt = 0; attempt < 100 && !cacheConfirm(); attempt += 1) {
		await settle();
	}
	if (!cacheConfirm()) {
		throw new Error(`Cache confirm did not open: ${document.body.innerHTML}`);
	}
}

async function press(label: string) {
	const found = Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent?.trim() === label
	);
	if (!found) {
		throw new Error(`Missing button ${label}`);
	}
	await act(async () => {
		found.click();
		await Promise.resolve();
	});
}

async function mount(origin: string) {
	const previous = useNodeStore.getState();
	cleanup.push(() => useNodeStore.setState(previous));
	useNodeStore.setState({
		nodes: [{ name: "local", url: origin, token: "test" }],
		defaultNode: "local",
		autoSelect: false,
	});
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	cleanup.push(() => queryClient.clear());
	const hooks: {
		catalog?: ReturnType<typeof useSkillsCatalog>;
		packs?: ReturnType<typeof useSkillPacks>;
	} = {};
	function Harness() {
		hooks.catalog = useSkillsCatalog();
		hooks.packs = useSkillPacks();
		return null;
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	cleanup.push(async () => {
		await act(async () => root.unmount());
		container.remove();
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<SkillDistributionProvider>
					<Harness />
				</SkillDistributionProvider>
			</QueryClientProvider>
		)
	);
	for (
		let attempt = 0;
		attempt < 100 && (hooks.catalog?.installedSkills.length ?? 0) === 0;
		attempt += 1
	) {
		await settle();
	}
	return hooks;
}

function activations(writes: Recorded[]) {
	return writes.filter((write) => write.path === "/api/skills/activate");
}

it("a no-op toggle saves without asking", async () => {
	const { origin, writes } = fixture([]);
	const hooks = await mount(origin);
	await act(async () => {
		await hooks.catalog?.setSkillEnabled("alpha", true);
	});
	expect(cacheConfirm()).toBeNull();
	expect(activations(writes)).toEqual([
		{ path: "/api/skills/activate", body: { id: "alpha", active: true } },
	]);
});

it("disabling a skill asks first and applies on confirm", async () => {
	const { origin, writes } = fixture([]);
	const hooks = await mount(origin);
	let pending: Promise<void> | undefined;
	await act(async () => {
		pending = hooks.catalog?.setSkillEnabled("alpha", false);
		await Promise.resolve();
	});
	await waitForCacheConfirm();
	expect(document.body.textContent).toContain(
		"The Alpha skill is part of the system prompt for every thread that loads skills."
	);
	expect(activations(writes)).toEqual([]);
	await press("Apply now");
	await act(async () => {
		await pending;
	});
	expect(activations(writes)).toEqual([
		{ path: "/api/skills/activate", body: { id: "alpha", active: false } },
	]);
});

it("cancelling an enable leaves the skill disabled", async () => {
	const { origin, writes } = fixture([]);
	const hooks = await mount(origin);
	let pending: Promise<void> | undefined;
	await act(async () => {
		pending = hooks.catalog?.setSkillEnabled("beta", true);
		await Promise.resolve();
	});
	await waitForCacheConfirm();
	await press("Cancel");
	await act(async () => {
		await pending;
	});
	expect(activations(writes)).toEqual([]);
	expect(hooks.catalog?.enabledByKey.beta).toBe(false);
});

it("a pack install asks with only the members it adds", async () => {
	const { origin, writes } = fixture([
		{ id: "alpha", installed: true, name: "Alpha" },
		{ id: "gamma", installed: false, name: "Gamma" },
	]);
	const hooks = await mount(origin);
	let pending: Promise<string[]> | undefined;
	await act(async () => {
		pending = hooks.packs?.install("starter");
		await Promise.resolve();
	});
	await waitForCacheConfirm();
	expect(document.body.textContent).toContain("The Gamma skill is part of");
	expect(document.body.textContent).not.toContain("Alpha skill");
	await press("Apply now");
	let installed: string[] | undefined;
	await act(async () => {
		installed = await pending;
	});
	expect(installed).toEqual(["gamma"]);
	expect(writes.map((write) => write.path)).toContain(
		"/api/skills/packs/install"
	);
});

it("a pack with nothing new installs without asking", async () => {
	const { origin, writes } = fixture([
		{ id: "alpha", installed: true, name: "Alpha" },
	]);
	const hooks = await mount(origin);
	await act(async () => {
		await hooks.packs?.install("starter");
	});
	expect(cacheConfirm()).toBeNull();
	expect(writes.map((write) => write.path)).toContain(
		"/api/skills/packs/install"
	);
});

it("cancelling a pack install writes nothing", async () => {
	const { origin, writes } = fixture([
		{ id: "gamma", installed: false, name: "Gamma" },
	]);
	const hooks = await mount(origin);
	let pending: Promise<string[]> | undefined;
	await act(async () => {
		pending = hooks.packs?.install("starter");
		await Promise.resolve();
	});
	await waitForCacheConfirm();
	await press("Cancel");
	let installed: string[] | undefined;
	await act(async () => {
		installed = await pending;
	});
	expect(installed).toEqual([]);
	expect(writes).toEqual([]);
});

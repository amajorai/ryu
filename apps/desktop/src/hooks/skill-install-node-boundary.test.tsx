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
const { CurrentTabIdProvider } = await import("@/src/contexts/TabsContext.tsx");
const { SkillDistributionProvider } = await import(
	"@/src/components/skills/SkillDistributionProvider.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { useSkillsCatalog } = await import("./useSkillsCatalog.ts");
const { useStoreHome } = await import("./useStoreHome.ts");

async function applyCacheReset(): Promise<string> {
	for (
		let attempt = 0;
		attempt < 100 && !document.querySelector('[role="alertdialog"]');
		attempt += 1
	) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
	const apply = Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent?.trim() === "Apply now"
	);
	if (!apply) {
		throw new Error(`Cache confirm did not open: ${document.body.innerHTML}`);
	}
	const copy = document.body.textContent ?? "";
	await act(async () => {
		apply.click();
		await Promise.resolve();
	});
	return copy;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0).reverse()) {
		await clean();
	}
});

for (const view of ["catalog", "home"] as const) {
	it(`${view} reads and installs on the tab node with its credentials`, async () => {
		const requests: {
			node: string;
			path: string;
			method: string;
			bearer: string | null;
			identity: string | null;
		}[] = [];
		function fixture(node: string) {
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch(request) {
					const path = new URL(request.url).pathname;
					requests.push({
						node,
						path,
						method: request.method,
						bearer: request.headers.get("authorization"),
						identity: request.headers.get("x-ryu-user-jwt"),
					});
					if (path === "/api/skills/catalog/install") {
						return NativeResponse.json({
							success: true,
							result: { slug: "demo", path: "/fixture/skills/demo/SKILL.md" },
						});
					}
					return NativeResponse.json({
						skills: [
							{
								id: "demo",
								slug: "demo",
								name: "Demo",
								installed: false,
								installs: 0,
								source: "skills-sh",
							},
						],
						models: [],
						sources: [],
						apps: [],
						agents: [],
						servers: [],
						plugins: [],
					});
				},
			});
			cleanup.push(() => server.stop(true));
			return server.url.origin;
		}
		const nodeA = fixture("A");
		const nodeB = fixture("B");
		const previous = useNodeStore.getState();
		cleanup.push(() => useNodeStore.setState(previous));
		useNodeStore.setState({
			nodes: [
				{ name: "A", url: nodeA, token: "test-A" },
				{ name: "B", url: nodeB, token: "test-B", userJwt: "identity-B" },
			],
			defaultNode: "A",
			autoSelect: false,
			tabOverrides: { "store-tab": "B" },
		});
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		cleanup.push(() => queryClient.clear());
		let catalog: ReturnType<typeof useSkillsCatalog> | undefined;
		let home: ReturnType<typeof useStoreHome> | undefined;
		function CatalogHarness() {
			catalog = useSkillsCatalog();
			return null;
		}
		function HomeHarness() {
			home = useStoreHome();
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
						<CurrentTabIdProvider tabId="store-tab">
							{view === "catalog" ? <CatalogHarness /> : <HomeHarness />}
						</CurrentTabIdProvider>
					</SkillDistributionProvider>
				</QueryClientProvider>
			)
		);
		for (
			let attempt = 0;
			attempt < 100 && (view === "catalog" ? catalog?.loading : home?.loading);
			attempt += 1
		) {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
			});
		}
		let pending: Promise<void> | undefined;
		if (view === "catalog") {
			await act(async () => catalog?.select("demo"));
			await act(async () => {
				pending = catalog?.install();
				await Promise.resolve();
			});
		} else {
			const row = home?.rows.find((candidate) => candidate.realm === "skills");
			const card = row?.items[0];
			if (!(row && card)) {
				throw new Error("Skills row did not load");
			}
			await act(async () => {
				pending = row.add(card);
				await Promise.resolve();
			});
		}
		// Installing activates the skill, so the prompt-cache confirm comes first.
		expect(await applyCacheReset()).toContain("The Demo skill is part of");
		await act(async () => {
			await pending;
		});
		const installs = requests.filter(
			(request) => request.path === "/api/skills/catalog/install"
		);
		expect(installs).toHaveLength(1);
		expect(installs[0]).toMatchObject({
			node: "B",
			method: "POST",
			bearer: "Bearer test-B",
			identity: "identity-B",
		});
		expect(
			requests.some(
				(request) =>
					request.path === "/api/skills/catalog" && request.node === "B"
			)
		).toBe(true);
		expect(requests.filter((request) => request.node === "A")).toEqual([]);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
}

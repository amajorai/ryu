import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const node = {
	token: "node-token",
	url: "http://node.test",
	userJwt: "user-one",
};

mock.module("@/src/components/skills/SkillDistributionProvider.tsx", () => ({
	useSkillDistributionFlow: () => ({
		confirmSkillSetChange: () => Promise.resolve(true),
		installCatalogSkill: () => Promise.resolve(null),
	}),
}));
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/lib/api/skills.ts", () => ({
	addMarketplaceSource: () => Promise.resolve(),
	fetchSkillDetail: () => Promise.resolve(null),
	fetchSkillSources: () => Promise.resolve({ sources: [] }),
	listSkills: () => Promise.resolve([]),
	removeMarketplaceSource: () => Promise.resolve(),
	reorderMarketplaceSource: () => Promise.resolve(),
	searchSkills: () => Promise.resolve([]),
	setSkillActive: () => Promise.resolve(),
}));

const { useSkillsCatalog } = await import("./useSkillsCatalog.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});
let root = createRoot(document.createElement("div"));

function Reader() {
	useSkillsCatalog();
	return null;
}

function Harness() {
	return (
		<QueryClientProvider client={client}>
			<Reader />
		</QueryClientProvider>
	);
}

afterEach(async () => {
	await act(() => root.unmount());
	client.clear();
	root = createRoot(document.createElement("div"));
});

test("Skills catalog retains its four query descriptors across renders", async () => {
	await act(() => root.render(<Harness />));
	const first = client
		.getQueryCache()
		.getAll()
		.filter((query) => query.queryKey[0] === "skills")
		.sort((a, b) => String(a.queryKey).localeCompare(String(b.queryKey)))
		.map((query) => query.options.queryFn);
	expect(first).toHaveLength(4);

	await act(() => root.render(<Harness />));
	const second = client
		.getQueryCache()
		.getAll()
		.filter((query) => query.queryKey[0] === "skills")
		.sort((a, b) => String(a.queryKey).localeCompare(String(b.queryKey)))
		.map((query) => query.options.queryFn);
	expect(second).toEqual(first);
});

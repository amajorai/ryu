// Contract test for the CatalogHost context seam: useCatalogHost throws when no
// provider is mounted (a misuse guard), and reads the injected services when one
// is. Rendered to static markup, no DOM — like the rest of the package's tests.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type CatalogHost,
	CatalogHostProvider,
	useCatalogHost,
} from "./host.tsx";

function stubHost(over: Partial<CatalogHost> = {}): CatalogHost {
	return {
		install: null,
		Markdown: ({ content }) => <div>{content}</div>,
		openExternal: () => undefined,
		useAppsCatalog: () => {
			throw new Error("unused");
		},
		useSkillsCatalog: () => {
			throw new Error("unused");
		},
		useModelCatalog: () => {
			throw new Error("unused");
		},
		useActiveNode: () => ({ url: "", token: null }),
		usePersistedToggle: (_k: string, d: boolean) =>
			[d, () => undefined] as [boolean, (v: boolean) => void],
		installSidecar: () => Promise.resolve(),
		estimateLlmfit: () =>
			Promise.resolve({
				fit_level: null,
				installed: false,
				matched: false,
				min_vram_gb: null,
				path: null,
				tps: null,
			}),
		useInstalledModels: () => [],
		ActiveModelControl: () => null,
		fitStyle: () => ({ className: "", dot: "" }),
		...over,
	};
}

function Consumer() {
	const host = useCatalogHost();
	return <span>{host.install ? "has-install" : "read-only"}</span>;
}

describe("useCatalogHost", () => {
	test("throws a helpful error when used outside a provider", () => {
		expect(() => renderToStaticMarkup(<Consumer />)).toThrow(
			/must be used within a <CatalogHostProvider>/
		);
	});

	test("returns the injected host when a provider is mounted", () => {
		const html = renderToStaticMarkup(
			<CatalogHostProvider host={stubHost()}>
				<Consumer />
			</CatalogHostProvider>
		);
		expect(html).toContain("read-only");
	});

	test("exposes the install layer identity through the context", () => {
		const html = renderToStaticMarkup(
			<CatalogHostProvider
				host={stubHost({
					install: { InstallButton: () => null },
				})}
			>
				<Consumer />
			</CatalogHostProvider>
		);
		expect(html).toContain("has-install");
	});
});

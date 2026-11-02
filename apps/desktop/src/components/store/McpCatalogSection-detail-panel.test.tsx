// The MCP detail panel renders the empty, loading and loaded states in one
// mounted instance: a selection that loads its detail must not change the
// panel's hook order (which threw "Rendered more hooks than during the
// previous render" and blanked the Store).

import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { McpCatalogDetail } from "@/src/lib/api/mcp.ts";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { McpDetailPanel } = await import(
	"@/src/components/store/McpCatalogSection-detail-panel.tsx"
);

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const detail: McpCatalogDetail = {
	card: {
		description: "Reads fixture files",
		hasPackages: true,
		hasRemotes: false,
		id: "io.github.fixture/files",
		installed: false,
		name: "Fixture Files",
		transports: ["stdio"],
		version: "1.2.0",
	},
	packages: [
		{
			fileSha256: null,
			identifier: "@fixture/files",
			registryBaseUrl: null,
			registryType: "npm",
			transport: "stdio",
			version: "1.2.0",
		},
	],
	remotes: [],
};

test("McpDetailPanel keeps one hook order from no selection through loading to a loaded detail", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const errors: unknown[] = [];
	const render = (props: {
		detail: McpCatalogDetail | null;
		loading: boolean;
		selectedId: string | null;
	}) =>
		act(() => {
			root.render(
				<McpDetailPanel
					error={null}
					install={async () => undefined}
					installing={null}
					{...props}
				/>
			);
		});
	const originalError = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args[0]);
	};
	try {
		await render({ detail: null, loading: false, selectedId: null });
		expect(host.textContent).toContain("No server selected");
		await render({ detail: null, loading: true, selectedId: detail.card.id });
		await render({ detail, loading: false, selectedId: detail.card.id });
		expect(host.textContent).toContain("Fixture Files");
		expect(host.textContent).toContain("Add server");
		await render({ detail: null, loading: false, selectedId: null });
		expect(host.textContent).toContain("No server selected");
	} finally {
		console.error = originalError;
		act(() => root.unmount());
		host.remove();
	}
	expect(
		errors.filter((message) => String(message).includes("order of Hooks"))
	).toEqual([]);
});

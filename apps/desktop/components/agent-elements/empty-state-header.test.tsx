import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { EmptyStateHeaderProps } from "./empty-state-header.tsx";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	value: true,
	configurable: true,
});

const { EmptyStateHeader } = await import("./empty-state-header.tsx");
const { useWorkspaceStore } = await import("@/src/store/useWorkspaceStore.ts");
const originalFolder = useWorkspaceStore.getState().folder;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);

async function renderHeader(props: EmptyStateHeaderProps) {
	await act(() => root.render(<EmptyStateHeader {...props} />));
	return container.innerHTML;
}

afterEach(async () => {
	await act(() => {
		useWorkspaceStore.setState({ folder: originalFolder });
	});
});

afterAll(async () => {
	await act(() => root.unmount());
	container.remove();
});

describe("EmptyStateHeader project context", () => {
	test("renders an accessible folder trigger using the actual workspace state", async () => {
		await act(() => {
			useWorkspaceStore.setState({ folder: "/Users/ryu/Documents/Code/ryu" });
		});
		const html = await renderHeader({
			interactiveLogo: false,
			logo: { kind: "image", url: "/agent.png" },
			sections: [],
		});
		const trigger = html.match(
			/<button[^>]*aria-label="Select project folder"[^>]*>/
		)?.[0];

		expect(trigger).toBeDefined();
		expect(trigger).toContain('title="/Users/ryu/Documents/Code/ryu"');
		expect(trigger).toContain('type="button"');
		expect(trigger).toContain('aria-haspopup="dialog"');
		expect(html).toContain("What are we doing in");
		expect(html).toContain(">ryu</span>");
	});

	test("keeps the title without exposing a folder picker when disabled", async () => {
		await act(() => {
			useWorkspaceStore.setState({ folder: "C:\\Code\\project" });
		});
		const html = await renderHeader({
			interactiveLogo: false,
			logo: { kind: "image", url: "/agent.png" },
			sections: [],
			showProjectPicker: false,
		});

		expect(html).toContain("What are we doing?");
		expect(html).not.toContain("Select project folder");
	});

	test("caps the engine fan and exposes centered offsets without inline styles", async () => {
		const html = await renderHeader({
			interactiveLogo: false,
			logo: {
				kind: "stack",
				engines: Array.from({ length: 6 }, () => "claude"),
			},
			sections: [],
			showProjectPicker: false,
		});

		expect(html.match(/data-offset=/g)).toHaveLength(5);
		for (const offset of [-2, -1, 0, 1, 2]) {
			expect(html).toContain(`data-offset="${offset}"`);
		}
		expect(html).not.toContain("translate(calc(");
	});
});

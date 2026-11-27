import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { DownloadableArtifact } from "@/src/lib/artifact-files.ts";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ArtifactDownloadButton } = await import("./ArtifactDownloadButton.tsx");

async function mount(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(node));
	return {
		button() {
			const button = container.querySelector<HTMLButtonElement>(
				'[data-testid="artifact-download"]'
			);
			if (!button) {
				throw new Error("the download button is not rendered");
			}
			return button;
		},
		async unmount() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

async function click(button: HTMLButtonElement) {
	await act(async () => {
		button.click();
		// Let the awaited bytes and the state update after them settle.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

const PAGE: DownloadableArtifact = {
	content: "<h1>Q3</h1>",
	kind: "html",
	title: "Q3 chart",
};

describe("ArtifactDownloadButton", () => {
	test("saves the content on screen under a name with the kind's ending", async () => {
		const saved: { blob: Blob; name: string }[] = [];
		const view = await mount(
			<ArtifactDownloadButton
				artifact={PAGE}
				save={(blob, name) => {
					saved.push({ blob, name });
				}}
			/>
		);
		try {
			expect(view.button().textContent?.trim()).toBe("Download");
			await click(view.button());
			expect(saved).toHaveLength(1);
			expect(saved[0]?.name).toBe("Q3 chart.html");
			expect(await saved[0]?.blob.text()).toBe("<h1>Q3</h1>");
			// Saved as plain text, so the object URL can never open as a page.
			expect(saved[0]?.blob.type.startsWith("text/plain")).toBe(true);
			expect(view.button().getAttribute("data-state")).toBe("idle");
		} finally {
			await view.unmount();
		}
	});

	test("a created artifact is saved from its stored bytes", async () => {
		const stored = new Blob(["a;b\n1;2"], { type: "text/csv" });
		const saved: { blob: Blob; name: string }[] = [];
		const view = await mount(
			<ArtifactDownloadButton
				artifact={{ content: "a,b\n1,2", kind: "database", title: "numbers" }}
				loadBlob={() => Promise.resolve(stored)}
				save={(blob, name) => {
					saved.push({ blob, name });
				}}
			/>
		);
		try {
			await click(view.button());
			expect(saved).toHaveLength(1);
			expect(saved[0]?.blob).toBe(stored);
			expect(saved[0]?.name).toBe("numbers.csv");
		} finally {
			await view.unmount();
		}
	});

	test("falls back to the content when the stored bytes cannot be read", async () => {
		const saved: { blob: Blob; name: string }[] = [];
		const view = await mount(
			<ArtifactDownloadButton
				artifact={PAGE}
				loadBlob={() => Promise.reject(new Error("offline"))}
				save={(blob, name) => {
					saved.push({ blob, name });
				}}
			/>
		);
		try {
			await click(view.button());
			expect(saved).toHaveLength(1);
			expect(await saved[0]?.blob.text()).toBe("<h1>Q3</h1>");
		} finally {
			await view.unmount();
		}
	});

	test("with nothing to save the button offers Retry, which can succeed", async () => {
		const answers: (Blob | null)[] = [null, new Blob(["%PDF-1.7"])];
		let saves = 0;
		const view = await mount(
			<ArtifactDownloadButton
				artifact={{ content: "", kind: "file", title: "report.pdf" }}
				loadBlob={() => Promise.resolve(answers.shift() ?? null)}
				save={() => {
					saves += 1;
				}}
			/>
		);
		try {
			await click(view.button());
			expect(saves).toBe(0);
			expect(view.button().getAttribute("data-state")).toBe("failed");
			expect(view.button().textContent?.trim()).toBe("Retry");
			await click(view.button());
			expect(saves).toBe(1);
			expect(view.button().getAttribute("data-state")).toBe("idle");
			expect(view.button().textContent?.trim()).toBe("Download");
		} finally {
			await view.unmount();
		}
	});

	test("is off when there is neither content nor stored bytes", async () => {
		const view = await mount(
			<ArtifactDownloadButton
				artifact={{ content: "", kind: "file", title: "empty" }}
			/>
		);
		try {
			expect(view.button().hasAttribute("disabled")).toBe(true);
		} finally {
			await view.unmount();
		}
	});
});

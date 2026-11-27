import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { FileCard } = await import("./file-card.tsx");

async function mount(node: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root: Root = createRoot(container);
	await act(async () => root.render(node));
	return {
		container,
		async unmount() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

function part(container: HTMLElement, testId: string) {
	return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

async function click(element: HTMLElement | null) {
	if (!element) {
		throw new Error("element is not rendered");
	}
	await act(async () => {
		element.click();
		// Let the awaited loader and the state update after it settle.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

const PDF = new Blob(["%PDF-1.7"], { type: "application/pdf" });

describe("FileCard", () => {
	test("shows the name, the type badge and the size", async () => {
		const view = await mount(
			<FileCard
				loadBlob={() => Promise.resolve(PDF)}
				mime="application/pdf"
				name="Q3 report.pdf"
				size={1536}
			/>
		);
		try {
			const card = part(view.container, "file-card");
			expect(card?.getAttribute("data-state")).toBe("ready");
			expect(part(view.container, "file-card-name")?.textContent).toBe(
				"Q3 report.pdf"
			);
			expect(part(view.container, "file-card-type")?.textContent).toBe("PDF");
			expect(part(view.container, "file-card-size")?.textContent).toBe(
				"1.5 KB"
			);
			expect(part(view.container, "file-card-status")?.textContent).toBe("");
			expect(
				part(view.container, "file-card-download")?.textContent?.trim()
			).toBe("Download");
			// No Open button without an open action.
			expect(part(view.container, "file-card-open")).toBeNull();
		} finally {
			await view.unmount();
		}
	});

	test("a file without an extension or a known type reads File, no size", async () => {
		const view = await mount(
			<FileCard loadBlob={() => Promise.resolve(PDF)} name="notes" />
		);
		try {
			expect(part(view.container, "file-card-type")?.textContent).toBe("File");
			expect(part(view.container, "file-card-size")).toBeNull();
		} finally {
			await view.unmount();
		}
	});

	test("Open calls the open action", async () => {
		let opened = 0;
		const view = await mount(
			<FileCard
				loadBlob={() => Promise.resolve(PDF)}
				name="a.pdf"
				onOpen={() => {
					opened += 1;
				}}
			/>
		);
		try {
			await click(part(view.container, "file-card-open"));
			expect(opened).toBe(1);
		} finally {
			await view.unmount();
		}
	});

	test("Download hands the bytes and the name to the browser, then says Downloaded", async () => {
		const saved: { blob: Blob; name: string }[] = [];
		const view = await mount(
			<FileCard
				loadBlob={() => Promise.resolve(PDF)}
				mime="application/pdf"
				name="Q3 report.pdf"
				save={(blob, name) => {
					saved.push({ blob, name });
				}}
			/>
		);
		try {
			await click(part(view.container, "file-card-download"));
			expect(saved).toHaveLength(1);
			expect(saved[0]?.blob).toBe(PDF);
			expect(saved[0]?.name).toBe("Q3 report.pdf");
			expect(
				part(view.container, "file-card")?.getAttribute("data-state")
			).toBe("downloaded");
			expect(part(view.container, "file-card-status")?.textContent).toBe(
				"Downloaded"
			);
		} finally {
			await view.unmount();
		}
	});

	test("the button is off while the bytes are on their way", async () => {
		let release: (blob: Blob | null) => void = () => undefined;
		const pending = new Promise<Blob | null>((resolve) => {
			release = resolve;
		});
		let saves = 0;
		const view = await mount(
			<FileCard
				loadBlob={() => pending}
				name="a.pdf"
				save={() => {
					saves += 1;
				}}
			/>
		);
		try {
			await click(part(view.container, "file-card-download"));
			const button = part(view.container, "file-card-download");
			expect(
				part(view.container, "file-card")?.getAttribute("data-state")
			).toBe("downloading");
			expect(button?.hasAttribute("disabled")).toBe(true);
			expect(part(view.container, "file-card-status")?.textContent).toBe(
				"Downloading…"
			);
			await act(async () => {
				release(PDF);
				await pending;
			});
			expect(saves).toBe(1);
			expect(
				part(view.container, "file-card")?.getAttribute("data-state")
			).toBe("downloaded");
		} finally {
			await view.unmount();
		}
	});

	test("a failed download says so and offers Retry, which can succeed", async () => {
		const answers: (Blob | null)[] = [null, PDF];
		let saves = 0;
		const view = await mount(
			<FileCard
				loadBlob={() => Promise.resolve(answers.shift() ?? null)}
				name="a.pdf"
				save={() => {
					saves += 1;
				}}
			/>
		);
		try {
			await click(part(view.container, "file-card-download"));
			expect(
				part(view.container, "file-card")?.getAttribute("data-state")
			).toBe("failed");
			expect(part(view.container, "file-card-status")?.textContent).toBe(
				"Could not read this file"
			);
			expect(
				part(view.container, "file-card-download")?.textContent?.trim()
			).toBe("Retry");
			expect(saves).toBe(0);
			await click(part(view.container, "file-card-download"));
			expect(saves).toBe(1);
			expect(
				part(view.container, "file-card")?.getAttribute("data-state")
			).toBe("downloaded");
		} finally {
			await view.unmount();
		}
	});

	test("a loader that throws ends in the failed state, not in an error", async () => {
		const view = await mount(
			<FileCard
				loadBlob={() => Promise.reject(new Error("offline"))}
				name="a.pdf"
			/>
		);
		try {
			await click(part(view.container, "file-card-download"));
			expect(
				part(view.container, "file-card")?.getAttribute("data-state")
			).toBe("failed");
		} finally {
			await view.unmount();
		}
	});

	test("without a loader the card says the file is gone and Download is off", async () => {
		const view = await mount(<FileCard name="gone.zip" />);
		try {
			expect(
				part(view.container, "file-card")?.getAttribute("data-state")
			).toBe("unavailable");
			expect(part(view.container, "file-card-status")?.textContent).toBe(
				"File not found"
			);
			expect(
				part(view.container, "file-card-download")?.hasAttribute("disabled")
			).toBe(true);
		} finally {
			await view.unmount();
		}
	});

	test("draws the preview it is given", async () => {
		const view = await mount(
			<FileCard
				loadBlob={() => Promise.resolve(PDF)}
				name="chart.png"
				preview={<div data-testid="story-preview">preview</div>}
			/>
		);
		try {
			expect(part(view.container, "story-preview")?.textContent).toBe(
				"preview"
			);
		} finally {
			await view.unmount();
		}
	});
});

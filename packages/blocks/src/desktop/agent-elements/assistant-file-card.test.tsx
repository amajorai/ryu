import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ArtifactHostValue } from "./artifact-host-context.tsx";

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

const { ArtifactHostContext } = await import("./artifact-host-context.tsx");
const { AssistantFileCard, MAX_OPEN_TEXT_BYTES } = await import(
	"./assistant-file-card.tsx"
);

async function mount(node: ReactNode) {
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
		// Let the decoded bytes and the state update after them settle.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

interface Opened {
	id: string;
	payload: { content?: unknown; mime?: unknown; title?: unknown };
}

function hostThatRecords(opened: Opened[]): ArtifactHostValue {
	return {
		fetchContent: () => Promise.resolve(null),
		openInPanel: (payload, id) => {
			opened.push({ id, payload });
		},
		openInTab: () => undefined,
		Renderer: () => null,
		submitFollowUp: () => undefined,
	};
}

// "a,b\n1,2" in base64: 7 bytes.
const CSV = {
	filename: "numbers.csv",
	media: "text/csv",
	url: "data:text/csv;base64,YSxiCjEsMg==",
};
// "%PDF-1.7" in base64: 8 bytes.
const PDF = {
	filename: "report.pdf",
	media: "application/pdf",
	url: "data:application/pdf;base64,JVBERi0xLjc=",
};

describe("AssistantFileCard", () => {
	test("shows the name, the type and the size of the inline bytes", async () => {
		const view = await mount(<AssistantFileCard file={PDF} id="m1-file-0" />);
		try {
			expect(part(view.container, "file-card-name")?.textContent).toBe(
				"report.pdf"
			);
			expect(part(view.container, "file-card-type")?.textContent).toBe("PDF");
			expect(part(view.container, "file-card-size")?.textContent).toBe("8 B");
			expect(
				part(view.container, "file-card")?.getAttribute("data-state")
			).toBe("ready");
		} finally {
			await view.unmount();
		}
	});

	test("a declared size wins over the computed one", async () => {
		const view = await mount(
			<AssistantFileCard file={{ ...PDF, size: 2048 }} id="m1-file-0" />
		);
		try {
			expect(part(view.container, "file-card-size")?.textContent).toBe(
				"2.0 KB"
			);
		} finally {
			await view.unmount();
		}
	});

	test("Download decodes the data URL and hands over the bytes", async () => {
		const saved: { blob: Blob; name: string }[] = [];
		const view = await mount(
			<AssistantFileCard
				file={PDF}
				id="m1-file-0"
				save={(blob, name) => {
					saved.push({ blob, name });
				}}
			/>
		);
		try {
			await click(part(view.container, "file-card-download"));
			expect(saved).toHaveLength(1);
			expect(saved[0]?.name).toBe("report.pdf");
			expect(await saved[0]?.blob.text()).toBe("%PDF-1.7");
			expect(
				part(view.container, "file-card")?.getAttribute("data-state")
			).toBe("downloaded");
		} finally {
			await view.unmount();
		}
	});

	test("a payload that does not decode ends in the failed state", async () => {
		let saves = 0;
		const view = await mount(
			<AssistantFileCard
				file={{ ...PDF, url: "data:application/pdf;base64,%%%" }}
				id="m1-file-0"
				save={() => {
					saves += 1;
				}}
			/>
		);
		try {
			await click(part(view.container, "file-card-download"));
			expect(saves).toBe(0);
			expect(
				part(view.container, "file-card")?.getAttribute("data-state")
			).toBe("failed");
		} finally {
			await view.unmount();
		}
	});

	test("an address on the web is not read: the card shows it as unavailable", async () => {
		let saves = 0;
		const view = await mount(
			<ArtifactHostContext.Provider value={hostThatRecords([])}>
				<AssistantFileCard
					file={{ ...CSV, size: 7, url: "https://files.example.com/a.csv" }}
					id="m1-file-0"
					save={() => {
						saves += 1;
					}}
				/>
			</ArtifactHostContext.Provider>
		);
		try {
			expect(
				part(view.container, "file-card")?.getAttribute("data-state")
			).toBe("unavailable");
			expect(
				part(view.container, "file-card-download")?.hasAttribute("disabled")
			).toBe(true);
			expect(part(view.container, "file-card-open")).toBeNull();
			await click(part(view.container, "file-card-download"));
			expect(saves).toBe(0);
		} finally {
			await view.unmount();
		}
	});

	test("Open shows a text file in the artifact panel", async () => {
		const opened: Opened[] = [];
		const view = await mount(
			<ArtifactHostContext.Provider value={hostThatRecords(opened)}>
				<AssistantFileCard file={CSV} id="m1-file-0" />
			</ArtifactHostContext.Provider>
		);
		try {
			await click(part(view.container, "file-card-open"));
			// Reading the text of the decoded bytes takes a few more turns.
			for (let turn = 0; turn < 50 && opened.length === 0; turn += 1) {
				await act(async () => {
					await new Promise((resolve) => setTimeout(resolve, 5));
				});
			}
			expect(opened).toHaveLength(1);
			expect(opened[0]?.id).toBe("m1-file-0");
			expect(opened[0]?.payload).toEqual({
				content: "a,b\n1,2",
				mime: "text/csv",
				title: "numbers.csv",
			});
		} finally {
			await view.unmount();
		}
	});

	test("no Open button without a host", async () => {
		const view = await mount(<AssistantFileCard file={CSV} id="m1-file-0" />);
		try {
			expect(part(view.container, "file-card-open")).toBeNull();
			expect(part(view.container, "file-card-download")).not.toBeNull();
		} finally {
			await view.unmount();
		}
	});

	test("no Open button for a file the panel cannot show", async () => {
		const view = await mount(
			<ArtifactHostContext.Provider value={hostThatRecords([])}>
				<AssistantFileCard file={PDF} id="m1-file-0" />
			</ArtifactHostContext.Provider>
		);
		try {
			expect(part(view.container, "file-card-open")).toBeNull();
		} finally {
			await view.unmount();
		}
	});

	test("no Open button for a text file over the size limit", async () => {
		const view = await mount(
			<ArtifactHostContext.Provider value={hostThatRecords([])}>
				<AssistantFileCard
					file={{ ...CSV, size: MAX_OPEN_TEXT_BYTES + 1 }}
					id="m1-file-0"
				/>
			</ArtifactHostContext.Provider>
		);
		try {
			expect(part(view.container, "file-card-open")).toBeNull();
		} finally {
			await view.unmount();
		}
	});
});

import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	ArtifactHostValue,
	NativeArtifactObservation,
} from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import type { ReactNode } from "react";

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
const { ArtifactHostContext } = await import(
	"@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx"
);
const { InlineFileArtifact, MAX_PREVIEW_BYTES } = await import(
	"./InlineFileArtifact.tsx"
);

const SPACE = "0b6f8f0e-0d0c-4c57-9a55-5f2f3a8f4c11";
const DOC = "7d0c1a52-3d1e-4e0a-8a43-0b1c2d3e4f50";
const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function created(
	fields: Partial<Record<keyof NativeArtifactObservation, unknown>>
): NativeArtifactObservation {
	return {
		docId: DOC,
		spaceId: SPACE,
		url: `/api/spaces/${SPACE}/documents/${DOC}/blob`,
		...fields,
	};
}

interface HostLog {
	fetched: string[];
	opened: string[];
}

function host(
	log: HostLog,
	answer: () => Promise<Blob | null>
): ArtifactHostValue {
	return {
		fetchBlob: (_payload, id) => {
			log.fetched.push(id);
			return answer();
		},
		fetchContent: () => Promise.resolve(null),
		openFile: (_payload, id) => {
			log.opened.push(id);
		},
		openInPanel: () => undefined,
		openInTab: () => undefined,
		Renderer: () => null,
		submitFollowUp: () => undefined,
	};
}

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
}

async function mount(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(node));
	await settle();
	return {
		container,
		part(testId: string) {
			return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
		},
		async unmount() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

async function click(element: HTMLElement | null) {
	if (!element) {
		throw new Error("element is not rendered");
	}
	await act(async () => {
		element.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await settle();
}

describe("InlineFileArtifact", () => {
	test("an office file is a card with Download and Open, and no preview", async () => {
		const log: HostLog = { fetched: [], opened: [] };
		const docx = new Blob(["PK"], { type: DOCX_MIME });
		const saved: { blob: Blob; name: string }[] = [];
		const view = await mount(
			<ArtifactHostContext.Provider
				value={host(log, () => Promise.resolve(docx))}
			>
				<InlineFileArtifact
					artifact={created({
						byteSize: 48_213,
						mime: DOCX_MIME,
						title: "Offer letter.docx",
					})}
					id="artifact-call-1"
					save={(blob, name) => {
						saved.push({ blob, name });
					}}
				/>
			</ArtifactHostContext.Provider>
		);
		try {
			expect(view.part("file-card-name")?.textContent).toBe(
				"Offer letter.docx"
			);
			expect(view.part("file-card-type")?.textContent).toBe("DOCX");
			expect(view.part("file-card-size")?.textContent).toBe("47.1 KB");
			expect(view.part("file-preview-loading")).toBeNull();
			expect(view.part("file-preview-image")).toBeNull();
			// Nothing is read from the node until the user asks for the file.
			expect(log.fetched).toHaveLength(0);

			await click(view.part("file-card-open"));
			expect(log.opened).toEqual(["artifact-call-1"]);

			await click(view.part("file-card-download"));
			expect(log.fetched).toEqual(["artifact-call-1"]);
			expect(saved).toHaveLength(1);
			expect(saved[0]?.blob).toBe(docx);
			expect(saved[0]?.name).toBe("Offer letter.docx");
			expect(view.part("file-card")?.getAttribute("data-state")).toBe(
				"downloaded"
			);
		} finally {
			await view.unmount();
		}
	});

	test("an image previews inline and Download reuses the bytes", async () => {
		const log: HostLog = { fetched: [], opened: [] };
		const png = new Blob(["\u0089PNG"], { type: "application/octet-stream" });
		let saves = 0;
		const view = await mount(
			<ArtifactHostContext.Provider
				value={host(log, () => Promise.resolve(png))}
			>
				<InlineFileArtifact
					artifact={created({
						byteSize: 4,
						mime: "image/png",
						title: "chart.png",
					})}
					id="artifact-call-2"
					save={() => {
						saves += 1;
					}}
				/>
			</ArtifactHostContext.Provider>
		);
		try {
			const image = view
				.part("file-preview-image")
				?.querySelector<HTMLImageElement>("img");
			expect(image?.getAttribute("alt")).toBe("chart.png");
			expect(image?.getAttribute("src")?.startsWith("blob:")).toBe(true);
			expect(log.fetched).toHaveLength(1);
			// The viewer tab has nothing to show for a picture: no Open button.
			expect(view.part("file-card-open")).toBeNull();

			await click(view.part("file-card-download"));
			expect(saves).toBe(1);
			expect(log.fetched).toHaveLength(1);
		} finally {
			await view.unmount();
		}
	});

	test("a preview that cannot be read says so and the card stays usable", async () => {
		const log: HostLog = { fetched: [], opened: [] };
		const view = await mount(
			<ArtifactHostContext.Provider
				value={host(log, () => Promise.resolve(null))}
			>
				<InlineFileArtifact
					artifact={created({
						byteSize: 4,
						mime: "image/png",
						title: "chart.png",
					})}
					id="artifact-call-3"
				/>
			</ArtifactHostContext.Provider>
		);
		try {
			expect(view.part("file-preview-failed")?.textContent).toBe(
				"Could not load the preview."
			);
			expect(view.part("file-card")?.getAttribute("data-state")).toBe("ready");
			// The failed read is not kept: Download asks the node again.
			await click(view.part("file-card-download"));
			expect(log.fetched).toHaveLength(2);
			expect(view.part("file-card")?.getAttribute("data-state")).toBe("failed");
		} finally {
			await view.unmount();
		}
	});

	test("a very large image gets no automatic preview", async () => {
		const log: HostLog = { fetched: [], opened: [] };
		const view = await mount(
			<ArtifactHostContext.Provider
				value={host(log, () => Promise.resolve(new Blob(["x"])))}
			>
				<InlineFileArtifact
					artifact={created({
						byteSize: MAX_PREVIEW_BYTES + 1,
						mime: "image/png",
						title: "scan.png",
					})}
					id="artifact-call-4"
				/>
			</ArtifactHostContext.Provider>
		);
		try {
			expect(view.part("file-preview-image")).toBeNull();
			expect(view.part("file-preview-loading")).toBeNull();
			expect(log.fetched).toHaveLength(0);
		} finally {
			await view.unmount();
		}
	});

	test.each([
		["image/png", "photo.png"],
		["application/pdf", "report.pdf"],
	])("a %s of unknown size gets no automatic preview, Download still reads it", async (mime, title) => {
		const log: HostLog = { fetched: [], opened: [] };
		let saves = 0;
		const view = await mount(
			<ArtifactHostContext.Provider
				value={host(log, () => Promise.resolve(new Blob(["x"])))}
			>
				<InlineFileArtifact
					artifact={created({ mime, title })}
					id="artifact-call-8"
					save={() => {
						saves += 1;
					}}
				/>
			</ArtifactHostContext.Provider>
		);
		try {
			expect(view.part("file-preview-image")).toBeNull();
			expect(view.part("file-preview-pdf")).toBeNull();
			expect(view.part("file-preview-loading")).toBeNull();
			expect(log.fetched).toHaveLength(0);
			await click(view.part("file-card-download"));
			expect(log.fetched).toEqual(["artifact-call-8"]);
			expect(saves).toBe(1);
		} finally {
			await view.unmount();
		}
	});

	test("an image preview never keeps the type the node answered with", async () => {
		const log: HostLog = { fetched: [], opened: [] };
		const handed: Blob[] = [];
		const createObjectURL = URL.createObjectURL;
		Reflect.set(URL, "createObjectURL", (source: Blob) => {
			handed.push(source);
			return "blob:test/preview";
		});
		const page = new Blob(["<script>alert(1)</script>"], { type: "text/html" });
		// The tool result names no type, so the ending of the name decides.
		const view = await mount(
			<ArtifactHostContext.Provider
				value={host(log, () => Promise.resolve(page))}
			>
				<InlineFileArtifact
					artifact={created({ byteSize: 25, title: "photo.png" })}
					id="artifact-call-9"
				/>
			</ArtifactHostContext.Provider>
		);
		try {
			expect(log.fetched).toEqual(["artifact-call-9"]);
			expect(handed).toHaveLength(1);
			expect(handed[0]?.type).toBe("image/png");
		} finally {
			Reflect.set(URL, "createObjectURL", createObjectURL);
			await view.unmount();
		}
	});

	test("a payload that names no stored file is shown as unavailable", async () => {
		const log: HostLog = { fetched: [], opened: [] };
		const view = await mount(
			<ArtifactHostContext.Provider
				value={host(log, () => Promise.resolve(new Blob(["x"])))}
			>
				<InlineFileArtifact
					artifact={{
						mime: "application/zip",
						title: "bundle.zip",
						url: "https://files.example.com/bundle.zip",
					}}
					id="artifact-call-5"
				/>
			</ArtifactHostContext.Provider>
		);
		try {
			expect(view.part("file-card")?.getAttribute("data-state")).toBe(
				"unavailable"
			);
			expect(view.part("file-card-download")?.hasAttribute("disabled")).toBe(
				true
			);
			expect(view.part("file-card-open")).toBeNull();
			expect(log.fetched).toHaveLength(0);
		} finally {
			await view.unmount();
		}
	});

	test("without a host the card still shows the file, with Download off", async () => {
		const view = await mount(
			<InlineFileArtifact
				artifact={created({ mime: "application/zip", title: "bundle.zip" })}
				id="artifact-call-6"
			/>
		);
		try {
			expect(view.part("file-card-name")?.textContent).toBe("bundle.zip");
			expect(view.part("file-card-type")?.textContent).toBe("ZIP");
			expect(view.part("file-card")?.getAttribute("data-state")).toBe(
				"unavailable"
			);
		} finally {
			await view.unmount();
		}
	});

	test("a file without a title or a type still gets a card", async () => {
		const log: HostLog = { fetched: [], opened: [] };
		const view = await mount(
			<ArtifactHostContext.Provider
				value={host(log, () => Promise.resolve(new Blob(["x"])))}
			>
				<InlineFileArtifact artifact={created({})} id="artifact-call-7" />
			</ArtifactHostContext.Provider>
		);
		try {
			expect(view.part("file-card-name")?.textContent).toBe("Untitled file");
			expect(view.part("file-card-type")?.textContent).toBe("File");
			expect(view.part("file-card-size")).toBeNull();
			expect(view.part("file-card")?.getAttribute("data-state")).toBe("ready");
		} finally {
			await view.unmount();
		}
	});
});

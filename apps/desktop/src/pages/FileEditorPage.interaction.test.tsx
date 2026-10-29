import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let changeMarkdown: (text: string) => void;
let read: (path: string) => Promise<string>;
let write: (path: string, text: string) => Promise<void>;
const reads: string[] = [];
const writes: { path: string; text: string }[] = [];
const errors: string[] = [];
const contexts: { id: string; title: string; text: string }[] = [];
mock.module("@/src/components/editor/MarkdownEditor.tsx", () => ({
	MarkdownEditor: ({
		initialMarkdown,
		onChangeMarkdown,
	}: {
		initialMarkdown: string;
		onChangeMarkdown: (text: string) => void;
	}) => {
		changeMarkdown = onChangeMarkdown;
		return <div data-editor="true">{initialMarkdown}</div>;
	},
}));
mock.module("@/src/hooks/useAssistantPageContext.ts", () => ({
	useAssistantPageContext: (context: {
		id: string;
		title: string;
		text: string;
	}) => contexts.push(context),
}));
mock.module("@/src/lib/files.ts", () => ({
	basename: (path: string) => path.split("/").at(-1),
	readProjectFile: (path: string) => {
		reads.push(path);
		return read(path);
	},
	writeProjectFile: (path: string, text: string) => {
		writes.push({ path, text });
		return write(path, text);
	},
}));
mock.module("@ryu/ui/components/sileo", () => ({
	toast: { error: (message: string) => errors.push(message) },
}));
const { default: FileEditorPage } = await import("./FileEditorPage.tsx");
let container: HTMLDivElement;
let root: Root;
let mounted: boolean;
beforeEach(() => {
	reads.length = 0;
	writes.length = 0;
	errors.length = 0;
	contexts.length = 0;
	read = async (path) => `Contents of ${path}`;
	write = async () => {};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	mounted = true;
});
afterEach(async () => {
	if (mounted) await act(async () => root.unmount());
	container.remove();
});
async function render(path = "/project/notes.md") {
	await act(async () => root.render(<FileEditorPage filePath={path} />));
}
async function edit(text: string) {
	await act(async () => changeMarkdown(text));
}
async function debounce() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 850));
	});
}
async function click(label: string) {
	const button = Array.from(container.querySelectorAll("button")).find(
		(item) => item.textContent?.trim() === label
	);
	if (!button) throw new Error(`Missing file editor action ${label}`);
	await act(async () => button.click());
}
test("reads the selected file and provides capped assistant context without writing unchanged content", async () => {
	read = async () => "x".repeat(5000);
	await render();
	expect(reads).toEqual(["/project/notes.md"]);
	expect(
		container.querySelector('[data-editor="true"]')?.textContent
	).toHaveLength(5000);
	expect(contexts.at(-1)).toEqual({
		id: "file:/project/notes.md",
		title: "notes.md",
		text: "x".repeat(4000),
	});
	expect(writes).toEqual([]);
});
test("debounces successive edits into one write of the latest complete markdown", async () => {
	await render();
	await edit("first");
	await edit("second");
	await edit("# Final\n\nComplete body");
	expect(writes).toEqual([]);
	await debounce();
	expect(writes).toEqual([
		{ path: "/project/notes.md", text: "# Final\n\nComplete body" },
	]);
	expect(container.textContent).toContain("Saved");
});
test("a failed save retains edits and Retry persists the same content", async () => {
	let failures = 1;
	write = async () => {
		if (failures-- > 0) throw new Error("Disk unavailable");
	};
	await render();
	await edit("Important unsaved changes");
	await debounce();
	expect(container.textContent).toContain("Save failed");
	expect(errors).toEqual(["Couldn't save your changes"]);
	await click("Retry");
	expect(writes).toEqual(
		Array.from({ length: 2 }, () => ({
			path: "/project/notes.md",
			text: "Important unsaved changes",
		}))
	);
	expect(container.textContent).toContain("Saved");
});
test("file read errors can retry and late results from a previous file never replace the selected file", async () => {
	let finishRead: ((text: string) => void) | undefined;
	read = (path) =>
		path.endsWith("old.md")
			? new Promise((resolve) => {
					finishRead = resolve;
				})
			: Promise.reject(new Error("Read unavailable"));
	await render("/project/old.md");
	await render("/project/new.md");
	expect(container.textContent).toContain("Could not open file");
	read = async () => "Selected file";
	await click("Try again");
	await act(async () => finishRead?.("Stale old file"));
	expect(container.querySelector('[data-editor="true"]')?.textContent).toBe(
		"Selected file"
	);
	expect(reads).toEqual([
		"/project/old.md",
		"/project/new.md",
		"/project/new.md",
	]);
});
test("navigating flushes pending edits only to their original file and unmount does not rewrite an untouched new file", async () => {
	await render("/project/first.md");
	await edit("First file edits");
	await render("/project/second.md");
	expect(container.textContent).not.toContain("Saving…");
	expect(container.textContent).not.toContain("Saved");
	expect(writes).toEqual([
		{ path: "/project/first.md", text: "First file edits" },
	]);
	await act(async () => root.unmount());
	mounted = false;
	expect(writes).toHaveLength(1);
});
test("closing the editor flushes a pending debounced write", async () => {
	await render();
	await edit("Preserve before close");
	await act(async () => root.unmount());
	mounted = false;
	expect(writes).toEqual([
		{ path: "/project/notes.md", text: "Preserve before close" },
	]);
});
test("autosave serializes writes so an older slow save cannot overwrite a newer edit", async () => {
	let finishFirst: (() => void) | undefined;
	write = async (_path, text) => {
		if (text === "First version")
			await new Promise<void>((resolve) => {
				finishFirst = resolve;
			});
	};
	await render();
	await edit("First version");
	await debounce();
	await edit("Latest version");
	await debounce();
	expect(writes).toEqual([
		{ path: "/project/notes.md", text: "First version" },
	]);
	expect(container.textContent).toContain("Saving…");
	await act(async () => finishFirst?.());
	expect(writes).toEqual([
		{ path: "/project/notes.md", text: "First version" },
		{ path: "/project/notes.md", text: "Latest version" },
	]);
	expect(container.textContent).toContain("Saved");
});

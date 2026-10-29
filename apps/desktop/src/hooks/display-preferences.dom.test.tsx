import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	DEFAULT_DIFF_VIEW_PREFS,
	type DiffViewPrefs,
	useDiffViewPrefs,
} from "./useDiffViewPrefs.ts";
import {
	DEFAULT_FILE_TREE_PREFS,
	type FileTreePrefs,
	useFileTreePrefs,
} from "./useFileTreePrefs.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root = createRoot(document.createElement("div"));
let diff: DiffViewPrefs = DEFAULT_DIFF_VIEW_PREFS;
let tree: FileTreePrefs = DEFAULT_FILE_TREE_PREFS;
function Preferences() {
	diff = useDiffViewPrefs();
	tree = useFileTreePrefs();
	return null;
}
afterEach(async () => {
	await act(() => root.unmount());
	root = createRoot(document.createElement("div"));
	localStorage.clear();
});
test("restores valid partial display preferences over the established defaults", async () => {
	localStorage.setItem(
		"ryu:diff-view-prefs",
		JSON.stringify({ diffStyle: "unified", wrapLines: true })
	);
	localStorage.setItem(
		"ryu:file-tree-prefs",
		JSON.stringify({ density: "compact", stickyFolders: false })
	);
	await act(() => root.render(<Preferences />));
	expect(diff).toEqual({
		...DEFAULT_DIFF_VIEW_PREFS,
		diffStyle: "unified",
		wrapLines: true,
	});
	expect(tree).toEqual({
		...DEFAULT_FILE_TREE_PREFS,
		density: "compact",
		stickyFolders: false,
	});
});
test("rejects malformed persisted enum and boolean fields before handing them to viewers", async () => {
	localStorage.setItem(
		"ryu:diff-view-prefs",
		JSON.stringify({ diffStyle: "unsupported", showBackground: "false" })
	);
	localStorage.setItem(
		"ryu:file-tree-prefs",
		JSON.stringify({ density: "unsupported", dragAndDrop: "true" })
	);
	await act(() => root.render(<Preferences />));
	expect(diff).toEqual(DEFAULT_DIFF_VIEW_PREFS);
	expect(tree).toEqual(DEFAULT_FILE_TREE_PREFS);
});

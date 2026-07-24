// Unit tests for the swappable editor uploader registry. Module-level singleton
// -> each test resets to the default (`setEditorUploader(null)`) so state does
// not leak across the single-process `bun test src` run.

import { afterEach, describe, expect, test } from "bun:test";
import {
	type EditorUploader,
	getEditorUploader,
	setEditorUploader,
} from "./editor-upload.ts";

afterEach(() => {
	setEditorUploader(null);
});

describe("editor uploader registry", () => {
	test("default uploader returns an object URL echoing the file metadata", async () => {
		const file = new File(["hello"], "note.txt", { type: "text/plain" });
		const result = await getEditorUploader()(file);
		expect(result.name).toBe("note.txt");
		expect(result.type).toBe(file.type);
		expect(result.size).toBe(file.size);
		expect(result.url.startsWith("blob:")).toBe(true);
	});

	test("a registered host uploader takes over", async () => {
		const seen: number[] = [];
		const host: EditorUploader = (file, onProgress) => {
			onProgress?.(100);
			return Promise.resolve({
				url: `https://media/${file.name}`,
				name: file.name,
				size: file.size,
				type: file.type,
			});
		};
		setEditorUploader(host);
		const file = new File(["x"], "a.png", { type: "image/png" });
		const result = await getEditorUploader()(file, (p) => seen.push(p));
		expect(result.url).toBe("https://media/a.png");
		expect(seen).toEqual([100]);
	});

	test("passing null restores the default object-URL uploader", async () => {
		setEditorUploader(() =>
			Promise.resolve({ url: "https://x", name: "n", size: 1, type: "t" })
		);
		setEditorUploader(null);
		const result = await getEditorUploader()(
			new File(["y"], "b.bin", { type: "application/octet-stream" })
		);
		expect(result.url.startsWith("blob:")).toBe(true);
	});
});

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FileExtIcon } from "./file-ext-icon.tsx";

test("recognizes script and JSON extensions case-insensitively", () => {
	for (const filename of [
		"test.ts",
		"test.TSX",
		"test.js",
		"test.mjs",
		"test.cjs",
		"test.jsx",
		"test.json",
		"test.JSONC",
	]) {
		const html = renderToStaticMarkup(<FileExtIcon filename={filename} />);
		expect(html).toContain('viewBox="0 0 32 32"');
		expect(html).toContain("w-2.5 h-2.5 shrink-0");
	}
	expect(renderToStaticMarkup(<FileExtIcon filename="notes.md" />)).toBe("");
});

test("a caller class replaces the default icon geometry", () => {
	const html = renderToStaticMarkup(
		<FileExtIcon className="size-6" filename="test.ts" />
	);
	expect(html).toContain("size-6");
	expect(html).not.toContain("w-2.5");
	expect(html).not.toContain("h-2.5");
});

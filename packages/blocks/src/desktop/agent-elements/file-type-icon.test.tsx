import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FileTypeIcon } from "./file-type-icon.tsx";

test("renders the matching complete icon symbol without the full sprite sheet", () => {
	const markup = renderToStaticMarkup(
		<FileTypeIcon className="size-4" path="src/App.tsx" />
	);
	expect(markup).toContain("file-tree-builtin-react");
	expect(markup).toContain("<symbol");
	expect(markup.match(/<symbol/g)).toHaveLength(1);
});

test("uses colored document icons for common attachment formats", () => {
	const markup = renderToStaticMarkup(
		<FileTypeIcon className="size-4" path="Startup Runway v2.0.pdf" />
	);

	expect(markup).toContain("text-red-500");
	expect(markup).not.toContain("file-tree-builtin-file");
});

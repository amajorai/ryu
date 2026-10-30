import { readFileSync } from "node:fs";

const PARTIAL_IMPORT = /^@import "\.\/(globals\/[^"]+\.css)";$/gm;

/**
 * The shared stylesheet as one text: `globals.css` with its `./globals/*.css`
 * partials inlined in place, in import order. For tests that assert on rules
 * that live in a partial without caring which one.
 */
export function readSharedGlobals(): string {
	return readFileSync(
		new URL("./globals.css", import.meta.url),
		"utf8"
	).replace(PARTIAL_IMPORT, (_match, partial: string) =>
		readFileSync(new URL(`./${partial}`, import.meta.url), "utf8")
	);
}

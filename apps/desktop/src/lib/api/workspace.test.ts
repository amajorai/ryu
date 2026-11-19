import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { directoryListFailure } from "./workspace.ts";

test("a folder listing without a Core reason fails with a catalogued sentence", () => {
	const tl: LiteralMessage = (source, values) =>
		`[${source}]${values ? JSON.stringify(values) : ""}`;
	expect(directoryListFailure(500, tl)).toBe(
		'[Couldn\'t list this folder ({status}).]{"status":"500"}'
	);
	expect(directoryListFailure(404)).toBe("Couldn't list this folder (404).");
});

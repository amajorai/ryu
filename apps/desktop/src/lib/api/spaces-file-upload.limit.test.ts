import { afterEach, describe, expect, it } from "bun:test";
import {
	formatMessage,
	type LiteralMessage,
	type MessageValuesInput,
} from "@ryu/i18n";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import type { ApiTarget } from "./client.ts";
import { replaceSpaceFileBlob, uploadSpaceFile } from "./spaces-file-upload.ts";
import { SPACE_UPLOAD_MAX_BYTES } from "./spaces-upload-limits.ts";

const NAMED_LIMIT = "{name} is {size} — the limit is {limit}.";
const UNNAMED_LIMIT = "This file is {size} — the limit is {limit}.";
const GERMAN: Record<string, string> = {
	[NAMED_LIMIT]: "{name} ist {size} groß – erlaubt sind {limit}.",
	[UNNAMED_LIMIT]: "Diese Datei ist {size} groß – erlaubt sind {limit}.",
};

const target: ApiTarget = { token: null, url: "http://127.0.0.1:1" };

/** A blob that reports a size past the limit without allocating it. */
function oversized<T extends Blob>(blob: T): T {
	Object.defineProperty(blob, "size", { value: SPACE_UPLOAD_MAX_BYTES + 1 });
	return blob;
}

const germanTl: LiteralMessage = (source, values) =>
	formatMessage(GERMAN[source] ?? source, values ?? {}, "de");

const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		const source = fallback ?? id;
		return formatMessage(GERMAN[source] ?? source, values, "de");
	},
};

describe("Space upload size limit", () => {
	afterEach(() => unregisterActiveI18nRuntime(german));

	it("refuses an oversized upload with a translated sentence", async () => {
		const file = oversized(new File(["x"], "bericht.pdf"));
		const error = await uploadSpaceFile(target, "space", file, {
			tl: germanTl,
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message.startsWith("bericht.pdf ist ")).toBe(true);
		expect(message).toContain("erlaubt sind");
		expect(message).not.toContain("the limit is");
	});

	it("refuses an oversized revision in the UI language", async () => {
		registerActiveI18nRuntime(german);
		const blob = oversized(new Blob(["x"]));
		const error = await replaceSpaceFileBlob(
			target,
			"space",
			"doc",
			blob,
			"application/pdf"
		).catch((caught: unknown) => caught);
		const message = (error as Error).message;
		expect(message.startsWith("Diese Datei ist ")).toBe(true);
		expect(message).not.toContain("{size}");
	});

	it("keeps the English sentence without a language pack", async () => {
		const blob = oversized(new Blob(["x"]));
		const error = await replaceSpaceFileBlob(
			target,
			"space",
			"doc",
			blob,
			"application/pdf"
		).catch((caught: unknown) => caught);
		expect((error as Error).message).toMatch(
			/^This file is .+ — the limit is .+\.$/u
		);
	});
});

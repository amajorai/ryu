import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { fileToDataUrl } from "./uploads.ts";

const ownsBrowserGlobals = !Reflect.has(globalThis, "FileReader");
if (ownsBrowserGlobals) {
	GlobalRegistrator.register();
}
afterAll(async () => {
	if (ownsBrowserGlobals) {
		await GlobalRegistrator.unregister();
	}
});

test("actual installed FileReader preserves empty, Unicode, NUL and newline bytes across native MIME types", async () => {
	for (const type of [
		"",
		"image/png",
		"text/plain",
		"application/octet-stream",
	]) {
		for (const bytes of ["", "hello", "雪🔐\u0000", "line1\nline2"]) {
			const file = new File([bytes], "native-file", { type });
			const result = await fileToDataUrl(file);
			expect(result.startsWith("data:")).toBe(true);
			expect(result.slice(result.indexOf(",") + 1)).toBe(
				Buffer.from(bytes).toString("base64")
			);
		}
	}
});

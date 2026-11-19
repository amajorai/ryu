import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIALOG = fileURLToPath(
	new URL("./oauth-app-registration-dialog.tsx", import.meta.url)
);
const CATALOG = fileURLToPath(
	new URL("../../../../i18n/locales/en.json", import.meta.url)
);

// SensitiveValue translates its `label` before splicing it into
// "Reveal {label}", so the label must be a catalog key or it stays English.
test("the dialog's secret labels are catalog keys", () => {
	const catalog = new Set(
		JSON.parse(readFileSync(CATALOG, "utf8")) as readonly string[]
	);
	const labels = [
		...readFileSync(DIALOG, "utf8").matchAll(
			/<SensitiveValue\s+label="([^"]+)"/gu
		),
	].map((match) => match[1] ?? "");
	expect(labels).toEqual(["Client secret"]);
	for (const label of labels) {
		expect(catalog.has(label)).toBe(true);
	}
});

import { describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";

// The shared module loads the API client, which reads browser globals when it
// is first evaluated. Register the DOM before importing it, as the editor's
// render tests do, so this file can share a `bun test` process with them in any
// order.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const { createEnvironment, paneErrorHeadline } = await import(
	"./CloudEnvironmentsSettings-shared.ts"
);

const GERMAN: Record<string, string> = {
	"Couldn't read the saved cloud environment settings.":
		"Die gespeicherten Cloud-Umgebungseinstellungen konnten nicht gelesen werden.",
	"New environment": "Neue Umgebung",
};
const german: LiteralMessage = (source, values) =>
	formatMessage(GERMAN[source] ?? source, values ?? {});
const english: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

describe("createEnvironment", () => {
	it("names a new environment in the creator's language", () => {
		expect(createEnvironment(german).name).toBe("Neue Umgebung");
	});

	it("keeps the English default and a fresh id per environment", () => {
		const first = createEnvironment(english);
		const second = createEnvironment(english);
		expect(first.name).toBe("New environment");
		expect(first.id).not.toBe(second.id);
		expect(first.repositories).toEqual([]);
	});
});

describe("paneErrorHeadline", () => {
	it("headlines a technical parser error in the reader's language", () => {
		expect(paneErrorHeadline("Invalid cloud environment state", german)).toBe(
			"Die gespeicherten Cloud-Umgebungseinstellungen konnten nicht gelesen werden."
		);
	});

	it("shows a server sentence as written", () => {
		expect(paneErrorHeadline("Quota reached.", german)).toBe("Quota reached.");
	});
});

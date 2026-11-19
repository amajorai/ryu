import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LiteralMessage } from "@ryu/i18n/react";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const { engineSlotsLabel } = await import("./NodeSelector-engines.tsx");

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

test("the engine queue badge words its slots as one catalogued phrase", () => {
	expect(engineSlotsLabel(2, 4, tl)).toBe(
		'[{busy}/{total, plural, one {# slot} other {# slots}}]{"busy":2,"total":4}'
	);
	expect(engineSlotsLabel(3, 0, tl)).toBe('[{busy} busy]{"busy":3}');
});

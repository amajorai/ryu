import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LiteralMessage } from "@ryu/i18n/react";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const { copyActionLabel } = await import("./ApiSection.tsx");

test("the copy button names its row in the reader's language", () => {
	const tl: LiteralMessage = (source, values) =>
		`[${source}]${values ? JSON.stringify(values) : ""}`;
	expect(copyActionLabel("OpenAI compatible", tl)).toBe(
		'[Copy {label}]{"label":"[OpenAI compatible]"}'
	);
});

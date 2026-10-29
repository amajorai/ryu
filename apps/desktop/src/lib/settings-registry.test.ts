import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

const { listSettings, resetAllSettings, resetCategory } = await import(
	"./settings-registry.ts"
);

for (const modulePath of [
	"../lib/appearance-settings.ts",
	"../hooks/useComposerSendShortcut.ts",
	"../hooks/useProjectlessTaskFolder.ts",
	"../hooks/useQuickPreviewModifier.ts",
	"../hooks/useQuickReplyModifier.ts",
	"../hooks/useShowBottomPanelToggle.ts",
	"../hooks/useStartupRealm.ts",
	"../hooks/useTerminalPanelLocation.ts",
	"../lib/user-availability.ts",
]) {
	await import(modulePath);
}

describe("registered Desktop settings", () => {
	test("keeps every resettable preference registered once", () => {
		const entries = listSettings();
		const ids = entries.map(({ id }) => id);
		const counts = Object.fromEntries(
			[...new Set(entries.map(({ category }) => category))]
				.sort()
				.map((category) => [
					category,
					entries.filter((entry) => entry.category === category).length,
				])
		);

		expect(new Set(ids).size).toBe(ids.length);
		expect(counts).toEqual({ appearance: 53, general: 6, shortcuts: 2 });
		for (const entry of entries) {
			expect(entry.id.trim().length).toBeGreaterThan(0);
			expect(entry.reset).toBeInstanceOf(Function);
		}
	});

	test("reset operations visit every setting in their scope exactly once", () => {
		const entries = listSettings();
		const originals = entries.map((entry) => entry.reset);
		const calls: string[] = [];
		try {
			for (const entry of entries) {
				entry.reset = () => calls.push(entry.id);
			}

			for (const category of ["appearance", "general", "shortcuts"] as const) {
				calls.length = 0;
				resetCategory(category);
				expect(calls).toEqual(
					entries
						.filter((entry) => entry.category === category)
						.map((entry) => entry.id)
				);
			}

			calls.length = 0;
			resetAllSettings();
			expect(calls).toEqual(entries.map((entry) => entry.id));
		} finally {
			for (const [index, entry] of entries.entries()) {
				entry.reset = originals[index];
			}
		}
	});

	test("actual defaults can be restored outside a mounted Settings dialog", () => {
		expect(() => resetAllSettings()).not.toThrow();
	});
});

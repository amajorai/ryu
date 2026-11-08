import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { localCoreErrorText } from "./OnboardingPage.local-core-error.ts";

const GERMAN: Record<string, string> = {
	"Ryu could not start its local runtime.":
		"Ryu konnte seine lokale Laufzeit nicht starten.",
	"Ryu could not find its local runtime. Reinstall Ryu, then try again.":
		"Ryu konnte seine lokale Laufzeit nicht finden. Installiere Ryu neu und versuche es dann erneut.",
};

const de = ((source: string) => GERMAN[source] ?? source) as LiteralMessage;

describe("localCoreErrorText", () => {
	test("a coded rejection renders the catalog sentence, not English", () => {
		expect(localCoreErrorText("core_binary_missing", de)).toEqual({
			message:
				"Ryu konnte seine lokale Laufzeit nicht finden. Installiere Ryu neu und versuche es dann erneut.",
			detail: null,
		});
		const spawn = localCoreErrorText(
			"core_spawn_failed:Address already in use (os error 98)",
			de
		);
		expect(spawn).toEqual({
			message: "Ryu konnte seine lokale Laufzeit nicht starten.",
			detail: "Address already in use (os error 98)",
		});
	});

	test("a plain-string rejection falls back to the generic sentence plus the detail", () => {
		expect(
			localCoreErrorText("Failed to start Ryu Core: permission denied", de)
		).toEqual({
			message: "Ryu konnte seine lokale Laufzeit nicht starten.",
			detail: "Failed to start Ryu Core: permission denied",
		});
		expect(localCoreErrorText(new Error("bridge not ready"), de)).toEqual({
			message: "Ryu konnte seine lokale Laufzeit nicht starten.",
			detail: "bridge not ready",
		});
		expect(localCoreErrorText("  ", de)).toEqual({
			message: "Ryu konnte seine lokale Laufzeit nicht starten.",
			detail: null,
		});
	});
});

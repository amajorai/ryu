import { describe, expect, mock, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";

// Both native commands reject the way the Tauri bridge does: with a plain
// `code[:detail]` string (install) or uncoded legacy text (start).
const bridge = await import("@/lib/tauri-bridge.ts");
mock.module("@/lib/tauri-bridge.ts", () => ({
	...bridge,
	ensureCoreInstalled: () =>
		Promise.reject("installer_failed:No space left on device (os error 28)"),
	getRyuStatus: () => Promise.resolve("stopped"),
	startRyuCore: () => Promise.reject("Could not find ryu-core binary."),
}));

const { startLocalCore } = await import("./OnboardingPage.local-stack.ts");

const GERMAN: Record<string, string> = {
	"Ryu could not install its local runtime. Check your internet connection and free disk space, then try again.":
		"Ryu konnte seine lokale Laufzeit nicht installieren. Prüfe deine Internetverbindung und den freien Speicherplatz und versuche es dann erneut.",
};

const de = ((source: string) => GERMAN[source] ?? source) as LiteralMessage;

describe("startLocalCore", () => {
	test("a failed install reports its translated sentence with the raw cause as detail", async () => {
		const result = await startLocalCore(
			() => false,
			{ done: () => undefined, status: () => undefined },
			de
		);
		expect(result).toEqual({
			ok: false,
			error: {
				message:
					"Ryu konnte seine lokale Laufzeit nicht installieren. Prüfe deine Internetverbindung und den freien Speicherplatz und versuche es dann erneut.",
				detail: "No space left on device (os error 28)",
			},
		});
	});
});

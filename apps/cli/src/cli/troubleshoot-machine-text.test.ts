import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { machineLabel, machineValue } from "./troubleshoot-machine-text.ts";

const german = createCliTranslator("de", {
	"Memory (RAM)": "Arbeitsspeicher (RAM)",
	Profile: "Profil",
	default: "Standard",
	"{total} total, {free} free": "{total} gesamt, {free} frei",
});

describe("troubleshoot machine text", () => {
	test("labels translate; RAM never reads as AI memory; acronyms stay", () => {
		expect(machineLabel("Memory", german)).toBe("Arbeitsspeicher (RAM)");
		expect(machineLabel("Profile", german)).toBe("Profil");
		expect(machineLabel("OS", german)).toBe("OS");
	});

	test("only built values translate; names stay data", () => {
		expect(machineValue("Memory", "8 GiB total, 2 GiB free", german)).toBe(
			"8 GiB gesamt, 2 GiB frei"
		);
		expect(machineValue("Profile", "default", german)).toBe("default");
	});
});

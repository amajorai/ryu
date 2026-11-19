import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import type { SidecarSandboxStatus } from "@/src/lib/api/plugins.ts";
import { sandboxLabel } from "./InstalledSection-sandbox.ts";

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

function status(
	overrides: Partial<SidecarSandboxStatus>
): SidecarSandboxStatus {
	return {
		backend: "landlock",
		detail: null,
		enforced: true,
		fsRestricted: true,
		mode: "enforce",
		...overrides,
	};
}

describe("sandboxLabel", () => {
	test("an enforced sandbox is one message with the backend as a value", () => {
		expect(sandboxLabel(status({}), tl)).toBe(
			'[Enforced · {backend}]{"backend":"Landlock"}'
		);
	});

	test("a sandbox without file limits is one message too", () => {
		expect(
			sandboxLabel(status({ backend: "seatbelt", fsRestricted: false }), tl)
		).toBe('[{backend} · no file limits]{"backend":"Seatbelt"}');
	});

	test("off, audit and unavailable are translated words", () => {
		expect(sandboxLabel(status({ mode: "off" }), tl)).toBe("[Off]");
		expect(sandboxLabel(status({ mode: "audit" }), tl)).toBe("[Audit only]");
		expect(
			sandboxLabel(status({ enforced: false, fsRestricted: false }), tl)
		).toBe("[Unavailable]");
	});
});

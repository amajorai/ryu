import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { summarizeSandboxSpec } from "./NodeSelector-sandboxes.tsx";

const german: Record<string, string> = { Sandbox: "Sandbox-Umgebung" };
const de: LiteralMessage = (source) => german[source] ?? source;

describe("summarizeSandboxSpec", () => {
	test("joins the reported fields and formats memory as a number", () => {
		expect(
			summarizeSandboxSpec({ gpu: "H100", memGib: 1536, os: null, vcpu: 4 }, de)
		).toBe("4 vCPU · 1,536 GiB · H100");
	});

	test("falls back to the guest OS, then to the translated noun", () => {
		const empty = { gpu: null, memGib: null, vcpu: null };
		expect(summarizeSandboxSpec({ ...empty, os: "linux" }, de)).toBe("linux");
		expect(summarizeSandboxSpec({ ...empty, os: null }, de)).toBe(
			"Sandbox-Umgebung"
		);
	});
});

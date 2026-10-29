import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENV_VARS } from "./config.ts";
import { SERVICE_TITLES } from "./service-titles.ts";

const SRC = import.meta.dir;
const README = readFileSync(join(SRC, "..", "README.md"), "utf8");

function sourceFiles(): string[] {
	return readdirSync(SRC, { recursive: true, withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".ts") &&
				!entry.name.endsWith(".test.ts")
		)
		.map((entry) => join(entry.parentPath, entry.name));
}

describe("service display names in messages", () => {
	test("no message builds a `Ryu <service id>` prefix from a service id", () => {
		// "Ryu notify: ..." beside "Hint: Could not reach Ryu Notify" reads as
		// two products; messages use SERVICE_TITLES instead.
		const offenders: string[] = [];
		// A method path (`Ryu ${service}.usage:`) stays code-shaped.
		const pattern = /`Ryu \$\{[^}]*service[^}]*\}(?!\.)/u;
		for (const file of sourceFiles()) {
			const lines = readFileSync(file, "utf8").split("\n");
			for (const [index, line] of lines.entries()) {
				if (pattern.test(line)) {
					offenders.push(`${file}:${index + 1}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no message hard-codes a `Ryu <service id>` prefix", () => {
		// Hand-written literals ("Ryu box: ...") regress the same way; a method
		// path ("Ryu mail.send:") is followed by "." and stays allowed.
		const ids = Object.keys(SERVICE_TITLES).join("|");
		const pattern = new RegExp(`Ryu (${ids})[: ]`, "u");
		const offenders: string[] = [];
		for (const file of sourceFiles()) {
			const lines = readFileSync(file, "utf8").split("\n");
			for (const [index, line] of lines.entries()) {
				if (pattern.test(line)) {
					offenders.push(`${file}:${index + 1}: ${line.trim()}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("every title starts with Ryu and a capital letter", () => {
		for (const title of Object.values(SERVICE_TITLES)) {
			expect(title).toMatch(/^Ryu [A-Z]/u);
		}
	});
});

describe("README configuration table", () => {
	test("has a row for every service ENV_VARS configures", () => {
		const services = new Set(ENV_VARS.map((row) => row.service));
		for (const service of services) {
			expect(README).toMatch(
				new RegExp(`^\\| \`${service}\`( \\(|\\s\\|)`, "mu")
			);
		}
	});

	test("names every service and counts the namespaces correctly", () => {
		const count = Object.keys(SERVICE_TITLES).length;
		expect(count).toBe(9);
		expect(README).toContain("All nine namespaces are implemented.");
		const namespaces = README.slice(
			README.indexOf("## Namespaces in this release")
		);
		for (const service of Object.keys(SERVICE_TITLES)) {
			expect(namespaces).toContain(`\`${service}\``);
		}
	});
});

// `ryu secrets agent` templates: the placeholder grammar, filters, the literal
// escape, and a missing value failing the whole render without leaking values.

import { describe, expect, test } from "bun:test";
import {
	parseTemplate,
	referenceKey,
	renderTemplate,
	resolveReference,
	secretReferences,
	TemplateError,
} from "../cli/secrets-agentd-template.ts";

const defaults = { environment: "prod", path: "/" };

function values(entries: [string, string][]): Map<string, string> {
	return new Map(
		entries.map(([reference, value]) => {
			const parts = parseTemplate(`{{secret:${reference}}}`, "t");
			const part = parts[0];
			if (part?.kind !== "secret") {
				throw new Error("not a secret placeholder");
			}
			return [referenceKey(resolveReference(part.reference, defaults)), value];
		})
	);
}

describe("parseTemplate", () => {
	test("splits text and several placeholders, with optional spaces", () => {
		const parts = parseTemplate(
			"A={{secret:API_KEY}}\nB={{ secret:staging:/payments/DB_URL | json }}\nC={{lease:db.password}}\n",
			"app.tpl"
		);
		expect(parts.map((part) => part.kind)).toEqual([
			"text",
			"secret",
			"text",
			"secret",
			"text",
			"lease",
			"text",
		]);
		const second = parts[3];
		expect(second?.kind === "secret" && second.reference).toEqual({
			environment: "staging",
			path: "/payments",
			name: "DB_URL",
		});
		expect(second?.kind === "secret" && second.filter).toBe("json");
		const lease = parts[5];
		expect(lease?.kind === "lease" && [lease.lease, lease.field]).toEqual([
			"db",
			"password",
		]);
	});

	test("leaves other {{ }} syntax alone and unescapes \\{{", () => {
		const parts = parseTemplate(
			"{{ .Values.name }} \\{{secret:NOT_A_PLACEHOLDER}}",
			"t"
		);
		expect(parts).toEqual([
			{
				kind: "text",
				text: "{{ .Values.name }} {{secret:NOT_A_PLACEHOLDER}}",
			},
		]);
	});

	test("rejects a malformed placeholder of ours with its line number", () => {
		expect(() => parseTemplate("ok\n{{secret:bad name}}", "app.tpl")).toThrow(
			"app.tpl:2: invalid placeholder."
		);
		expect(() => parseTemplate("{{secret:API_KEY | upper}}", "t")).toThrow(
			TemplateError
		);
		expect(() => parseTemplate("{{lease:db}}", "t")).toThrow(TemplateError);
		expect(() => parseTemplate("{{secret:API_KEY", "t")).toThrow(TemplateError);
	});
});

describe("renderTemplate", () => {
	test("substitutes values, lease fields and filters", () => {
		const parts = parseTemplate(
			"KEY={{secret:API_KEY}}\nJSON={{secret:API_KEY|json}}\nB64={{secret:API_KEY | base64}}\nPW={{lease:db.password}}",
			"t"
		);
		const output = renderTemplate(
			parts,
			{
				defaults,
				values: values([["API_KEY", 'a"b\\c']]),
				leases: new Map([["db", { password: "pw1" }]]),
			},
			"t"
		);
		expect(output).toBe(
			`KEY=a"b\\c\nJSON="a\\"b\\\\c"\nB64=${Buffer.from('a"b\\c').toString("base64")}\nPW=pw1`
		);
	});

	test("reads defaults for a bare name and explicit coordinates otherwise", () => {
		const parts = parseTemplate("{{secret:A}} {{secret:dev:/x/A}}", "t");
		expect(secretReferences(parts, defaults)).toEqual([
			{ environment: "prod", path: "/", name: "A" },
			{ environment: "dev", path: "/x", name: "A" },
		]);
		const output = renderTemplate(
			parts,
			{
				defaults,
				values: values([
					["A", "prod-a"],
					["dev:/x/A", "dev-a"],
				]),
				leases: new Map(),
			},
			"t"
		);
		expect(output).toBe("prod-a dev-a");
	});

	test("a missing value fails the render, naming every missing placeholder", () => {
		const parts = parseTemplate(
			"{{secret:PRESENT}} {{secret:GONE}} {{lease:db.user}} {{secret:GONE}}",
			"app.tpl"
		);
		let error: unknown;
		try {
			renderTemplate(
				parts,
				{
					defaults,
					values: values([["PRESENT", "s3cr3t-value"]]),
					leases: new Map(),
				},
				"app.tpl"
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(TemplateError);
		const message = (error as Error).message;
		expect(message).toBe("app.tpl: no value for secret:GONE, lease:db.user.");
		expect(message).not.toContain("s3cr3t-value");
	});
});

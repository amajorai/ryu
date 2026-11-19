import { expect, test } from "bun:test";
import {
	type DynamicRoleForm,
	dynamicProviderLabel,
	dynamicRoleInput,
	emptyDynamicRoleForm,
	statementLines,
} from "./vault-dynamic-form.ts";

function form(patch: Partial<DynamicRoleForm>): DynamicRoleForm {
	return { ...emptyDynamicRoleForm(patch.kind), name: "db-ro", ...patch };
}

test("a Postgres role sends one statement per line and its TTLs in seconds", () => {
	expect(
		dynamicRoleInput(
			form({
				connectionUrl: " postgres://admin:pw@db/app ",
				creationStatements:
					'CREATE ROLE "{{name}}" LOGIN PASSWORD \'{{password}}\';\n\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO "{{name}}";',
				defaultTtl: "15m",
				maxTtl: "2h",
			})
		)
	).toEqual({
		name: "db-ro",
		input: {
			defaultTtlSecs: 900,
			maxTtlSecs: 7200,
			provider: {
				kind: "postgres",
				connectionUrl: "postgres://admin:pw@db/app",
				creationStatements: [
					"CREATE ROLE \"{{name}}\" LOGIN PASSWORD '{{password}}';",
					'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "{{name}}";',
				],
				usernamePrefix: undefined,
			},
		},
	});
});

test("AWS, webhook and random roles build their provider", () => {
	const aws = dynamicRoleInput(
		form({
			kind: "aws-sts",
			region: "us-east-1",
			roleArn: "arn:aws:iam::1:role/ci",
			accessKeyId: "AKIA1",
			secretAccessKey: "s3cret",
			defaultTtl: "",
			maxTtl: "",
		})
	);
	expect(aws).toMatchObject({
		input: {
			defaultTtlSecs: undefined,
			provider: { kind: "aws-sts", region: "us-east-1", accessKeyId: "AKIA1" },
		},
	});
	expect(
		dynamicRoleInput(
			form({
				kind: "webhook",
				url: "https://issuer.example/mint",
				signingSecret: "0123456789abcdef",
			})
		)
	).toMatchObject({ input: { provider: { kind: "webhook" } } });
	expect(
		dynamicRoleInput(
			form({ kind: "random", length: "24", charset: "hex", field: "token" })
		)
	).toMatchObject({
		input: {
			provider: { kind: "random", length: 24, charset: "hex", field: "token" },
		},
	});
});

test("problems are reported before anything is sent", () => {
	const problem = (patch: Partial<DynamicRoleForm>) => {
		const result = dynamicRoleInput(form(patch));
		return "problem" in result ? result.problem : null;
	};
	expect(problem({ name: "DB" })).toContain("lowercase");
	expect(problem({ defaultTtl: "soon" })).toContain("90s");
	expect(problem({ defaultTtl: "3h", maxTtl: "1h" })).toContain("exceed");
	expect(problem({ connectionUrl: "postgres://x" })).toContain(
		"creation statement"
	);
	expect(problem({ kind: "aws-sts", region: "us-east-1" })).toContain(
		"role ARN"
	);
	expect(
		problem({ kind: "webhook", url: "https://x", signingSecret: "short" })
	).toContain("16");
	expect(problem({ kind: "random", length: "2.5" })).toContain("whole");
});

test("statement lines drop blanks and labels fall back to the kind", () => {
	expect(statementLines(" a;\r\n\n b; ")).toEqual(["a;", "b;"]);
	expect(dynamicProviderLabel("postgres")).toBe("PostgreSQL");
	expect(dynamicProviderLabel("redis")).toBe("redis");
});

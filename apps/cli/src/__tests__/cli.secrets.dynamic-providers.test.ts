import { describe, expect, test } from "bun:test";
import { parseRoleFile } from "../cli/secrets-dynamic.ts";
import { providerSchema } from "../cli/secrets-dynamic-providers.ts";

const roleFile = (provider: Record<string, unknown>) =>
	JSON.stringify({ provider, defaultTtl: "15m" });

describe("dynamic role providers", () => {
	test("every Core provider kind parses", () => {
		const providers = [
			{
				kind: "mysql",
				connectionUrl: "mysql://admin:pw@db:3306/app?ssl-mode=REQUIRED",
				creationStatements: [
					"CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'",
				],
			},
			{
				kind: "mariadb",
				connectionUrl: "mariadb://admin:pw@db/app",
				creationStatements: ["CREATE USER '{{name}}'"],
			},
			{
				kind: "mssql",
				connectionUrl: "sqlserver://sa:pw@sql:1433/app?encrypt=strict",
				creationStatements: [
					"CREATE LOGIN [{{name}}] WITH PASSWORD = '{{password}}'",
				],
				caPem: "-----BEGIN CERTIFICATE-----",
			},
			{
				kind: "mongodb",
				connectionUrl: "mongodb://admin:pw@mongo:27017/?authSource=admin",
				roles: [{ role: "readWrite", db: "app" }],
			},
			{
				kind: "valkey",
				connectionUrl: "valkeys://cache:6380",
				aclRules: ["~app:*"],
			},
			{
				kind: "gcp",
				credentials: "{}",
				serviceAccountEmail: "app@proj.iam.gserviceaccount.com",
				secretType: "accessToken",
			},
			{
				kind: "azure",
				tenantId: "contoso.onmicrosoft.com",
				clientId: "c",
				clientSecret: "s",
				applicationObjectId: "o",
				environment: "usGovernment",
			},
			{
				kind: "kubernetes",
				host: "https://k8s:6443",
				serviceAccountJwt: "t",
				namespace: "apps",
				kubernetesRoleName: "view",
				kubernetesRoleType: "ClusterRole",
				clusterRoleBinding: true,
			},
			{
				kind: "kubernetes-rules",
				host: "https://k8s:6443",
				serviceAccountJwt: "t",
				namespace: "apps",
				rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }],
			},
			{
				kind: "aws-iam",
				accessKeyId: "AKID",
				secretAccessKey: "s",
				policyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
				iamGroups: ["developers"],
			},
			{
				kind: "rabbitmq",
				connectionUri: "https://rabbit:15671",
				username: "admin",
				password: "pw",
				tags: "management",
				vhosts: { "/": { configure: "", write: "^orders$", read: ".*" } },
				vhostTopics: { "/": { "amq.topic": { write: "^orders\\." } } },
			},
		];
		for (const provider of providers) {
			const parsed = parseRoleFile(roleFile(provider), "role.json");
			expect(parsed.provider).toEqual(providerSchema.parse(provider));
			expect(parsed.defaultTtlSecs).toBe(900);
		}
	});

	test("errors name the field and never echo secrets", () => {
		const cases: [Record<string, unknown>, RegExp][] = [
			[
				{ kind: "mongodb", connectionUrl: "mongodb://a:hunter2@h/", roles: [] },
				/provider\.roles/,
			],
			[
				{
					kind: "azure",
					tenantId: "t",
					clientId: "c",
					clientSecret: "hunter2",
					applicationObjectId: "o",
					environment: "mars",
				},
				/provider\.environment/,
			],
			[
				{
					kind: "kubernetes",
					host: "https://k8s",
					serviceAccountJwt: "hunter2",
					namespace: "apps",
					extra: true,
				},
				/role\.json/,
			],
			[
				{ kind: "oracle", connectionUrl: "oracle://hunter2@h" },
				/provider\.kind/,
			],
			[
				{
					kind: "kubernetes-rules",
					host: "https://k8s",
					serviceAccountJwt: "hunter2",
					namespace: "apps",
					rules: [{ resources: ["pods"] }],
				},
				/provider\.rules/,
			],
			[
				{
					kind: "rabbitmq",
					connectionUri: "https://rabbit",
					username: "admin",
					password: "hunter2",
				},
				/provider\.vhosts/,
			],
		];
		for (const [provider, message] of cases) {
			let error: unknown;
			try {
				parseRoleFile(roleFile(provider), "role.json");
			} catch (caught) {
				error = caught;
			}
			expect(String(error)).toMatch(message);
			expect(String(error)).not.toContain("hunter2");
		}
	});
});

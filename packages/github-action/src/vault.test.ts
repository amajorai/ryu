import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { FetchLike } from "./client.ts";
import {
	parseActionInputs,
	parseSecretsInput,
	parseVaultSecretRef,
	validateOperationInputs,
} from "./input.ts";
import { executeAction } from "./runner.ts";
import type { ActionRuntime } from "./runtime.ts";
import { groupVaultRefs } from "./vault.ts";

interface RecordedRequest {
	authorization: string | null;
	body: unknown;
	path: string;
	vaultToken: string | null;
}

function runtime(
	values: Record<string, string>,
	idToken?: (audience?: string) => Promise<string>
): ActionRuntime & {
	environment: Record<string, string>;
	outputs: Map<string, unknown>;
	secrets: string[];
	warnings: string[];
} {
	const outputs = new Map<string, unknown>();
	const environment: Record<string, string> = {};
	const secrets: string[] = [];
	const warnings: string[] = [];
	return {
		environment,
		getIDToken: idToken,
		getInput: (name) => values[name] ?? "",
		info: () => undefined,
		outputs,
		secrets,
		setOutput: (name, value) => outputs.set(name, value),
		setSecret: (value) => secrets.push(value),
		warning: (message) => warnings.push(message),
		warnings,
		exportVariable: (name, value) => {
			environment[name] = value;
		},
	};
}

function vaultNode(
	values: Record<string, Record<string, string>>,
	options: { infoStatus?: number } = {}
) {
	const requests: RecordedRequest[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const path = new URL(String(input)).pathname;
		const headers = new Headers(init?.headers);
		const body =
			init?.body === undefined ? undefined : JSON.parse(String(init.body));
		requests.push({
			authorization: headers.get("authorization"),
			body,
			path,
			vaultToken: headers.get("x-ryu-vault-token"),
		});
		if (path === "/api/health") {
			return Response.json({ status: "ok", version: "1.0.0" });
		}
		if (path === "/api/system/info") {
			return options.infoStatus
				? Response.json(
						{ error: "unauthorized" },
						{ status: options.infoStatus }
					)
				: Response.json({ managed: false });
		}
		if (path.startsWith("/api/vault/auth/")) {
			return Response.json({
				token: {
					token: "rvt_issued",
					accessor: "rva_1",
					identityId: "mid_1",
					expiresAt: "2030-01-01T00:00:00Z",
				},
			});
		}
		if (path === "/api/vault/agent/export") {
			const request = z
				.object({
					environment: z.string().optional(),
					names: z.array(z.string()),
					path: z.string(),
				})
				.parse(body);
			const scope = values[`${request.environment ?? ""}${request.path}`] ?? {};
			const selected = Object.fromEntries(
				Object.entries(scope).filter(([name]) => request.names.includes(name))
			);
			return Response.json({
				format: "json",
				content: JSON.stringify(selected),
			});
		}
		if (path === "/api/vault/agent/self/revoke") {
			return Response.json({ revoked: true });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	};
	return { fetchImpl, requests };
}

describe("vault secrets input", () => {
	it("parses references with Core's grammar", () => {
		expect(parseVaultSecretRef("API_KEY")).toEqual({
			environment: null,
			name: "API_KEY",
			path: "/",
			reference: "API_KEY",
		});
		expect(parseVaultSecretRef("prod:/ci/deploy/TOKEN")).toEqual({
			environment: "prod",
			name: "TOKEN",
			path: "/ci/deploy",
			reference: "prod:/ci/deploy/TOKEN",
		});
		expect(parseVaultSecretRef("Prod:TOKEN")).toBeNull();
		expect(parseVaultSecretRef("ci/TOKEN")).toBeNull();
		expect(
			parseSecretsInput("API_KEY\n\n# comment\r\nprod:/db/URL\n").map(
				(ref) => ref.name
			)
		).toEqual(["API_KEY", "URL"]);
		expect(() => parseSecretsInput("not valid")).toThrow(
			"invalid reference 'not valid'"
		);
		expect(() => parseSecretsInput("A\nprod:A")).toThrow("more than once");
	});

	it("requires exactly one machine login method", () => {
		const parse = (values: Record<string, string>) => () =>
			validateOperationInputs(
				parseActionInputs({ get: (name) => values[name] ?? "" })
			);
		expect(parse({ secrets: "A" })).toThrow("needs 'vault-role-id'");
		expect(parse({ secrets: "A", "vault-role-id": "r" })).toThrow(
			"must be set together"
		);
		expect(
			parse({
				secrets: "A",
				"vault-role-id": "r",
				"vault-secret-id": "s",
				"vault-jwt-identity": "gha",
			})
		).toThrow("not both");
		expect(parse({ secrets: "A", "vault-jwt-identity": "gha" })).not.toThrow();
	});

	it("groups references per environment and folder", () => {
		const groups = groupVaultRefs(
			parseSecretsInput("A\nB\nprod:A2\nprod:/x/C")
		);
		expect(
			groups.map((group) => [
				group.environment,
				group.path,
				group.refs.map((ref) => ref.name),
			])
		).toEqual([
			[null, "/", ["A", "B"]],
			["prod", "/", ["A2"]],
			["prod", "/x", ["C"]],
		]);
	});
});

describe("executeAction vault secrets", () => {
	it("logs in with AppRole, masks before exporting, and revokes the token", async () => {
		const node = vaultNode({
			"/": { API_KEY: "sk_live_1", OTHER: "not-requested" },
			"prod/db": { URL: "line1\nline2" },
		});
		const actionRuntime = runtime({
			secrets: "API_KEY\nprod:/db/URL",
			"vault-role-id": "role-1",
			"vault-secret-id": "secret-1",
		});
		await executeAction({
			environment: {
				RYU_CORE_URL: "https://node.example",
				RYU_CORE_TOKEN: "node",
			},
			fetchImpl: node.fetchImpl,
			runtime: actionRuntime,
		});
		const vaultRequests = node.requests.filter((request) =>
			request.path.startsWith("/api/vault/")
		);
		expect(vaultRequests.map((request) => request.path)).toEqual([
			"/api/vault/auth/approle/login",
			"/api/vault/agent/export",
			"/api/vault/agent/export",
			"/api/vault/agent/self/revoke",
		]);
		for (const request of vaultRequests) {
			expect(request.authorization).toBeNull();
		}
		expect(vaultRequests[0]?.body).toEqual({
			roleId: "role-1",
			secretId: "secret-1",
		});
		expect(vaultRequests[0]?.vaultToken).toBeNull();
		expect(vaultRequests[1]?.vaultToken).toBe("rvt_issued");
		expect(vaultRequests[1]?.body).toEqual({
			format: "json",
			names: ["API_KEY"],
			path: "/",
		});
		expect(vaultRequests[2]?.body).toEqual({
			environment: "prod",
			format: "json",
			names: ["URL"],
			path: "/db",
		});
		expect(actionRuntime.environment.API_KEY).toBe("sk_live_1");
		expect(actionRuntime.environment.URL).toBe("line1\nline2");
		expect(actionRuntime.environment.OTHER).toBeUndefined();
		expect(actionRuntime.secrets).toEqual(
			expect.arrayContaining([
				"secret-1",
				"rvt_issued",
				"sk_live_1",
				"line1\nline2",
				"line1",
				"line2",
			])
		);
		expect(actionRuntime.outputs.get("vault-secrets")).toBe(
			JSON.stringify(["API_KEY", "URL"])
		);
	});

	it("uses the GitHub OIDC token for JWT login and works without a node token", async () => {
		const node = vaultNode({ "/": { DEPLOY_KEY: "k" } }, { infoStatus: 401 });
		const audiences: Array<string | undefined> = [];
		const actionRuntime = runtime(
			{
				secrets: "DEPLOY_KEY",
				"vault-jwt-identity": "github-deploy",
				"vault-jwt-audience": "ryu",
			},
			async (audience) => {
				audiences.push(audience);
				return "gh.oidc.jwt";
			}
		);
		const result = await executeAction({
			environment: { RYU_CORE_URL: "https://node.example" },
			fetchImpl: node.fetchImpl,
			runtime: actionRuntime,
		});
		expect(result.node.info.managed).toBe(false);
		expect(audiences).toEqual(["ryu"]);
		const login = node.requests.find(
			(request) => request.path === "/api/vault/auth/jwt/login"
		);
		expect(login?.body).toEqual({
			identity: "github-deploy",
			jwt: "gh.oidc.jwt",
		});
		expect(actionRuntime.secrets).toContain("gh.oidc.jwt");
		expect(actionRuntime.environment.DEPLOY_KEY).toBe("k");
	});

	it("fails without exporting anything when a value is not readable", async () => {
		const node = vaultNode({ "/": { A: "a" } });
		const actionRuntime = runtime({
			secrets: "A\nMISSING",
			"vault-role-id": "r",
			"vault-secret-id": "s",
		});
		await expect(
			executeAction({
				environment: {
					RYU_CORE_URL: "https://node.example",
					RYU_CORE_TOKEN: "t",
				},
				fetchImpl: node.fetchImpl,
				runtime: actionRuntime,
			})
		).rejects.toThrow("cannot read: MISSING");
		expect(actionRuntime.environment.A).toBeUndefined();
		expect(node.requests.at(-1)?.path).toBe("/api/vault/agent/self/revoke");
	});
});

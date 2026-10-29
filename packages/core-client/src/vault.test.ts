import { expect, test } from "bun:test";
import { ApiError } from "./client.ts";
import {
	bindVaultPolicy,
	createVaultBrokerSession,
	createVaultPasswordManagerAccount,
	createVaultTotpKey,
	decideVaultBrokerProposal,
	decideVaultCardApproval,
	decideVaultChangeRequest,
	decideVaultPasswordManagerApproval,
	deleteVaultFolder,
	deleteVaultItem,
	deleteVaultSecret,
	exportVaultSecrets,
	fillVaultCard,
	generateVaultPassword,
	getVaultBrokerCaPem,
	getVaultItem,
	getVaultPkiCrl,
	getVaultTotpCode,
	importVaultSecrets,
	listVaultAudit,
	listVaultBrokerLogs,
	listVaultBrokerProposals,
	listVaultBrokerServices,
	listVaultCardApprovals,
	listVaultItemEvents,
	listVaultItems,
	listVaultPasswordManagerAccounts,
	listVaultPasswordManagerApprovals,
	listVaultPasswordManagerGrants,
	listVaultSecrets,
	listVaultSecretVersions,
	listVaultTotpKeys,
	lookupVaultToken,
	parseVaultJsonExport,
	parseVaultReference,
	patchVaultItem,
	putVaultCard,
	putVaultItem,
	putVaultPasswordPolicy,
	putVaultSecret,
	putVaultTokenRole,
	readVaultPasswordManagerRef,
	renewVaultToken,
	revealVaultCardField,
	revealVaultItemField,
	revealVaultSecret,
	revokeVaultBrokerSession,
	revokeVaultPasswordManagerGrant,
	revokeVaultTokenOrphan,
	rollbackVaultSecret,
	scanForVaultSecrets,
	setVaultPasswordManagerToken,
	testVaultPasswordManagerAccount,
	unsealVault,
	validateVaultTotpCode,
	vaultAgentBrokerDiscover,
	vaultAgentBrokerSession,
	vaultAgentCardApproval,
	vaultAgentCubbyholePut,
	vaultAgentExport,
	vaultAgentLookupSelf,
	vaultAgentRenewSelf,
	vaultAgentSecret,
	vaultAgentTotpCode,
	vaultAppRoleLogin,
	vaultJwtLogin,
	vaultTransit,
	vaultUnwrap,
	vaultWrap,
	vaultWrapLookup,
	wrapVaultSecret,
} from "./vault.ts";

// Complete wire models read from Rust serde publishers and vault_api.rs renderer.
function fixtures(t: string | number = "2030-01-01T00:00:00Z") {
	const metadata = {
		description: "native",
		tags: ["ci"],
		expiresAt: null,
		rotationPeriodSecs: null,
		generator: null,
		expandReferences: true,
		maxVersions: 10,
	};
	const coords = {
		name: "API_KEY",
		scope: "user",
		scopeId: "user-1",
		environment: "prod",
		path: "/api",
	};
	const secret = {
		...coords,
		version: 1,
		status: "active",
		metadata,
		capabilities: ["list", "read"],
		createdAt: t,
		createdBy: null,
		updatedAt: t,
		updatedBy: null,
		rotatedAt: t,
	};
	const change = {
		id: "cr/1",
		status: "pending",
		operation: "write",
		coords,
		hasValue: true,
		patch: { tags: ["new"] },
		requestedBy: "user-1",
		requestedAt: t,
		approvals: [{ by: "reviewer", at: t }],
		requiredApprovals: 2,
		decidedBy: null,
		decidedAt: null,
		reason: null,
	};
	const seal = {
		mode: "auto",
		sealed: false,
		shares: 0,
		threshold: 0,
		progress: 0,
		keyVersions: [1],
		activeKeyVersion: 1,
	};
	const environment = {
		slug: "prod",
		name: "Production",
		protected: false,
		requiredApprovals: 1,
		position: 0,
	};
	const folderImport = {
		id: "import-1",
		environment: "prod",
		path: "/api",
		sourceEnvironment: "default",
		sourcePath: "/ci",
		position: 0,
	};
	const policy = {
		name: "ci",
		description: "native",
		rules: [{ path: "prod/**", capabilities: ["read"], deny: false }],
	};
	const binding = { id: "binding-1", policy: "ci", subject: "machine:mid_1" };
	const key = {
		name: "payments",
		type: "aes256-gcm96",
		latestVersion: 1,
		minDecryptionVersion: 1,
		deletionAllowed: false,
		createdAt: t,
		publicKeys: [],
	};
	const issuer = {
		name: "root",
		commonName: "Native",
		certificate: "PEM",
		notAfter: t,
	};
	const pkiRole = {
		name: "role",
		issuer: "root",
		allowedDomains: ["native.example"],
		allowIpSans: false,
		defaultTtlSecs: 3600,
		maxTtlSecs: 7200,
		serverFlag: true,
		clientFlag: false,
	};
	const cert = {
		serial: "01",
		issuer: "root",
		commonName: "native.example",
		notAfter: t,
		revokedAt: null,
	};
	const sshRole = {
		name: "role",
		ca: "root",
		certType: "user",
		allowedPrincipals: ["alice"],
		defaultTtlSecs: 3600,
		maxTtlSecs: 7200,
		extensions: [],
	};
	const lease = {
		id: "lease",
		role: "role",
		provider: "random",
		issuedTo: null,
		createdAt: t,
		expiresAt: t,
		maxExpiresAt: t,
		renewable: true,
		revokedAt: null,
	};
	const dynamic = {
		name: "role",
		provider: "random",
		defaultTtlSecs: 3600,
		maxTtlSecs: 7200,
		summary: { length: 32, charset: "alphanumeric", field: null },
		createdAt: t,
		updatedAt: t,
	};
	const machine = {
		id: "mid_1",
		name: "native",
		auth: { kind: "approle", role_id: "role_id" },
		policies: ["ci"],
		tokenTtlSecs: 3600,
		disabled: false,
		createdAt: t,
		createdBy: null,
	};
	const secretId = {
		accessor: "sid_1",
		createdAt: t,
		expiresAt: null,
		usesRemaining: null,
	};
	return {
		vaultHumanList: {
			secrets: [secret],
			node: {
				id: "node",
				scope: "personal",
				orgId: null,
				teamId: null,
				ownerUserId: "user-1",
			},
			caller: { userId: "user-1", orgId: null, role: "viewer", teamIds: [] },
			canManageShared: false,
			sharedRemote: false,
			sharedError: null,
			activeEnvironment: "prod",
			seal,
		},
		vaultHumanWrite: { ok: true, secret },
		vaultHumanDelete: { ok: true, deleted: true, ...coords, binding: null },
		vaultHumanVersions: {
			versions: [
				{
					version: 1,
					createdAt: t,
					createdBy: null,
					source: "write",
					destroyed: false,
					current: true,
				},
			],
		},
		vaultMachineValueResponse: { value: "s3cret" },
		vaultHumanDestroyed: { ok: true, destroyed: 1 },
		vaultMachineExportResponse: {
			format: "json",
			contentType: "application/json",
			count: 1,
			environment: "prod",
			path: "/",
			content: '{"API_KEY":"v","N":1}',
		},
		vaultHumanImported: {
			ok: true,
			report: { created: 1, updated: 0, skipped: 0, unchanged: 0 },
		},
		vaultHumanSnapshot: {
			format: "ryu-vault-snapshot",
			version: 1,
			createdAt: "2030-01-01T00:00:00Z",
			kdf: { alg: "pbkdf2-sha256", iterations: 100_000, salt: "salt" },
			nonce: "nonce",
			ciphertext: "ciphertext",
		},
		vaultHumanFindings: {
			findings: [
				{
					rule: "generic",
					description: "Native",
					line: 1,
					column: 1,
					preview: "redacted",
					fingerprint: "abc",
				},
			],
		},
		vaultHumanEnvironments: { environments: [environment], active: "prod" },
		vaultHumanPutEnvironment: { ok: true, environment },
		vaultHumanDeleted: { ok: true, deleted: true },
		vaultHumanFolders: { folders: ["/api"] },
		vaultHumanCreatedFolder: { ok: true, path: "/api" },
		vaultHumanImports: { imports: [folderImport] },
		vaultHumanAddedImport: { ok: true, import: folderImport },
		vaultHumanRemoved: { ok: true, removed: true },
		vaultHumanPolicies: { policies: [policy], bindings: [binding] },
		vaultHumanPutPolicy: { ok: true, policy },
		vaultHumanBoundPolicy: { ok: true, binding },
		vaultHumanChanges: { changeRequests: [change], sharedError: null },
		vaultHumanDecidedChange: { ok: true, changeRequest: change },
		vaultHumanAudit: {
			events: [
				{
					seq: 1,
					at: "2030-01-01T00:00:00Z",
					actor: { kind: "user", id: null },
					action: "read",
					outcome: "ok",
					details: { native: true },
				},
			],
			nextBefore: null,
		},
		vaultHumanAuditVerified: { report: { ok: true, rows: 1 } },
		vaultHumanStatus: { seal, activeEnvironment: "prod", sharedRemote: false },
		vaultHumanSealResponse: { seal },
		vaultHumanShamirResponse: { shares: ["share"], seal },
		vaultHumanRotateResponse: { keyVersion: 2, rewrapped: 1, seal },
		vaultHumanMigration: {
			ok: true,
			moved: 1,
			failed: [{ key: "failed", error: "native" }],
		},
		vaultHumanTransitKeys: { keys: [key] },
		vaultHumanTransitKeyResponse: { key },
		vaultHumanDeletedEngine: { deleted: true },
		vaultHumanTransitResponses: { ciphertext: "native" },
		vaultHumanPkiIssuers: { issuers: [issuer] },
		vaultHumanPkiIssuerResponse: { issuer },
		vaultHumanPkiRecords: { certificates: [cert] },
		vaultHumanPkiRoles: { roles: [pkiRole] },
		vaultHumanPkiRoleResponse: { role: pkiRole },
		vaultMachinePkiResponse: {
			certificate: {
				certificate: "PEM",
				issuingCa: "PEM",
				serial: "01",
				notAfter: t,
			},
		},
		vaultHumanPkiRecordResponse: { certificate: cert },
		vaultHumanSshCas: {
			cas: [{ name: "root", publicKey: "ssh-ed25519 native" }],
		},
		vaultHumanSshPublicKey: { publicKey: "ssh-ed25519 native" },
		vaultHumanSshRoles: { roles: [sshRole] },
		vaultHumanSshRoleResponse: { role: sshRole },
		vaultMachineSshResponse: {
			certificate: {
				certificate: "ssh-ed25519 native",
				serial: 1,
				keyId: "native",
				principals: ["alice"],
				validAfter: t,
				validBefore: t,
			},
		},
		vaultHumanDynamicRoles: { roles: [dynamic] },
		vaultHumanDynamicRoleResponse: { role: dynamic },
		vaultHumanRevokedCount: { revoked: 1 },
		vaultMachineDynamicResponse: {
			credential: { lease, data: { password: "secret" } },
		},
		vaultHumanLeases: { leases: [lease] },
		vaultMachineLeaseResponse: { lease },
		vaultHumanMachines: { machines: [machine] },
		vaultHumanMachineResponse: { machine },
		vaultHumanSecretIds: { secretIds: [secretId] },
		vaultHumanIssuedSecretId: { secretId: "secret", info: secretId },
		vaultMachineRevokedResponse: { revoked: true },
	};
}

interface Call {
	body: unknown;
	headers: Headers;
	method: string;
	url: string;
}

function recorder(
	response: () => Response = () => Response.json({ ok: true })
) {
	const calls: Call[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body:
				init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		});

		const legacy = response();
		const path = new URL(String(input)).pathname;
		if (
			!legacy.ok ||
			path.includes("/auth/") ||
			path.includes("/agent/") ||
			path.endsWith("/crl")
		) {
			return legacy;
		}
		const native = fixtures();
		const method = init?.method ?? "GET";
		let body;
		if (path.endsWith("/versions")) {
			body = native.vaultHumanVersions;
		} else if (path.endsWith("/reveal")) {
			body = native.vaultMachineValueResponse;
		} else if (path.endsWith("/rollback")) {
			body = native.vaultHumanWrite;
		} else if (path.includes("/secrets/")) {
			body =
				method === "DELETE" ? native.vaultHumanDelete : native.vaultHumanWrite;
		} else if (path.endsWith("/secrets")) {
			body = native.vaultHumanList;
		} else if (path.endsWith("/audit")) {
			body = native.vaultHumanAudit;
		} else if (path.endsWith("/folders")) {
			body = native.vaultHumanDeleted;
		} else if (path.endsWith("/export")) {
			body = native.vaultMachineExportResponse;
		} else if (path.endsWith("/import")) {
			body = native.vaultHumanImported;
		} else if (path.endsWith("/scan")) {
			body = native.vaultHumanFindings;
		} else if (path.endsWith("/policy-bindings")) {
			body = native.vaultHumanBoundPolicy;
		} else if (path.includes("/change-requests/")) {
			body = native.vaultHumanDecidedChange;
		} else if (path.endsWith("/unseal")) {
			body = native.vaultHumanSealResponse;
		} else if (path.includes("/transit/encrypt/")) {
			body = native.vaultHumanTransitResponses;
		} else {
			throw new Error(`Missing audited publisher fixture ${String(path)}`);
		}
		return Response.json(body);
	};
	return { calls, fetch };
}

test("value routes send coordinates in the body and encode names", async () => {
	const { calls, fetch } = recorder();
	const target = { url: "https://node.example/", token: "node", fetch };
	const coords = { scope: "user" as const, environment: "prod", path: "/api" };
	await putVaultSecret(target, "API_KEY", {
		...coords,
		value: "s3cret",
		metadata: { tags: ["ci"], expiresAt: "2030-01-01T00:00:00Z" },
	});
	await deleteVaultSecret(target, "API_KEY", coords);
	await revealVaultSecret(target, "API_KEY", { ...coords, version: 2 });
	await rollbackVaultSecret(target, "API_KEY", { ...coords, version: 1 });
	expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
		"PUT https://node.example/api/vault/secrets/API_KEY",
		"DELETE https://node.example/api/vault/secrets/API_KEY",
		"POST https://node.example/api/vault/secrets/API_KEY/reveal",
		"POST https://node.example/api/vault/secrets/API_KEY/rollback",
	]);
	expect(calls[0]?.body).toEqual({
		scope: "user",
		environment: "prod",
		path: "/api",
		value: "s3cret",
		metadata: { tags: ["ci"], expiresAt: "2030-01-01T00:00:00Z" },
	});
	expect(calls[1]?.body).toEqual(coords);
	expect(calls[2]?.body).toEqual({ ...coords, version: 2 });
	expect(calls[0]?.headers.get("authorization")).toBe("Bearer node");
});

test("query routes encode filters and the MCP binding as mcpId", async () => {
	const { calls, fetch } = recorder(() => Response.json({ versions: [] }));
	const target = { url: "https://node.example", token: "node", fetch };
	await listVaultSecrets(target, { environment: "prod", includeDeleted: true });
	await listVaultSecretVersions(target, "TOKEN", {
		scope: "team",
		scopeId: "team 1",
		binding: { kind: "mcp", id: "github" },
		path: "/ci",
	});
	await listVaultAudit(target, { before: 40, limit: 10, actorId: "user-1" });
	await deleteVaultFolder(target, { environment: "prod", path: "/old" });
	expect(calls.map((call) => call.url)).toEqual([
		"https://node.example/api/vault/secrets?environment=prod&includeDeleted=true",
		"https://node.example/api/vault/secrets/TOKEN/versions?scope=team&scopeId=team+1&mcpId=github&path=%2Fci",
		"https://node.example/api/vault/audit?before=40&limit=10&actorId=user-1",
		"https://node.example/api/vault/folders?environment=prod&path=%2Fold",
	]);
	expect(calls[3]?.method).toBe("DELETE");
});

test("export, import, scan, policy, and change-request bodies match Core", async () => {
	const { calls, fetch } = recorder(() =>
		Response.json({
			format: "json",
			contentType: "application/json",
			count: 1,
			environment: "prod",
			path: "/",
			content: '{"API_KEY":"v","N":1}',
		})
	);
	const target = { url: "https://node.example", token: null, fetch };
	const exported = await exportVaultSecrets(target, {
		environment: "prod",
		format: "k8s-secret",
		k8sName: "app",
		k8sNamespace: "default",
	});
	expect(parseVaultJsonExport(exported)).toEqual({ API_KEY: "v" });
	await importVaultSecrets(target, {
		scope: "node",
		format: "dotenv",
		content: "A=1\n",
		onConflict: "overwrite",
	});
	await scanForVaultSecrets(target, {
		files: [{ path: "a.env", content: "x" }],
		knownValues: false,
	});
	await bindVaultPolicy(target, {
		policy: "ci",
		subject: "machine:mid_1",
		expiresAt: "2030-01-01T00:00:00Z",
	});
	await decideVaultChangeRequest(target, "cr/1", "reject", "not now");
	await unsealVault(target, "share-1");
	await vaultTransit(target, "encrypt", "payments", { plaintext: "aGk=" });
	expect(
		calls.map((call) => call.url.replace("https://node.example", ""))
	).toEqual([
		"/api/vault/export",
		"/api/vault/import",
		"/api/vault/scan",
		"/api/vault/policy-bindings",
		"/api/vault/change-requests/cr%2F1/reject",
		"/api/vault/sys/unseal",
		"/api/vault/transit/encrypt/payments",
	]);
	expect(calls[0]?.body).toEqual({
		environment: "prod",
		format: "k8s-secret",
		k8sName: "app",
		k8sNamespace: "default",
	});
	expect(calls[4]?.body).toEqual({ reason: "not now" });
	expect(calls[5]?.body).toEqual({ share: "share-1" });
	expect(calls[0]?.headers.get("authorization")).toBeNull();
});

test("machine login and agent routes send only the vault token", async () => {
	const { calls, fetch } = recorder(() =>
		Response.json({
			token: {
				token: "rvt_abc",
				accessor: "native",
				expiresAt: "2030-01-01T00:00:00Z",
				identityId: "machine",
				policies: [],
			},
			value: "v",
			content: '{"A":"v"}',
			contentType: "application/json",
			count: 1,
			environment: "default",
			format: "json",
			path: "/",
		})
	);
	const machine = { url: "https://node.example/", fetch };
	const login = await vaultAppRoleLogin(machine, {
		roleId: "role",
		secretId: "secret",
	});
	expect(login.token.token).toBe("rvt_abc");
	await vaultJwtLogin(machine, { identity: "gha", jwt: "eyJ" });
	const agent = { ...machine, vaultToken: "rvt_abc" };
	await vaultAgentExport(agent, { format: "json", names: ["A"] });
	await vaultAgentSecret(agent, "A", { environment: "prod", path: "/ci" });
	expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
		"POST https://node.example/api/vault/auth/approle/login",
		"POST https://node.example/api/vault/auth/jwt/login",
		"POST https://node.example/api/vault/agent/export",
		"GET https://node.example/api/vault/agent/secrets/A?environment=prod&path=%2Fci",
	]);
	expect(calls[0]?.body).toEqual({ roleId: "role", secretId: "secret" });
	expect(calls[0]?.headers.get("x-ryu-vault-token")).toBeNull();
	for (const call of calls) {
		expect(call.headers.get("authorization")).toBeNull();
	}
	expect(calls[2]?.headers.get("x-ryu-vault-token")).toBe("rvt_abc");
	expect(calls[3]?.headers.get("x-ryu-vault-token")).toBe("rvt_abc");
});

test("vault failures surface Core's structured error", async () => {
	const { fetch } = recorder(() =>
		Response.json(
			{ error: "vault_denied: the `read` capability is required on `prod/A`" },
			{ status: 403 }
		)
	);
	const agent = { url: "https://node.example", vaultToken: "rvt_x", fetch };
	try {
		await vaultAgentSecret(agent, "A");
		throw new Error("expected a denial");
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		if (!(error instanceof ApiError)) {
			throw error;
		}
		expect(error.status).toBe(403);
		expect(error.serverMessage).toContain("vault_denied");
	}
});

test("the CRL is returned as PEM text", async () => {
	const { fetch } = recorder(
		() => new Response("-----BEGIN X509 CRL-----\n", { status: 200 })
	);
	const pem = await getVaultPkiCrl(
		{ url: "https://node.example", token: "node", fetch },
		"root"
	);
	expect(pem).toStartWith("-----BEGIN X509 CRL-----");
});

test("reference grammar matches the Core resolver", () => {
	expect(parseVaultReference("API_KEY")).toEqual({ name: "API_KEY" });
	expect(parseVaultReference("secret:prod:/ci/deploy/TOKEN")).toEqual({
		environment: "prod",
		path: "/ci/deploy",
		name: "TOKEN",
	});
	expect(parseVaultReference("/TOKEN")).toEqual({ path: "/", name: "TOKEN" });
	expect(parseVaultReference("staging:TOKEN")).toEqual({
		environment: "staging",
		name: "TOKEN",
	});
	expect(parseVaultReference("Prod:TOKEN")).toBeNull();
	expect(parseVaultReference("ci/TOKEN")).toBeNull();
	expect(parseVaultReference("/a/../TOKEN")).toBeNull();
	expect(parseVaultReference("1BAD")).toBeNull();
});

// ── Broker, TOTP, items, tokens, and wrapping ────────────────────────────────

interface Recorded {
	body: unknown;
	headers: Headers;
	method: string;
	url: string;
}

/** Answers each `METHOD /path` (no query) with a fixed native reply. */
function routed(replies: Record<string, unknown>) {
	const calls: Recorded[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		calls.push({
			url: `${url.pathname}${url.search}`,
			method,
			headers: new Headers(init?.headers),
			body:
				init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		});
		const reply = replies[`${method} ${url.pathname}`];
		if (reply === undefined) {
			return Promise.resolve(
				Response.json({ error: "no route" }, { status: 404 })
			);
		}
		return Promise.resolve(
			typeof reply === "string" ? new Response(reply) : Response.json(reply)
		);
	};
	return { calls, fetch };
}

const T = "2030-01-01T00:00:00Z";
const brokerSession = {
	id: "bs_1",
	environment: "prod",
	services: ["github"],
	label: "ci",
	mintedBy: "user:u1",
	createdAt: T,
	expiresAt: T,
};
const brokerService = {
	name: "github",
	environment: "prod",
	host: "api.github.com",
	pathPrefix: "/",
	auth: { kind: "bearer", ref: "secret:GITHUB_TOKEN" },
	substitutions: [],
	enabled: true,
	description: "",
	notes: "",
	createdAt: T,
	updatedAt: T,
};
const brokerProposal = {
	id: "bp/1",
	environment: "prod",
	status: "pending",
	message: "need stripe",
	services: [brokerService],
	credentials: [
		{ ref: "secret:STRIPE", description: "", obtainInstructions: "" },
	],
	requestedBy: "machine:m1",
	createdAt: T,
	expiresAt: T,
};
const tokenInfo = {
	accessor: "acc_1",
	identityId: "mid_1",
	policies: ["ci"],
	parentAccessor: null,
	orphan: false,
	role: null,
	createdAt: T,
	expiresAt: T,
	maxExpiresAt: null,
	periodSecs: null,
	numUsesRemaining: null,
	boundCidrs: [],
	renewable: true,
	lastUsedAt: null,
	revokedAt: null,
	ttlSecs: 3600,
};
const wrapInfo = {
	token: "rwt_1",
	accessor: "wacc_1",
	ttlSecs: 300,
	creationPath: "secrets/API_KEY/reveal",
	createdAt: T,
	expiresAt: T,
};

test("broker routes send Core's session body and decode the proxy grant", async () => {
	const { calls, fetch } = routed({
		"GET /api/vault/broker/services": { services: [brokerService] },
		"POST /api/vault/broker/sessions": {
			token: "rvb_secret",
			session: brokerSession,
			proxy: {
				url: "http://127.0.0.1:8123",
				port: 8123,
				caPath: "/tmp/ca.pem",
				caBundlePath: "/tmp/bundle.pem",
				caUrl: "/api/vault/broker/ca.pem",
				env: { HTTPS_PROXY: "http://rvb:rvb_secret@127.0.0.1:8123" },
			},
		},
		"DELETE /api/vault/broker/sessions/bs_1": { revoked: true },
		"GET /api/vault/broker/logs": { logs: [] },
		"GET /api/vault/broker/proposals": { proposals: [brokerProposal] },
		"POST /api/vault/broker/proposals/bp%2F1/approve": {
			approved: true,
			proposal: "bp/1",
		},
		"POST /api/vault/broker/proposals/bp%2F1/reject": { rejected: true },
		"GET /api/vault/broker/ca.pem": "-----BEGIN CERTIFICATE-----\n",
		"POST /api/vault/agent/broker/sessions": {
			token: "rvb_agent",
			session: brokerSession,
			proxy: null,
		},
		"GET /api/vault/agent/broker/discover": {
			environment: "prod",
			unmatchedHostPolicy: "deny",
			skills: [],
			services: [],
			proxy: {
				listening: false,
				port: null,
				caUrl: "/api/vault/broker/ca.pem",
				portEnv: "RYU_BROKER_PORT",
			},
			proposalsEndpoint: "http://ryu.broker/proposals",
		},
	});
	const target = { url: "https://node.example", token: "node", fetch };
	const { services } = await listVaultBrokerServices(target, {
		environment: "prod",
	});
	expect(services[0]?.host).toBe("api.github.com");
	const grant = await createVaultBrokerSession(target, {
		environment: "prod",
		services: ["github"],
		ttlSecs: 900,
	});
	expect(grant.proxy?.env.HTTPS_PROXY).toContain("127.0.0.1:8123");
	expect(await revokeVaultBrokerSession(target, "bs_1")).toEqual({
		revoked: true,
	});
	await listVaultBrokerLogs(target, { service: "github", limit: 5 });
	const { proposals } = await listVaultBrokerProposals(target, {
		status: "pending",
	});
	expect(proposals[0]?.credentials[0]?.ref).toBe("secret:STRIPE");
	await decideVaultBrokerProposal(target, "bp/1", "approve", {
		values: { "secret:STRIPE": "sk_1" },
		note: "ok",
	});
	await decideVaultBrokerProposal(target, "bp/1", "reject", {
		values: { ignored: "x" },
	});
	expect(await getVaultBrokerCaPem(target)).toStartWith("-----BEGIN");
	const agent = { url: "https://node.example", vaultToken: "rvt_a", fetch };
	expect(
		(await vaultAgentBrokerSession(agent, { services: ["github"] })).proxy
	).toBeNull();
	expect((await vaultAgentBrokerDiscover(agent)).environment).toBe("prod");
	expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
		"GET /api/vault/broker/services?environment=prod",
		"POST /api/vault/broker/sessions",
		"DELETE /api/vault/broker/sessions/bs_1",
		"GET /api/vault/broker/logs?service=github&limit=5",
		"GET /api/vault/broker/proposals?status=pending",
		"POST /api/vault/broker/proposals/bp%2F1/approve",
		"POST /api/vault/broker/proposals/bp%2F1/reject",
		"GET /api/vault/broker/ca.pem",
		"POST /api/vault/agent/broker/sessions",
		"GET /api/vault/agent/broker/discover",
	]);
	expect(calls[1]?.body).toEqual({
		environment: "prod",
		services: ["github"],
		ttlSecs: 900,
	});
	expect(calls[5]?.body).toEqual({
		note: "ok",
		values: { "secret:STRIPE": "sk_1" },
	});
	// Reject carries no values, and the public CA route sends no bearer.
	expect(calls[6]?.body).toEqual({});
	expect(calls[7]?.headers.get("authorization")).toBeNull();
	expect(calls[8]?.headers.get("x-ryu-vault-token")).toBe("rvt_a");
	expect(calls[8]?.headers.get("authorization")).toBeNull();
});

test("TOTP, password-policy, and item routes match Core's handlers", async () => {
	const key = {
		name: "github",
		issuer: "GitHub",
		account: "me",
		algorithm: "SHA1",
		digits: 6,
		period: 30,
		skew: 1,
		generated: false,
		createdAt: T,
	};
	const item = {
		id: "it_1",
		environment: "prod",
		path: "/",
		key: "stripe",
		kind: "api",
		version: 2,
		status: "ready",
		fields: [
			{
				name: "account",
				type: "text",
				required: false,
				sensitive: false,
				hasValue: true,
				value: "acct_1",
			},
			{
				name: "password",
				type: "password",
				required: true,
				sensitive: true,
				hasValue: true,
			},
		],
		availableOperations: ["reveal"],
		createdAt: T,
		updatedAt: T,
	};
	const { calls, fetch } = routed({
		"GET /api/vault/totp/keys": { keys: [key] },
		"POST /api/vault/totp/keys": { key, url: "otpauth://totp/GitHub:me" },
		"GET /api/vault/totp/code/github": {
			code: "123456",
			period: 30,
			remainingSecs: 12,
		},
		"POST /api/vault/totp/validate/github": { valid: true },
		"GET /api/vault/agent/totp/code/github": {
			code: "654321",
			period: 30,
			remainingSecs: 3,
		},
		"PUT /api/vault/sys/password-policies/strong": {
			policy: {
				name: "strong",
				description: "",
				length: 24,
				rules: [{ charset: "abc", minChars: 1 }],
				createdAt: T,
				updatedAt: T,
			},
		},
		"GET /api/vault/sys/password-policies/strong/generate": {
			password: "pw",
		},
		"GET /api/vault/items": {
			items: [
				{
					id: "it_1",
					environment: "prod",
					path: "/",
					key: "stripe",
					kind: "api",
					version: 2,
					status: "ready",
					fieldCount: 2,
					updatedAt: T,
				},
			],
		},
		"GET /api/vault/items/stripe": { item },
		"PUT /api/vault/items/stripe": { item },
		"PATCH /api/vault/items/stripe": { item },
		"DELETE /api/vault/items/stripe": { deleted: true },
		"POST /api/vault/items/stripe/reveal": {
			field: "password",
			value: "hunter2",
		},
		"GET /api/vault/items/stripe/events": { events: [], next: 7 },
	});
	const target = { url: "https://node.example", token: "node", fetch };
	expect((await listVaultTotpKeys(target)).keys[0]?.name).toBe("github");
	expect(
		(await createVaultTotpKey(target, { name: "github", secret: "JBSWY3DP" }))
			.url
	).toStartWith("otpauth://");
	expect((await getVaultTotpCode(target, "github")).code).toBe("123456");
	expect(await validateVaultTotpCode(target, "github", "123456")).toEqual({
		valid: true,
	});
	expect(
		(
			await vaultAgentTotpCode(
				{ url: "https://node.example", vaultToken: "rvt", fetch },
				"github"
			)
		).code
	).toBe("654321");
	await putVaultPasswordPolicy(target, "strong", {
		length: 24,
		rules: [{ charset: "abc", minChars: 1 }],
	});
	expect(await generateVaultPassword(target, "strong")).toEqual({
		password: "pw",
	});
	expect(
		(await listVaultItems(target, { environment: "prod" })).items
	).toHaveLength(1);
	expect(
		(await getVaultItem(target, "stripe", { path: "/" })).item.fields[1]?.value
	).toBeUndefined();
	await putVaultItem(target, "stripe", {
		environment: "prod",
		kind: "api",
		fields: [{ name: "password", type: "password" }],
		values: { password: "hunter2" },
	});
	await patchVaultItem(target, "stripe", {
		expectedVersion: 2,
		expectedId: "it_1",
		values: { password: null },
	});
	await deleteVaultItem(target, "stripe", { expectedVersion: 2 });
	expect((await revealVaultItemField(target, "stripe", "password")).value).toBe(
		"hunter2"
	);
	expect(
		(await listVaultItemEvents(target, "stripe", { after: 3, wait: 10 })).next
	).toBe(7);
	expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
		"GET /api/vault/totp/keys",
		"POST /api/vault/totp/keys",
		"GET /api/vault/totp/code/github",
		"POST /api/vault/totp/validate/github",
		"GET /api/vault/agent/totp/code/github",
		"PUT /api/vault/sys/password-policies/strong",
		"GET /api/vault/sys/password-policies/strong/generate",
		"GET /api/vault/items?environment=prod",
		"GET /api/vault/items/stripe?path=%2F",
		"PUT /api/vault/items/stripe",
		"PATCH /api/vault/items/stripe",
		"DELETE /api/vault/items/stripe?expectedVersion=2",
		"POST /api/vault/items/stripe/reveal",
		"GET /api/vault/items/stripe/events?after=3&wait=10",
	]);
	expect(calls[3]?.body).toEqual({ code: "123456" });
	expect(calls[10]?.body).toEqual({
		expectedVersion: 2,
		expectedId: "it_1",
		values: { password: null },
	});
	expect(calls[12]?.body).toEqual({ field: "password" });
});

test("token lifecycle, wrapping, and cubbyhole routes", async () => {
	const { calls, fetch } = routed({
		"GET /api/vault/tokens/acc_1": { token: tokenInfo },
		"POST /api/vault/tokens/acc_1/renew": { token: tokenInfo },
		"POST /api/vault/tokens/acc_1/revoke-orphan": {
			revoked: { tokens: 1, leasesRevoked: 0, leasesFailed: 0 },
		},
		"PUT /api/vault/token-roles/ci": {
			role: {
				name: "ci",
				allowedPolicies: ["ci"],
				disallowedPolicies: [],
				orphan: false,
				createdAt: T,
				updatedAt: T,
			},
		},
		"POST /api/vault/sys/wrapping/wrap": { wrapInfo },
		"POST /api/vault/secrets/API_KEY/reveal": { wrapInfo },
		"POST /api/vault/sys/wrapping/unwrap": { value: "sk_1" },
		"POST /api/vault/sys/wrapping/lookup": {
			wrapInfo: { ...wrapInfo, token: undefined },
		},
		"GET /api/vault/agent/self/lookup": {
			token: tokenInfo,
			effectivePolicies: ["ci"],
		},
		"POST /api/vault/agent/self/renew": { token: tokenInfo },
		"PUT /api/vault/agent/cubbyhole/note": { written: true },
	});
	const target = { url: "https://node.example", token: "node", fetch };
	expect((await lookupVaultToken(target, "acc_1")).token.ttlSecs).toBe(3600);
	await renewVaultToken(target, "acc_1", { incrementSecs: 600 });
	expect((await revokeVaultTokenOrphan(target, "acc_1")).revoked.tokens).toBe(
		1
	);
	await putVaultTokenRole(target, "ci", { allowedPolicies: ["ci"] });
	expect(
		(await vaultWrap(target, { a: "b" }, { ttl: "5m" })).wrapInfo.token
	).toBe("rwt_1");
	await wrapVaultSecret(target, "API_KEY", { scope: "user" }, 300);
	const machine = { url: "https://node.example", fetch };
	expect(await vaultUnwrap(machine, "rwt_1")).toEqual({ value: "sk_1" });
	expect(
		(await vaultWrapLookup(machine, "rwt_1")).wrapInfo.token
	).toBeUndefined();
	const agent = { ...machine, vaultToken: "rvt_a" };
	expect((await vaultAgentLookupSelf(agent)).effectivePolicies).toEqual(["ci"]);
	await vaultAgentRenewSelf(agent, {});
	await vaultAgentCubbyholePut(agent, "note", { any: ["json"] });
	expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
		"GET /api/vault/tokens/acc_1",
		"POST /api/vault/tokens/acc_1/renew",
		"POST /api/vault/tokens/acc_1/revoke-orphan",
		"PUT /api/vault/token-roles/ci",
		"POST /api/vault/sys/wrapping/wrap",
		"POST /api/vault/secrets/API_KEY/reveal",
		"POST /api/vault/sys/wrapping/unwrap",
		"POST /api/vault/sys/wrapping/lookup",
		"GET /api/vault/agent/self/lookup",
		"POST /api/vault/agent/self/renew",
		"PUT /api/vault/agent/cubbyhole/note",
	]);
	expect(calls[1]?.body).toEqual({ incrementSecs: 600 });
	expect(calls[4]?.body).toEqual({ a: "b" });
	expect(calls[4]?.headers.get("x-ryu-wrap-ttl")).toBe("5m");
	expect(calls[5]?.headers.get("x-ryu-wrap-ttl")).toBe("300");
	expect(calls[5]?.body).toEqual({ scope: "user" });
	// Unwrap is public: the wrapping token rides in the body, never a bearer.
	expect(calls[6]?.body).toEqual({ token: "rwt_1" });
	expect(calls[6]?.headers.get("authorization")).toBeNull();
	expect(calls[10]?.body).toEqual({ any: ["json"] });
	expect(calls[10]?.headers.get("x-ryu-vault-token")).toBe("rvt_a");
});

const cardApproval = {
	id: "cap/1",
	itemId: "itm_1",
	environment: "default",
	path: "/",
	key: "visa",
	brand: "visa",
	last4: "4242",
	channel: "fill",
	merchantHost: "shop.example.com",
	requester: "user:u1",
	agent: "user:u1",
	status: "pending",
	uses: 0,
	requestedAt: T,
	requestExpiresAt: T,
};

test("card routes send the fixed card body and surface pending approvals", async () => {
	const { calls, fetch } = routed({
		"PUT /api/vault/items/visa": {
			item: {
				id: "itm_1",
				environment: "default",
				path: "/",
				key: "visa",
				kind: "card",
				version: 1,
				status: "ready",
				fields: [
					{ name: "number", type: "password", sensitive: true, hasValue: true },
				],
				card: { brand: "visa", last4: "4242", expired: false, merchants: [] },
			},
		},
		"POST /api/vault/items/visa/fill": {
			ok: true,
			status: "approval_required",
			approval: cardApproval,
			approvePath: "/api/vault/cards/approvals/cap%2F1/approve",
		},
		"POST /api/vault/items/visa/reveal": { field: "cvc", value: "123" },
		"GET /api/vault/cards/approvals": { approvals: [cardApproval] },
		"POST /api/vault/cards/approvals/cap%2F1/approve": {
			approval: { ...cardApproval, status: "approved", mode: "grant" },
		},
		"POST /api/vault/cards/approvals/cap%2F1/reject": {
			approval: { ...cardApproval, status: "rejected" },
		},
		"GET /api/vault/agent/cards/approvals/cap%2F1": {
			approval: { id: "cap/1", status: "pending" },
		},
	});
	const target = { url: "https://node.example", token: "node", fetch };
	const { item } = await putVaultCard(target, "visa", {
		cardholder: "Ada",
		number: "4242 4242 4242 4242",
		expMonth: 7,
		expYear: "2031",
		cvc: "123",
		country: "",
		merchants: ["shop.example.com"],
	});
	expect(item.card?.last4).toBe("4242");
	const filled = await fillVaultCard(
		target,
		"visa",
		"https://shop.example.com",
		{ environment: "default" }
	);
	expect(filled.status).toBe("approval_required");
	if (filled.status === "approval_required") {
		expect(filled.approval.id).toBe("cap/1");
	}
	const revealed = await revealVaultCardField(target, "visa", "cvc");
	expect(revealed).toEqual({ status: "released", field: "cvc", value: "123" });
	const { approvals } = await listVaultCardApprovals(target, {
		status: "pending",
	});
	expect(approvals[0]?.merchantHost).toBe("shop.example.com");
	await decideVaultCardApproval(target, "cap/1", "approve", {
		mode: "grant",
		subject: "agent",
		ttlSecs: 600,
		maxUses: 3,
	});
	await decideVaultCardApproval(target, "cap/1", "reject", {
		mode: "grant",
		note: "no",
	});
	const agent = { url: "https://node.example", vaultToken: "rvt_a", fetch };
	expect((await vaultAgentCardApproval(agent, "cap/1")).approval.status).toBe(
		"pending"
	);
	expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
		"PUT /api/vault/items/visa",
		"POST /api/vault/items/visa/fill",
		"POST /api/vault/items/visa/reveal",
		"GET /api/vault/cards/approvals?status=pending",
		"POST /api/vault/cards/approvals/cap%2F1/approve",
		"POST /api/vault/cards/approvals/cap%2F1/reject",
		"GET /api/vault/agent/cards/approvals/cap%2F1",
	]);
	expect(calls[0]?.body).toEqual({
		kind: "card",
		merchants: ["shop.example.com"],
		values: {
			cardholder: "Ada",
			number: "4242 4242 4242 4242",
			expMonth: "7",
			expYear: "2031",
			cvc: "123",
		},
	});
	expect(calls[1]?.body).toEqual({
		environment: "default",
		origin: "https://shop.example.com",
	});
	expect(calls[4]?.body).toEqual({
		mode: "grant",
		subject: "agent",
		ttlSecs: 600,
		maxUses: 3,
	});
	expect(calls[5]?.body).toEqual({ note: "no" });
	expect(calls[6]?.headers.get("x-ryu-vault-token")).toBe("rvt_a");
});

// ── Password-manager credentials ─────────────────────────────────────────────

const pmAccount = {
	id: "pma_1",
	name: "work",
	provider: "1password-connect",
	address: "https://connect.example",
	binaryPath: null,
	state: "connected",
	lastError: null,
	lastCheckedAt: null,
	createdAt: T,
	updatedAt: T,
};
const pmApproval = {
	...brokerProposal,
	id: "bpr/1",
	services: [],
	credentials: [],
	credentialUse: {
		ref: "op://work@dev/GitHub/token",
		accountId: "pma_1",
		account: "work",
		provider: "1password-connect",
		subject: "user:u1",
	},
};
const pmGrant = {
	id: "pmg_1",
	subject: "user:u1",
	accountId: "pma_1",
	account: "work",
	ref: "op://work@dev/GitHub/token",
	mode: "30d",
	usesRemaining: null,
	expiresAt: T,
	grantedBy: "operator",
	proposalId: "bpr/1",
	createdAt: T,
	revokedAt: null,
};

test("password-manager routes keep tokens in bodies and decode approvals", async () => {
	const { calls, fetch } = routed({
		"GET /api/vault/password-managers/accounts": { accounts: [pmAccount] },
		"POST /api/vault/password-managers/accounts": { account: pmAccount },
		"POST /api/vault/password-managers/accounts/pma_1/test": {
			ok: false,
			error: "the Connect server rejected the account token (401)",
			account: { ...pmAccount, state: "reconnect_required" },
		},
		"POST /api/vault/password-managers/accounts/pma_1/token": {
			account: pmAccount,
		},
		"GET /api/vault/password-managers/grants": { grants: [pmGrant] },
		"DELETE /api/vault/password-managers/grants/pmg_1": {
			revoked: true,
			grant: { ...pmGrant, revokedAt: T },
		},
		"GET /api/vault/password-managers/approvals": { approvals: [pmApproval] },
		"POST /api/vault/password-managers/approvals/bpr%2F1/approve": {
			approved: true,
			proposal: "bpr/1",
			grant: pmGrant,
		},
		"POST /api/vault/password-managers/approvals/bpr%2F1/reject": {
			rejected: true,
		},
		"POST /api/vault/broker/proposals/bp%2F1/approve": {
			approved: true,
			proposal: "bp/1",
		},
	});
	const target = { url: "https://node.example", token: "node", fetch };
	const { accounts } = await listVaultPasswordManagerAccounts(target);
	expect(accounts[0]?.provider).toBe("1password-connect");
	await createVaultPasswordManagerAccount(target, {
		name: "work",
		provider: "1password-connect",
		address: "https://connect.example",
		token: "tok_secret",
	});
	const tested = await testVaultPasswordManagerAccount(target, "pma_1");
	expect(tested.ok).toBe(false);
	expect(tested.account?.state).toBe("reconnect_required");
	await setVaultPasswordManagerToken(target, "pma_1", "tok_new");
	const { grants } = await listVaultPasswordManagerGrants(target, {
		all: true,
	});
	expect(grants[0]?.mode).toBe("30d");
	expect((await revokeVaultPasswordManagerGrant(target, "pmg_1")).revoked).toBe(
		true
	);
	const { approvals } = await listVaultPasswordManagerApprovals(target, {
		status: "pending",
	});
	expect(approvals[0]?.credentialUse?.subject).toBe("user:u1");
	const approved = await decideVaultPasswordManagerApproval(
		target,
		"bpr/1",
		"approve",
		{ grant: "once", note: "ok" }
	);
	expect("grant" in approved && approved.grant.id).toBe("pmg_1");
	await decideVaultPasswordManagerApproval(target, "bpr/1", "reject", {
		grant: "30d",
	});
	await decideVaultBrokerProposal(target, "bp/1", "approve", { grant: "1h" });
	expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
		"GET /api/vault/password-managers/accounts",
		"POST /api/vault/password-managers/accounts",
		"POST /api/vault/password-managers/accounts/pma_1/test",
		"POST /api/vault/password-managers/accounts/pma_1/token",
		"GET /api/vault/password-managers/grants?all=true",
		"DELETE /api/vault/password-managers/grants/pmg_1",
		"GET /api/vault/password-managers/approvals?status=pending",
		"POST /api/vault/password-managers/approvals/bpr%2F1/approve",
		"POST /api/vault/password-managers/approvals/bpr%2F1/reject",
		"POST /api/vault/broker/proposals/bp%2F1/approve",
	]);
	// Tokens travel only in request bodies, never in a URL.
	expect(calls[1]?.body).toEqual({
		name: "work",
		provider: "1password-connect",
		address: "https://connect.example",
		token: "tok_secret",
	});
	expect(calls[3]?.body).toEqual({ token: "tok_new" });
	expect(calls.some((call) => call.url.includes("tok_"))).toBe(false);
	expect(calls[7]?.body).toEqual({ grant: "once", note: "ok" });
	expect(calls[8]?.body).toEqual({});
	expect(calls[9]?.body).toEqual({ grant: "1h" });
});

test("password-manager reads decode a value or a 202 pending approval", async () => {
	let pendingReply = true;
	const bodies: unknown[] = [];
	const fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		if (pendingReply) {
			return Promise.resolve(
				Response.json({ pending: true, approval: pmApproval }, { status: 202 })
			);
		}
		return Promise.resolve(
			Response.json({
				value: "ghp_secret",
				ref: "op://work@dev/GitHub/token",
				account: "work",
				provider: "1password-connect",
			})
		);
	};
	const target = { url: "https://node.example", token: "node", fetch };
	const first = await readVaultPasswordManagerRef(
		target,
		"op://dev/GitHub/token",
		{ environment: "prod" }
	);
	expect(first.pending).toBe(true);
	if (first.pending) {
		expect(first.approval.id).toBe("bpr/1");
	}
	pendingReply = false;
	const second = await readVaultPasswordManagerRef(
		target,
		"op://dev/GitHub/token"
	);
	expect(second.pending).toBeUndefined();
	if (!second.pending) {
		expect(second.value).toBe("ghp_secret");
	}
	expect(bodies).toEqual([
		{ ref: "op://dev/GitHub/token", environment: "prod" },
		{ ref: "op://dev/GitHub/token" },
	]);
});

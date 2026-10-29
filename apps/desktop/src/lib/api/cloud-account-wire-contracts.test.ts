import { afterAll, beforeEach, expect, test } from "bun:test";
import {
	cloudGithubStateProjectionSchema,
	cloudSpeechAccountsSchema,
} from "./cloud-account-wire-contracts.ts";
import {
	connectCloudGithub,
	fetchCloudGithub,
	parseCloudGithubConnection,
} from "./cloud-github.ts";
import {
	editCloudSpeechAccounts,
	getCloudSpeechAccounts,
} from "./cloud-speech-accounts.ts";

let reply = Response.json({});
const requests: {
	body: string;
	method: string;
	path: string;
	authorization: string | null;
}[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		requests.push({
			body: await request.text(),
			method: request.method,
			path: new URL(request.url).pathname,
			authorization: request.headers.get("authorization"),
		});
		return reply.clone();
	},
});
const target = {
	url: String(server.url).replace(/\/$/, ""),
	token: "cloud-node",
	userJwt: "cloud-user",
};
beforeEach(() => {
	requests.length = 0;
});
afterAll(() => {
	server.stop(true);
});
const connection = {
	connected: true,
	login: "owner",
	vaultKey: "GITHUB_TOKEN",
	repositories: [{ fullName: "owner/repository", private: true }],
};
const policy = { name: "primary", enabled: true, priority: 65_535 };
const accountId = "a".repeat(64);
const google = {
	accountId,
	quotaProject: "speech-project",
	expiresAtUnixSecs: null,
	policy,
};
const polly = {
	accountId,
	accessKeyHint: "ABCD",
	hasSessionToken: true,
	expiresAtUnixSecs: 1_700_000_000,
	policy,
};
const accounts = {
	cloudSpeechAccountsSchema: 1,
	configRevision: "b".repeat(64),
	googleTts: [google],
	polly: { region: "us-east-1", accounts: [polly] },
};

test("GitHub validates optional Core state and projects out secrets from HTTP replies", async () => {
	reply = Response.json({
		...connection,
		token: "private",
		repositories: [{ ...connection.repositories[0], token: "private" }],
		state: { schemaVersion: 1, revision: 4, environments: [], vault: [] },
	});
	expect(await connectCloudGithub(target, "submitted-token", 3)).toEqual(
		connection
	);
	expect(requests[0]).toEqual({
		body: '{"token":"submitted-token","revision":3}',
		method: "POST",
		path: "/api/cloud-environments/github",
		authorization: "Bearer cloud-node",
	});
	reply = Response.json(connection);
	expect(await fetchCloudGithub(target)).toEqual(connection);
	for (const state of [
		null,
		{},
		{ schemaVersion: 1, revision: -1, environments: [], vault: [] },
	]) {
		reply = Response.json({ ...connection, state });
		await expect(
			connectCloudGithub(target, "submitted-token", 3)
		).rejects.toThrow("Invalid cloud environment");
	}
	expect(cloudGithubStateProjectionSchema.parse({}).present).toBe(false);
	expect(
		cloudGithubStateProjectionSchema.parse({ state: undefined }).present
	).toBe(true);
});

test("GitHub retains container, incomplete connection, and repository error precedence", () => {
	expect(() =>
		parseCloudGithubConnection({
			...connection,
			repositories: Array.from({ length: 101 }, () => null),
		})
	).toThrow("Invalid GitHub connection response");
	expect(() =>
		parseCloudGithubConnection({
			...connection,
			login: null,
			repositories: [null],
		})
	).toThrow("GitHub connection metadata is incomplete");
	for (const repository of [
		null,
		undefined,
		{},
		{ fullName: "owner/repository" },
		{ fullName: "https://invalid/repository", private: true },
	]) {
		expect(() =>
			parseCloudGithubConnection({ ...connection, repositories: [repository] })
		).toThrow("Invalid GitHub repository metadata");
	}
});

test("speech accounts validate all redacted fields without replacing metadata or nested references", async () => {
	const original = {
		...accounts,
		future: { nested: [1, null, "future"] },
		...JSON.parse('{"__proto__":{"future":true}}'),
	};
	expect(cloudSpeechAccountsSchema.parse(original)).toBe(original);
	expect(cloudSpeechAccountsSchema.parse(original).googleTts[0]).toBe(google);
	expect(
		cloudSpeechAccountsSchema.parse(original).polly.accounts[0]?.policy
	).toBe(policy);
	reply = Response.json(original);
	expect(await getCloudSpeechAccounts(target)).toEqual(original);
	for (const row of [
		{ accountId, policy },
		{ ...google, quotaProject: null },
		{ ...google, expiresAtUnixSecs: "tomorrow" },
		{ ...google, policy: { ...policy, priority: 65_536 } },
	]) {
		reply = Response.json({ ...accounts, googleTts: [row] });
		await expect(getCloudSpeechAccounts(target)).rejects.toThrow(
			"This node returned invalid cloud speech accounts."
		);
	}
	for (const row of [
		{ accountId, policy },
		{ ...polly, accessKeyHint: null },
		{ ...polly, hasSessionToken: "yes" },
	]) {
		reply = Response.json({
			...accounts,
			polly: { ...accounts.polly, accounts: [row] },
		});
		await expect(getCloudSpeechAccounts(target)).rejects.toThrow(
			"This node returned invalid cloud speech accounts."
		);
	}
});

test("speech account edits preserve optimistic revision and native Gateway acknowledgement semantics", async () => {
	reply = Response.json({
		success: true,
		persisted: true,
		configRevision: "next",
		gateway_restarted: false,
		gateway_application: {
			status: "applied",
			requestedRevision: "next",
			appliedRevision: "next",
			epoch: { boot: "boot", sequence: 1 },
		},
	});
	await editCloudSpeechAccounts(target, "current", {
		action: "configure",
		provider: "polly",
		accountId,
		accountPolicy: policy,
	});
	expect(requests[0]?.body).toBe(
		JSON.stringify({
			action: "configure",
			provider: "polly",
			accountId,
			accountPolicy: policy,
			expectedRevision: "current",
		})
	);
	expect(requests[0]?.method).toBe("PUT");
	reply = Response.json({ error: "not installed" }, { status: 404 });
	expect(await getCloudSpeechAccounts(target)).toBeNull();
	reply = Response.json({ message: "revision conflict" }, { status: 409 });
	await expect(getCloudSpeechAccounts(target)).rejects.toThrow(
		"/api/gateway/cloud-speech-accounts failed: 409"
	);
});

test("speech account edits accept Core's native receipt, which carries no restart flag", async () => {
	const savedRevision = "c".repeat(64);
	// Exactly what `gateway_cloud_speech_accounts::put` serializes.
	const coreReceipt = {
		success: true,
		persisted: true,
		configRevision: savedRevision,
		provider: "google-tts",
		gateway_application: {
			status: "applied",
			requestedRevision: savedRevision,
			appliedRevision: savedRevision,
			epoch: { boot: "00000000-0000-4000-8000-000000000001", sequence: 2 },
		},
	};
	const add = {
		action: "add",
		provider: "google-tts",
		accessToken: "synthetic-token",
		quotaProject: "speech-project",
	} as const;
	reply = Response.json(coreReceipt);
	await expect(
		editCloudSpeechAccounts(target, accounts.configRevision, add)
	).resolves.toBeUndefined();
	reply = Response.json({
		...coreReceipt,
		gateway_application: {
			status: "offline",
			requestedRevision: savedRevision,
		},
	});
	await expect(
		editCloudSpeechAccounts(target, accounts.configRevision, add)
	).rejects.toThrow(
		"Connection saved. Start your Gateway and refresh the node to apply it."
	);
	const { gateway_application: _application, ...unacknowledged } = coreReceipt;
	reply = Response.json(unacknowledged);
	await expect(
		editCloudSpeechAccounts(target, accounts.configRevision, add)
	).rejects.toThrow(
		"Connection saved, but Gateway restart did not finish. Check its status before retrying."
	);
	// Tolerating the absent flag does not accept a malformed one.
	reply = Response.json({ ...coreReceipt, gateway_restarted: "yes" });
	await expect(
		editCloudSpeechAccounts(target, accounts.configRevision, add)
	).rejects.toMatchObject({
		issues: [
			{
				code: "invalid_type",
				expected: "boolean",
				path: ["gateway_restarted"],
			},
		],
	});
});

import { describe, expect, test } from "bun:test";
import { RyuConfigurationError, type RyuFetch } from "@ryuhq/services";
import { type CliIo, runCli } from "../cli.ts";
import {
	configurationProblemOf,
	DOCTOR_SERVICES,
	humanReport,
	inspectService,
	probeUrl,
	runDoctor,
	safeUrl,
} from "../commands/doctor.ts";
import { createServicesMcpServer } from "../mcp/server.ts";
import { missingPhrase } from "../missing.ts";
import { workspaceProgram } from "../program.ts";
import { NPM_STATUS_NOTE } from "../version.ts";

const SECRETS = {
	RYU_API_KEY: "ryu_doctor_secret_1",
	RYU_MAIL_GATEWAY_KEY: "mail-gw-secret-2",
	RYU_NOTIFY_API_KEY: "notify-secret-3",
	RYU_PASSPORT_RUNTIME_KEY: "passport-runtime-secret-4",
};

const ENV = {
	...SECRETS,
	RYU_ORGANIZATION_ID: "org_doctor",
	RYU_NOTIFY_URL: "https://user:pw@notify.example.com/base?token=abc",
};

interface DoctorRun {
	code: number;
	out: string;
	requests: Request[];
}

async function doctor(
	argv: string[],
	env: Record<string, string>,
	respond: (request: Request) => Response | Promise<Response> = () =>
		new Response("{}"),
	origin: Pick<CliIo, "bundledWith" | "npmPublishedVersion"> = {}
): Promise<DoctorRun> {
	let out = "";
	let err = "";
	const requests: Request[] = [];
	const fetch: RyuFetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		return await respond(request);
	};
	const code = await runCli(["doctor", ...argv], {
		...origin,
		env,
		fetch,
		stdin: "",
		stdout: { write: (chunk: string) => (out += chunk) },
		stderr: { write: (chunk: string) => (err += chunk) },
	});
	return { code, out: out + err, requests };
}

/** Secret fragments that appear in `text` (should be none). */
function leakedSecrets(text: string): string[] {
	return [...Object.values(SECRETS), "pw@", "token=abc"].filter((secret) =>
		text.includes(secret)
	);
}

interface JsonReport {
	data: {
		npmNote: string | null;
		npmPublishedVersion: string | null;
		services: {
			service: string;
			configured: boolean;
			baseUrl: string | null;
			auth: string | null;
			mailMode: string | null;
			env: { name: string; set: boolean; value?: string }[];
			defaulted: boolean;
			problem: { code?: string; missing: string[] } | null;
			probe?: {
				authVerified: boolean;
				ok: boolean;
				status: number;
				code: string | null;
				url: string;
			};
		}[];
	};
}

describe("doctor", () => {
	test("words Mail's keys as alternatives and every other service's as all needed", async () => {
		const empty = await doctor([], {});
		expect(empty.out).toContain(
			"mail           not configured  (set one of: RYU_API_KEY or RYU_MAIL_GATEWAY_KEY for hosted Mail, or RYU_MAIL_URL and RYU_MAIL_API_KEY for a self-hosted server)"
		);
		expect(empty.out).toContain(
			"not configured  (set RYU_SITES_URL and RYU_SITES_API_KEY)"
		);
		// Every Messaging route names the organization, whatever the key.
		expect(empty.out).toContain(
			"messaging      not configured  (set RYU_API_KEY and RYU_ORGANIZATION_ID)"
		);
		expect(missingPhrase("mail", ["RYU_MAIL_API_KEY"])).toBe(
			"set RYU_MAIL_API_KEY"
		);
		expect(missingPhrase("mail", ["RYU_API_KEY", "RYU_MAIL_GATEWAY_KEY"])).toBe(
			"set one of: RYU_API_KEY or RYU_MAIL_GATEWAY_KEY for hosted Mail"
		);
		expect(missingPhrase("box", [])).toBe("");
	});

	test("words Passport's key as the administration token or the runtime grant", async () => {
		const empty = await doctor([], {});
		expect(empty.out).toContain(
			"(set RYU_PASSPORT_URL and one of RYU_PASSPORT_API_KEY (administration) or RYU_PASSPORT_RUNTIME_KEY (an agent's runtime grant))"
		);
		expect(missingPhrase("passport", ["RYU_PASSPORT_API_KEY"])).toBe(
			"set one of RYU_PASSPORT_API_KEY (administration) or RYU_PASSPORT_RUNTIME_KEY (an agent's runtime grant)"
		);
		expect(missingPhrase("passport", ["RYU_PASSPORT_URL"])).toBe(
			"set RYU_PASSPORT_URL"
		);
	});

	test("lists resolved config per service with keys redacted", async () => {
		const human = await doctor([], ENV);
		expect(human.code).toBe(0);
		expect(human.requests).toHaveLength(0);
		expect(human.out).toContain("RYU_API_KEY=set");
		expect(human.out).toContain(
			"RYU_NOTIFY_URL=https://notify.example.com/base"
		);
		// Box defaults to its hosted origin; only the key is missing.
		expect(human.out).toContain("not configured  (set RYU_BOX_API_KEY)");
		expect(human.out).toContain(
			"default (not set)  http://127.0.0.1:7981  (set RYU_GATEWAY_URL or RYU_GATEWAY_TOKEN; not probed)"
		);
		expect(leakedSecrets(human.out)).toEqual([]);

		const json = await doctor(["--json"], ENV);
		expect(leakedSecrets(json.out)).toEqual([]);
		const report = JSON.parse(json.out) as JsonReport;
		const byService = new Map(
			report.data.services.map((entry) => [entry.service, entry])
		);
		expect(byService.get("managedAgents")).toMatchObject({
			configured: true,
			baseUrl: "https://api.ryuhq.com",
			auth: "x-api-key",
		});
		expect(byService.get("mail")).toMatchObject({
			configured: true,
			mailMode: "hosted",
			auth: "x-gateway-key",
		});
		expect(byService.get("notify")).toMatchObject({
			configured: true,
			auth: "bearer",
		});
		expect(byService.get("gateway")).toMatchObject({
			configured: false,
			defaulted: true,
			baseUrl: "http://127.0.0.1:7981",
			problem: { code: "not_set" },
		});
		expect(byService.get("notify")?.defaulted).toBe(false);
		expect(byService.get("box")?.problem?.missing).toEqual(["RYU_BOX_API_KEY"]);
		// Mail lists the control-plane key it would fall back to.
		expect(byService.get("mail")?.env.map((row) => row.name)).toEqual([
			"RYU_MAIL_URL",
			"RYU_MAIL_GATEWAY_KEY",
			"RYU_MAIL_API_KEY",
			"RYU_API_KEY",
			"RYU_ORGANIZATION_ID",
		]);
		expect(byService.get("passport")?.env).toContainEqual({
			name: "RYU_PASSPORT_RUNTIME_KEY",
			role: "runtime-key",
			set: true,
		} as never);
	});

	test("--check probes each configured service with its own auth and never prints keys", async () => {
		// ENV sets a Passport runtime key without RYU_PASSPORT_URL, which
		// `--check` fails on; leave it out here so only probes decide the code.
		const { RYU_PASSPORT_RUNTIME_KEY: _runtimeKey, ...probeEnv } = ENV;
		const run = await doctor(["--check", "--json"], probeEnv, () =>
			Response.json({ ok: true }, { status: 200 })
		);
		const urls = run.requests.map((request) => request.url);
		// Gateway resolves only through its default, so it is not probed.
		// Userinfo is dropped from the probe URL; the auth header carries the key.
		expect(urls).toEqual([
			"https://api.ryuhq.com/api/v1/managed-agents/agents?limit=1",
			"https://api.ryuhq.com/api/mail/pods",
			"https://notify.example.com/base/v1/events?limit=1",
			// Messaging reuses RYU_API_KEY and RYU_ORGANIZATION_ID.
			"https://api.ryuhq.com/api/messaging/orgs/org_doctor/settings",
		]);
		const [agents, mail, notify, messaging] = run.requests;
		expect(messaging?.headers.get("x-api-key")).toBe(SECRETS.RYU_API_KEY);
		expect(messaging?.headers.get("x-ryu-organization")).toBe("org_doctor");
		expect(agents?.headers.get("x-api-key")).toBe(SECRETS.RYU_API_KEY);
		expect(agents?.headers.get("x-ryu-organization")).toBe("org_doctor");
		expect(agents?.headers.get("authorization")).toBeNull();
		expect(mail?.headers.get("x-gateway-key")).toBe(
			SECRETS.RYU_MAIL_GATEWAY_KEY
		);
		expect(mail?.headers.get("authorization")).toBeNull();
		expect(notify?.headers.get("authorization")).toBe(
			`Bearer ${SECRETS.RYU_NOTIFY_API_KEY}`
		);
		for (const request of run.requests) {
			expect(request.redirect).toBe("manual");
		}
		expect(run.code).toBe(0);
		expect(leakedSecrets(run.out)).toEqual([]);
		const report = JSON.parse(run.out) as JsonReport;
		const probes = new Map(
			report.data.services.map((entry) => [entry.service, entry.probe])
		);
		expect(probes.get("gateway")).toBeUndefined();
		expect(probes.get("notify")).toEqual({
			authVerified: true,
			ok: true,
			status: 200,
			code: null,
			url: "https://notify.example.com/base/v1/events",
		});
		expect(probes.get("managedAgents")?.authVerified).toBe(true);
		// Hosted Mail is probed on its pod list, which checks the gateway key.
		expect(probes.get("mail")).toEqual({
			authVerified: true,
			ok: true,
			status: 200,
			code: null,
			url: "https://api.ryuhq.com/api/mail/pods",
		});
	});

	test("--check labels public probes as reachable and key-checking probes as authenticated", async () => {
		const run = await doctor(["--check"], {
			RYU_CONNECT_URL: "https://connect.example.com",
			RYU_CONNECT_API_KEY: "c",
			RYU_MAIL_URL: "https://mail.example.com",
			RYU_MAIL_API_KEY: "m",
		});
		expect(run.code).toBe(0);
		expect(run.out).toContain(
			"check: reachable (auth not verified) 200  https://connect.example.com/health"
		);
		expect(run.out).toContain(
			"check: authenticated 200  https://mail.example.com/api/mail/status"
		);
	});

	test("--check verifies the hosted Mail gateway key on the pod list", async () => {
		const run = await doctor(
			["--check", "--json"],
			{ RYU_MAIL_GATEWAY_KEY: SECRETS.RYU_MAIL_GATEWAY_KEY },
			(request) =>
				request.headers.get("x-gateway-key") === SECRETS.RYU_MAIL_GATEWAY_KEY
					? Response.json(
							{
								type: "https://docs.ryuhq.com/docs/reference/api/errors#unauthenticated",
								title: "Unauthorized",
								status: 401,
								detail: "invalid gateway key",
								code: "unauthenticated",
							},
							{
								status: 401,
								headers: { "content-type": "application/problem+json" },
							}
						)
					: new Response("{}")
		);
		expect(run.code).toBe(1);
		expect(run.requests.map((request) => request.url)).toEqual([
			"https://api.ryuhq.com/api/mail/pods",
		]);
		expect(run.requests[0]?.method).toBe("GET");
		expect(leakedSecrets(run.out)).toEqual([]);
		const report = JSON.parse(run.out) as JsonReport;
		expect(
			report.data.services.find((entry) => entry.service === "mail")?.probe
		).toEqual({
			authVerified: true,
			ok: false,
			status: 401,
			code: "unauthenticated",
			url: "https://api.ryuhq.com/api/mail/pods",
		});
	});

	test("hosted Mail on RYU_API_KEY alone counts as set and is probed with x-api-key", async () => {
		const run = await doctor(
			["--check", "--json"],
			{ RYU_API_KEY: SECRETS.RYU_API_KEY, RYU_ORGANIZATION_ID: "org_doctor" },
			() => Response.json({ pods: [] })
		);
		expect(run.code).toBe(0);
		expect(leakedSecrets(run.out)).toEqual([]);
		const mail = run.requests.find((request) =>
			request.url.includes("/api/mail/")
		);
		expect(mail?.url).toBe("https://api.ryuhq.com/api/mail/pods");
		expect(mail?.headers.get("x-api-key")).toBe(SECRETS.RYU_API_KEY);
		expect(mail?.headers.get("x-ryu-organization")).toBe("org_doctor");
		expect(mail?.headers.get("x-gateway-key")).toBeNull();
		const report = JSON.parse(run.out) as JsonReport;
		expect(
			report.data.services.find((entry) => entry.service === "mail")
		).toMatchObject({
			configured: true,
			defaulted: false,
			auth: "x-api-key",
			mailMode: "hosted",
			probe: { authVerified: true, ok: true },
		});
	});

	test("a send-only ryu_ key (403 insufficient_scope on the mail:read probe) is authenticated but scope-limited", async () => {
		const scopeDenied = (request: { url: string }) =>
			request.url.includes("/api/mail/")
				? Response.json(
						{
							error: "Missing scope",
							code: "insufficient_scope",
							requiredScope: "mail:read",
						},
						{ status: 403 }
					)
				: Response.json({ data: [] });
		const human = await doctor(
			["--check"],
			{ RYU_API_KEY: SECRETS.RYU_API_KEY },
			scopeDenied
		);
		expect(human.code).toBe(0);
		expect(human.out).toContain(
			"check: authenticated (key lacks the scope this probe reads) 403 insufficient_scope"
		);
		const json = await doctor(
			["--check", "--json"],
			{ RYU_API_KEY: SECRETS.RYU_API_KEY },
			scopeDenied
		);
		const report = JSON.parse(json.out) as JsonReport;
		expect(
			report.data.services.find((entry) => entry.service === "mail")?.probe
		).toMatchObject({
			authVerified: true,
			code: "insufficient_scope",
			ok: true,
			scopeLimited: true,
			status: 403,
		});
	});

	test("any other 403 on the ryu_ key still fails the probe", async () => {
		const run = await doctor(
			["--check"],
			{ RYU_API_KEY: SECRETS.RYU_API_KEY },
			(request) =>
				request.url.includes("/api/mail/")
					? Response.json(
							{ error: "Mail is off", code: "feature_disabled" },
							{ status: 403 }
						)
					: Response.json({ data: [] })
		);
		expect(run.code).toBe(1);
		expect(run.out).toContain("check: failed 403");
	});

	test("a 403 insufficient_scope on a gateway key is a failure", async () => {
		const run = await doctor(
			["--check"],
			{ RYU_MAIL_GATEWAY_KEY: "rgw_doctor_scope" },
			() =>
				Response.json(
					{ error: "Missing scope", code: "insufficient_scope" },
					{ status: 403 }
				)
		);
		expect(run.code).toBe(1);
		expect(run.out).toContain("check: failed 403 insufficient_scope");
	});

	test("Box and Notify keys alone probe the hosted origins", async () => {
		const run = await doctor(
			["--check"],
			{ RYU_BOX_API_KEY: "box-key-7", RYU_NOTIFY_API_KEY: "notify-key-7" },
			() => Response.json({ ok: true })
		);
		expect(run.code).toBe(0);
		expect(run.requests.map((request) => request.url)).toEqual([
			"https://notify.ryuhq.com/v1/events?limit=1",
			"https://box.ryuhq.com/v1/boxes",
		]);
		expect(run.out).not.toContain("box-key-7");
	});

	test("--check with only Notify set exits 0 and never touches the default Gateway", async () => {
		const run = await doctor(
			["--check"],
			{
				RYU_NOTIFY_URL: "https://notify.example.com",
				RYU_NOTIFY_API_KEY: "notify-only",
			},
			(request) =>
				new URL(request.url).hostname === "127.0.0.1"
					? Promise.reject(new TypeError("connection refused"))
					: new Response("{}")
		);
		expect(run.code).toBe(0);
		expect(run.requests.map((request) => request.url)).toEqual([
			"https://notify.example.com/v1/events?limit=1",
		]);
	});

	test("an explicitly set service that is down fails the run", async () => {
		const run = await doctor(
			["--check", "--json"],
			{ RYU_GATEWAY_URL: "http://127.0.0.1:7981" },
			() => Promise.reject(new TypeError("connection refused"))
		);
		expect(run.code).toBe(1);
		const report = JSON.parse(run.out) as JsonReport;
		expect(
			report.data.services.find((entry) => entry.service === "gateway")?.probe
		).toMatchObject({ ok: false, status: 0, code: "connection_error" });
	});

	test("--check --dry-run and other request flags are rejected; nothing is sent", async () => {
		for (const flag of [
			["--dry-run"],
			["--api-key", "FLAGSECRET"],
			["--base-url", "https://x.example.com"],
			["--idempotency-key", "i"],
			["--max-retries", "1"],
		]) {
			const run = await doctor(["--check", ...flag], ENV);
			expect(run.code).toBe(2);
			expect(run.requests).toHaveLength(0);
			// A workspace build names its real launch line, not `ryu-services`.
			expect(run.out).toContain(
				`${workspaceProgram()} doctor does not take ${flag[0]}`
			);
			expect(run.out).not.toContain("FLAGSECRET");
		}
		const timed = await doctor(["--check", "--timeout", "500"], {
			RYU_GATEWAY_URL: "http://gw.example.com",
		});
		expect(timed.code).toBe(0);
	});

	test("--check exits 0 when every probe passes and reports error codes when one fails", async () => {
		const ok = await doctor(["--check"], {
			RYU_GATEWAY_URL: "http://gw.example.com",
		});
		expect(ok.code).toBe(0);
		expect(ok.out).toContain("check: reachable (auth not verified) 200");

		const failing = await doctor(
			["--check"],
			{
				RYU_SITES_URL: "https://sites.example.com",
				RYU_SITES_API_KEY: "sites-key-5",
			},
			(request) =>
				request.url.includes("sites")
					? new Response(
							JSON.stringify({
								error: { code: "unauthorized", message: "no" },
							}),
							{
								status: 401,
								headers: { "content-type": "application/json" },
							}
						)
					: new Response("{}")
		);
		expect(failing.code).toBe(1);
		expect(failing.out).toContain("check: failed 401 unauthorized");
		expect(failing.out).not.toContain("sites-key-5");
	});

	test("--check verifies the Notify, Box, Sites and Passport keys on authenticated reads", async () => {
		const run = await doctor(
			["--check", "--json"],
			{
				RYU_NOTIFY_URL: "https://notify.example.com",
				RYU_NOTIFY_API_KEY: "notify-key-6",
				RYU_BOX_URL: "https://box.example.com",
				RYU_BOX_API_KEY: "box-key-6",
				RYU_SITES_URL: "https://sites.example.com",
				RYU_SITES_API_KEY: "sites-key-6",
				RYU_PASSPORT_URL: "https://passport.example.com",
				RYU_PASSPORT_RUNTIME_KEY: "passport-runtime-6",
			},
			(request) =>
				request.url.includes("notify")
					? new Response(
							JSON.stringify({
								error: { code: "unauthorized", message: "bad key" },
							}),
							{
								status: 401,
								headers: { "content-type": "application/json" },
							}
						)
					: Response.json({ ok: true })
		);
		expect(run.requests.map((request) => request.url)).toEqual([
			"https://notify.example.com/v1/events?limit=1",
			"https://box.example.com/v1/boxes",
			"https://passport.example.com/v1/runtime/connections",
			"https://sites.example.com/api/sites/status",
		]);
		const passport = run.requests.find((request) =>
			request.url.includes("passport")
		);
		expect(passport?.headers.get("authorization")).toBe(
			"Bearer passport-runtime-6"
		);
		expect(run.code).toBe(1);
		expect(leakedSecrets(run.out)).toEqual([]);
		const report = JSON.parse(run.out) as JsonReport;
		const probes = new Map(
			report.data.services.map((entry) => [entry.service, entry.probe])
		);
		expect(probes.get("notify")).toMatchObject({
			authVerified: true,
			ok: false,
			status: 401,
			code: "unauthorized",
		});
		for (const service of ["box", "sites", "passport"]) {
			expect(probes.get(service as never)).toMatchObject({
				authVerified: true,
				ok: true,
			});
		}
		const { config } = inspectService("passport", {
			RYU_PASSPORT_URL: "https://passport.example.com",
			RYU_PASSPORT_API_KEY: "admin",
		});
		expect(config && probeUrl(config)).toBe(
			"https://passport.example.com/v1/capabilities"
		);
	});

	test("--check exits 1 for a service that is set but does not resolve", async () => {
		const badUrl = await doctor(["--check", "--json"], {
			RYU_BOX_API_KEY: "box-key-7",
			RYU_BOX_URL: "box.example.com",
		});
		expect(badUrl.code).toBe(1);
		expect(badUrl.requests).toHaveLength(0);
		const report = JSON.parse(badUrl.out) as JsonReport;
		expect(
			report.data.services.find((entry) => entry.service === "box")
		).toMatchObject({ configured: false });
		// Sites has no hosted default: a key without a URL cannot resolve.
		const missingUrl = await doctor(["--check"], {
			RYU_SITES_API_KEY: "sites-key-7",
		});
		expect(missingUrl.code).toBe(1);
		// Without --check the same environment only reports.
		expect((await doctor([], { RYU_SITES_API_KEY: "sites-key-7" })).code).toBe(
			0
		);
		expect((await doctor(["--check"], {})).code).toBe(0);
		// A runtime key without RYU_PASSPORT_URL fails the gate too.
		expect((await doctor(["--check"], ENV)).code).toBe(1);
	});

	test("a configuration problem keeps its message and hint apart", async () => {
		// Missing keys: the message never repeats the hint, which is its own field.
		const box = inspectService("box", {}).report.problem;
		expect(box?.missing).toEqual(["RYU_BOX_API_KEY"]);
		expect(box?.hint).toContain("RYU_BOX_API_KEY");
		expect(box?.message).not.toContain("Hint:");
		expect(box?.message).not.toContain(box?.hint ?? "-");

		// An invalid URL has no hint; the human report never prints a
		// `Hint:` suffix inside the parenthesis.
		const invalid = { RYU_BOX_URL: "nope", RYU_BOX_API_KEY: "k" };
		const report = inspectService("box", invalid).report.problem;
		expect(report).toMatchObject({ code: "invalid_url", hint: null });
		const run = await doctor([], { ...invalid, RYU_NOTIFY_URL: "" });
		expect(run.out).not.toContain("Hint:");
	});

	test("doctor takes no positionals", async () => {
		expect((await doctor(["extra"], {})).code).toBe(2);
		expect((await doctor(["--help"], {})).code).toBe(0);
	});

	test("helpers", () => {
		expect(safeUrl("https://a:b@x.example.com/p?q=1#f")).toBe(
			"https://x.example.com/p"
		);
		expect(safeUrl("not a url")).toBe("(invalid URL)");
		const { config } = inspectService("box", {
			RYU_BOX_URL: "https://box.example.com/",
			RYU_BOX_API_KEY: "k",
		});
		expect(config && probeUrl(config)).toBe("https://box.example.com/v1/boxes");
		const withUserinfo = inspectService("box", {
			RYU_BOX_URL: "https://u:p@box.example.com/x?q=1",
			RYU_BOX_API_KEY: "k",
		}).config;
		expect(withUserinfo && probeUrl(withUserinfo)).toBe(
			"https://box.example.com/x/v1/boxes"
		);
		expect(inspectService("gateway", {}).config).toBeNull();
		expect(inspectService("gateway", {}).report.defaulted).toBe(true);
		expect(inspectService("box", {}).config).toBeNull();
	});
});

describe("doctor hint line", () => {
	test("a hinted configuration error without missing settings prints its hint once, on its own line", () => {
		const error = new RyuConfigurationError({
			service: "notify",
			status: 0,
			code: "configuration_error",
			message: "RYU_NOTIFY_URL is not a valid URL.",
			details: null,
			hint: "Use an absolute http(s) URL.",
		});
		expect(error.message).toContain("Hint: Use an absolute http(s) URL.");
		const problem = configurationProblemOf(error);
		expect(problem).toEqual({
			code: "configuration_error",
			hint: "Use an absolute http(s) URL.",
			message: "RYU_NOTIFY_URL is not a valid URL.",
			missing: [],
		});
		const { report } = inspectService("notify", {});
		const lines = humanReport({
			...report,
			configured: false,
			defaulted: false,
			problem,
		}).split("\n");
		expect(lines[0]).toContain(
			"not configured  (RYU_NOTIFY_URL is not a valid URL.)"
		);
		expect(lines[0]).not.toContain("Hint:");
		expect(lines[1]?.trim()).toBe("hint: Use an absolute http(s) URL.");
		expect(lines.join("\n").match(/absolute http\(s\) URL/gu)).toHaveLength(1);
	});
});

describe("doctor npm-status note", () => {
	test("ends the human report with the note and carries it under --json", async () => {
		expect(NPM_STATUS_NOTE).not.toBeNull();
		const human = await doctor([], {});
		expect(human.code).toBe(0);
		expect(human.out.endsWith(`\n\nnote: ${NPM_STATUS_NOTE}\n`)).toBe(true);

		const json = await doctor(["--json"], {});
		const report = JSON.parse(json.out) as JsonReport;
		expect(report.data.npmPublishedVersion).toBeNull();
		expect(report.data.npmNote).toBe(NPM_STATUS_NOTE);
		expect(json.out).not.toContain("note: ");
	});

	test("names a bundling host instead of a workspace build", async () => {
		const human = await doctor([], {}, undefined, {
			bundledWith: "ryu-cli 9.9.9",
		});
		expect(human.out).toContain(
			"\n\nnote: This command line is bundled with ryu-cli 9.9.9, not installed from npm."
		);
		expect(human.out).not.toContain("workspace build");
	});

	test("prints no note once @ryuhq/services is published", async () => {
		const human = await doctor([], {}, undefined, {
			npmPublishedVersion: "1.2.3",
		});
		expect(human.code).toBe(0);
		expect(human.out).not.toContain("note: ");
		expect(human.out.endsWith("\n\n")).toBe(false);

		const json = await doctor(["--json"], {}, undefined, {
			bundledWith: "ryu-cli 9.9.9",
			npmPublishedVersion: "1.2.3",
		});
		const report = JSON.parse(json.out) as JsonReport;
		expect(report.data.npmPublishedVersion).toBe("1.2.3");
		expect(report.data.npmNote).toBeNull();
	});

	test("runDoctor defaults the note to the module's NPM_STATUS_NOTE", async () => {
		let out = "";
		const code = await runDoctor({
			check: false,
			fetch: () => Promise.reject(new Error("no network")),
			io: {
				env: {},
				readFile: () => Promise.reject(new Error("no files")),
				readStdin: () => Promise.resolve(""),
				readStdinBytes: () => Promise.resolve(new Uint8Array()),
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string) => {
						out += chunk;
						return true;
					},
				},
			},
			json: false,
		});
		expect(code).toBe(0);
		expect(out.endsWith(`\n\nnote: ${NPM_STATUS_NOTE}\n`)).toBe(true);
	});
});

describe("doctor credential-free MCP tools", () => {
	test("a workspace build names its bun launch line, not an uninstalled ryu-services", async () => {
		const launch = workspaceProgram();
		const run = await doctor([], { RYU_BOX_URL: "localhost:8021" }, undefined, {
			npmPublishedVersion: null,
		});
		expect(run.out).toContain(
			`mcp: \`${launch} mcp\` still registers mail_status`
		);
		expect(run.out).toContain(
			`mcp: \`${launch} mcp\` still registers messaging_status`
		);
		expect(run.out).not.toMatch(/(?<![\w"@/.-])ryu-services(?![\w"-])/u);
	});

	test("an unconfigured Mail or Messaging names the status tool `ryu-services mcp` still registers", async () => {
		const empty = await doctor([], {}, undefined, {
			npmPublishedVersion: "1.2.3",
		});
		expect(empty.requests).toHaveLength(0);
		const lines = empty.out.split("\n");
		const lineAfter = (service: string) =>
			lines[lines.findIndex((line) => line.startsWith(service)) + 1]?.trim();
		expect(lineAfter("mail ")).toBe(
			"mcp: `ryu-services mcp` still registers mail_status (unless --services leaves mail out), which needs no credentials and sends none"
		);
		expect(lineAfter("messaging ")).toBe(
			"mcp: `ryu-services mcp` still registers messaging_status (unless --services leaves messaging out), which needs no credentials and sends none"
		);
		// No other service has a credential-free tool.
		expect(empty.out.match(/still registers/gu)).toHaveLength(2);

		const json = JSON.parse((await doctor(["--json"], {})).out) as JsonReport;
		const tools = new Map(
			json.data.services.map((entry) => [
				entry.service,
				(entry as { credentialFreeTools?: string[] }).credentialFreeTools,
			])
		);
		expect(tools.get("mail")).toEqual(["mail_status"]);
		expect(tools.get("messaging")).toEqual(["messaging_status"]);
		expect(tools.get("box")).toEqual([]);
		expect(tools.get("gateway")).toEqual([]);
	});

	test("matches what the MCP server registers: none once configured, none for a self-hosted Mail URL without its token", async () => {
		const configured = await doctor(["--json"], {
			RYU_API_KEY: "ryu_k",
			RYU_ORGANIZATION_ID: "org_1",
		});
		const configuredReport = JSON.parse(configured.out) as JsonReport;
		for (const entry of configuredReport.data.services) {
			if (entry.service === "mail" || entry.service === "messaging") {
				expect(entry.configured).toBe(true);
				expect(
					(entry as { credentialFreeTools?: string[] }).credentialFreeTools
				).toEqual([]);
			}
		}
		const selfHosted = await doctor([], {
			RYU_MAIL_URL: "https://mail.example.com",
		});
		expect(selfHosted.out).not.toContain("mail_status");
		// Messaging still needs its organization, so its status tool stays.
		expect(selfHosted.out).toContain("still registers messaging_status");
	});

	test("credentialFreeTools equals what createServicesMcpServer registers, across env combinations", () => {
		const envs: Record<string, string>[] = [
			{},
			{ RYU_API_KEY: "ryu_k" },
			{ RYU_ORGANIZATION_ID: "org_1" },
			{ RYU_API_KEY: "ryu_k", RYU_ORGANIZATION_ID: "org_1" },
			{ RYU_MAIL_API_KEY: "mail_k" },
			{ RYU_MAIL_URL: "https://mail.example.com" },
			{ RYU_MAIL_URL: "https://mail.example.com", RYU_MAIL_API_KEY: "mail_k" },
			{ RYU_MAIL_URL: "https://mail.example.com", RYU_API_KEY: "ryu_k" },
			{
				RYU_MAIL_GATEWAY_KEY: "gw_k",
				RYU_MAIL_URL: "https://mail.example.com",
			},
			{ RYU_API_URL: "not a url" },
			{ RYU_API_URL: "http://api.example.com", RYU_API_KEY: "ryu_k" },
			{ RYU_MAIL_GATEWAY_KEY: "gw_k" },
			{ RYU_GATEWAY_TOKEN: "gt", RYU_GATEWAY_URL: "https://gw.example.com" },
		];
		for (const env of envs) {
			const { registration } = createServicesMcpServer({
				config: { env: { ...env } },
				log: () => undefined,
			});
			for (const service of DOCTOR_SERVICES) {
				const registered =
					registration.credentialFree.find((entry) => entry.service === service)
						?.tools ?? [];
				expect({
					env,
					service,
					tools: inspectService(service, env).report.credentialFreeTools,
				}).toEqual({ env, service, tools: registered });
			}
		}
	});

	test("names the host's command", async () => {
		let out = "";
		await runDoctor({
			check: false,
			fetch: () => Promise.reject(new Error("no request")),
			io: {
				env: {},
				program: "ryu-cli services",
				readFile: () => Promise.reject(new Error("unused")),
				readStdin: () => Promise.resolve(""),
				stderr: { write: () => undefined },
				stdout: { write: (chunk: string) => (out += chunk) },
			},
			json: false,
			npmNote: null,
		});
		expect(out).toContain(
			"mcp: `ryu-cli services mcp` still registers mail_status"
		);
		expect(out).not.toContain("`ryu-services mcp`");
	});
});

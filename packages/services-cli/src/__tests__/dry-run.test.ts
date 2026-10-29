import { describe, expect, test } from "bun:test";
import { requireStringFlag } from "../args.ts";
import { type CliIo, runCli } from "../cli.ts";
import {
	createCaptureFetch,
	dryRunCredentials,
	primaryKeyEnv,
	quoteWithPlaceholders,
	shellQuote,
	toCurl,
} from "../curl.ts";
import {
	CLI_SERVICES,
	type CliService,
	type ServiceCommand,
} from "../registry.ts";

interface Run {
	readonly calls: () => number;
	readonly io: CliIo;
	readonly output: () => string;
	readonly stdout: () => string;
}

function capture(env: Record<string, string>): Run {
	let out = "";
	let err = "";
	let calls = 0;
	return {
		io: {
			env,
			stdin: "",
			stdout: { write: (chunk: string) => (out += chunk) },
			stderr: { write: (chunk: string) => (err += chunk) },
			fetch: () => {
				calls += 1;
				return Promise.reject(new Error("a dry run must not send requests"));
			},
		},
		calls: () => calls,
		stdout: () => out,
		output: () => out + err,
	};
}

const commands: Record<string, ServiceCommand> = {
	notify: {
		path: ["publish"],
		summary: "Publish.",
		flags: { title: { type: "string", description: "Title." } },
		run: (ctx) =>
			ctx.ryu.notify
				.with(ctx.call)
				.publish({ title: requireStringFlag(ctx.flags, "title") }),
	},
	mail: {
		path: ["inboxes", "list"],
		summary: "List inboxes.",
		run: (ctx) => ctx.ryu.mail.inboxes.list(),
	},
	"managed-agents": {
		path: ["agents", "list"],
		summary: "List agents.",
		run: (ctx) => ctx.ryu.managedAgents.agents.list({ limit: 1 }),
	},
	box: {
		path: ["noop"],
		summary: "Makes no request.",
		run: () => ({ local: true }),
	},
};

const SERVICES: CliService[] = CLI_SERVICES.map((entry) => {
	const command = commands[entry.name];
	return command ? { ...entry, commands: [command] } : entry;
});

/** The CLI services with `name`'s commands replaced by `command`. */
function servicesWith(name: string, command: ServiceCommand): CliService[] {
	return CLI_SERVICES.map((entry) =>
		entry.name === name ? { ...entry, commands: [command] } : entry
	);
}

describe("--dry-run", () => {
	test("prints curl with the key placeholder and sends nothing", async () => {
		const run = capture({
			RYU_NOTIFY_URL: "https://notify.example.com",
			RYU_NOTIFY_API_KEY: "notify-real-secret",
			RYU_API_KEY: "ryu_control_plane_secret",
		});
		const code = await runCli(
			[
				"notify",
				"publish",
				"--title",
				"It's done",
				"--dry-run",
				"--idempotency-key",
				"deploy-1",
			],
			run.io,
			{ services: SERVICES }
		);
		expect(code).toBe(0);
		expect(run.calls()).toBe(0);
		const out = run.stdout();
		expect(out).toStartWith(
			"curl -X POST 'https://notify.example.com/v1/events'"
		);
		expect(out).toContain('-H "authorization: Bearer $RYU_NOTIFY_API_KEY"');
		expect(out).toContain("-H 'idempotency-key: deploy-1'");
		expect(out).toContain(`--data-raw '{"title":"It'\\''s done"}'`);
		expect(run.output()).not.toContain("notify-real-secret");
		expect(run.output()).not.toContain("ryu_control_plane_secret");
	});

	test("works without any key: the placeholder stands in", async () => {
		const run = capture({});
		const code = await runCli(
			[
				"notify",
				"publish",
				"--title",
				"x",
				"--dry-run",
				"--base-url",
				"http://127.0.0.1:8092",
			],
			run.io,
			{ services: SERVICES }
		);
		expect(code).toBe(0);
		expect(run.stdout()).toContain("http://127.0.0.1:8092/v1/events");
		expect(run.stdout()).toContain("Bearer $RYU_NOTIFY_API_KEY");
		expect(run.calls()).toBe(0);
	});

	test("an --api-key value never appears in the output", async () => {
		const run = capture({ RYU_NOTIFY_URL: "https://notify.example.com" });
		const code = await runCli(
			[
				"notify",
				"publish",
				"--title",
				"x",
				"--dry-run",
				"--api-key",
				"flag-secret-value",
			],
			run.io,
			{ services: SERVICES }
		);
		expect(code).toBe(0);
		expect(run.output()).not.toContain("flag-secret-value");
		expect(run.stdout()).toContain("$RYU_NOTIFY_API_KEY");
	});

	test("hosted Mail shows x-gateway-key: $RYU_MAIL_GATEWAY_KEY and no Authorization", async () => {
		const run = capture({ RYU_MAIL_GATEWAY_KEY: "gw-real-secret" });
		expect(
			await runCli(["mail", "inboxes", "list", "--dry-run"], run.io, {
				services: SERVICES,
			})
		).toBe(0);
		const out = run.stdout();
		expect(out).toContain("https://api.ryuhq.com/api/mail/inboxes");
		expect(out).toContain('-H "x-gateway-key: $RYU_MAIL_GATEWAY_KEY"');
		expect(out).not.toContain("authorization");
		expect(run.output()).not.toContain("gw-real-secret");
	});

	test("hosted Mail on RYU_API_KEY alone shows x-api-key: $RYU_API_KEY", async () => {
		const run = capture({
			RYU_API_KEY: "ryu_real_mail_secret",
			RYU_ORGANIZATION_ID: "org_1",
		});
		expect(
			await runCli(["mail", "inboxes", "list", "--dry-run"], run.io, {
				services: SERVICES,
			})
		).toBe(0);
		const out = run.stdout();
		expect(out).toContain("https://api.ryuhq.com/api/mail/inboxes");
		expect(out).toContain('-H "x-api-key: $RYU_API_KEY"');
		expect(out).not.toContain("x-gateway-key");
		expect(run.output()).not.toContain("ryu_real_mail_secret");
	});

	test("self-hosted Mail shows the bearer placeholder", async () => {
		const run = capture({
			RYU_MAIL_URL: "http://127.0.0.1:7996",
			RYU_MAIL_API_KEY: "self-secret",
		});
		expect(
			await runCli(["mail", "inboxes", "list", "--dry-run"], run.io, {
				services: SERVICES,
			})
		).toBe(0);
		expect(run.stdout()).toContain('"authorization: Bearer $RYU_MAIL_API_KEY"');
		expect(run.output()).not.toContain("self-secret");
	});

	test("a Managed Agents list sends one request and shows x-api-key", async () => {
		const run = capture({
			RYU_API_KEY: "ryu_real_secret",
			RYU_ORGANIZATION_ID: "org_1",
		});
		expect(
			await runCli(["managed-agents", "agents", "list", "--dry-run"], run.io, {
				services: SERVICES,
			})
		).toBe(0);
		const out = run.stdout();
		expect(out).toContain(
			"https://api.ryuhq.com/api/v1/managed-agents/agents?limit=1"
		);
		expect(out).toContain('"x-api-key: $RYU_API_KEY"');
		expect(run.output()).not.toContain("ryu_real_secret");
	});

	test("a Managed Agents stream prints its one opening request and terminates (no reconnect loop)", async () => {
		const run = capture({
			RYU_API_KEY: "ryu_real_secret",
			RYU_ORGANIZATION_ID: "org_1",
		});
		const stream: ServiceCommand = {
			path: ["sessions", "stream"],
			summary: "Stream a session.",
			usage: "<id>",
			run: (ctx) => ctx.ryu.managedAgents.sessions.stream(ctx.args[0] ?? ""),
		};
		const code = await runCli(
			["managed-agents", "sessions", "stream", "ses_1", "--dry-run"],
			run.io,
			{ services: servicesWith("managed-agents", stream) }
		);
		expect(code).toBe(0);
		expect(run.calls()).toBe(0);
		const out = run.stdout();
		expect(out.match(/^curl /gmu)).toHaveLength(1);
		expect(out).toContain(
			"https://api.ryuhq.com/api/v1/managed-agents/sessions/ses_1/stream"
		);
		expect(out).toContain('"x-api-key: $RYU_API_KEY"');
		expect(run.output()).not.toContain("ryu_real_secret");
	}, 5000);

	test("a multi-step command prints only its first request", async () => {
		const run = capture({
			RYU_BOX_URL: "https://box.example.com",
			RYU_BOX_API_KEY: "box-real-secret",
		});
		const composite: ServiceCommand = {
			path: ["twice"],
			summary: "Lists, then lists again.",
			run: async (ctx) => {
				await ctx.ryu.box.list();
				return ctx.ryu.box.snapshots.list();
			},
		};
		expect(
			await runCli(["box", "twice", "--dry-run"], run.io, {
				services: servicesWith("box", composite),
			})
		).toBe(0);
		const out = run.stdout();
		expect(out.match(/^curl /gmu)).toHaveLength(1);
		expect(out).toContain("https://box.example.com/v1/boxes");
		expect(out).not.toContain("snapshots");
		expect(out).toContain('"authorization: Bearer $RYU_BOX_API_KEY"');
		expect(run.output()).not.toContain("box-real-secret");
	});

	test("mail send --from <address> says the send was left out after the inbox lookup", async () => {
		const env = { RYU_API_KEY: "ryu_x", RYU_ORGANIZATION_ID: "org_1" };
		const send = [
			"mail",
			"send",
			"--to",
			"b@y.example",
			"--subject",
			"hi",
			"--text",
			"yo",
			"--dry-run",
		];
		const byAddress = capture(env);
		expect(await runCli([...send, "--from", "a@x.example"], byAddress.io)).toBe(
			0
		);
		expect(byAddress.calls()).toBe(0);
		expect(byAddress.stdout()).toContain("curl -X GET");
		expect(byAddress.stdout()).toContain("/api/mail/inboxes");
		expect(byAddress.stdout()).not.toContain("dry run: printed step");
		expect(byAddress.output()).toContain(
			"dry run: printed step 1 of 2, the inbox lookup for the --from address; the send was left out."
		);

		const byId = capture(env);
		expect(await runCli([...send, "--from", "inb_123"], byId.io)).toBe(0);
		expect(byId.stdout()).toContain("curl -X POST");
		expect(byId.stdout()).toContain("/inboxes/inb_123/send");
		expect(byId.output()).not.toContain("dry run: printed step");

		// --json carries the note on stdout, for a reader that ignores stderr.
		interface DryRunJson {
			data: { complete: boolean; note: string | null; curl: string[] };
		}
		const jsonByAddress = capture(env);
		expect(
			await runCli(
				[...send, "--from", "a@x.example", "--json"],
				jsonByAddress.io
			)
		).toBe(0);
		const partial = JSON.parse(jsonByAddress.stdout()) as DryRunJson;
		expect(partial.data.complete).toBe(false);
		expect(partial.data.note).toStartWith(
			"dry run: printed step 1 of 2, the inbox lookup"
		);
		expect(partial.data.curl).toHaveLength(1);
		expect(partial.data.curl[0]).toStartWith("curl -X GET");

		const jsonById = capture(env);
		expect(
			await runCli([...send, "--from", "inb_123", "--json"], jsonById.io)
		).toBe(0);
		const whole = JSON.parse(jsonById.stdout()) as DryRunJson;
		expect(whole.data.complete).toBe(true);
		expect(whole.data.note).toBeNull();
	});

	test("Gateway: a set RYU_GATEWAY_TOKEN becomes its placeholder before the client sees it", () => {
		// The Gateway namespace has no methods until its work package lands, so
		// this pins the dry-run inputs a Gateway command will be built from.
		const { env, apiKey } = dryRunCredentials(
			"gateway",
			{
				RYU_GATEWAY_URL: "http://127.0.0.1:7981",
				RYU_GATEWAY_TOKEN: "gw-real",
			},
			{}
		);
		expect(env.RYU_GATEWAY_TOKEN).toBe("$RYU_GATEWAY_TOKEN");
		expect(env.RYU_GATEWAY_URL).toBe("http://127.0.0.1:7981");
		expect(apiKey).toBeUndefined();
		expect(primaryKeyEnv("gateway", env)).toBe("RYU_GATEWAY_TOKEN");
		expect(
			dryRunCredentials("gateway", {}, { apiKey: "flag-token" }).apiKey
		).toBe("$RYU_GATEWAY_TOKEN");
	});

	test("--json prints the redacted request and the curl text", async () => {
		const run = capture({
			RYU_NOTIFY_URL: "https://notify.example.com",
			RYU_NOTIFY_API_KEY: "notify-real-secret",
		});
		expect(
			await runCli(
				["notify", "publish", "--title", "x", "--dry-run", "--json"],
				run.io,
				{ services: SERVICES }
			)
		).toBe(0);
		const printed = JSON.parse(run.stdout()) as {
			data: {
				dryRun: boolean;
				complete: boolean;
				requests: { method: string; headers: [string, string][] }[];
				curl: string[];
			};
		};
		expect(printed.data.dryRun).toBe(true);
		expect(printed.data.complete).toBe(true);
		expect(printed.data.requests[0]?.method).toBe("POST");
		expect(printed.data.requests[0]?.headers).toContainEqual([
			"authorization",
			"Bearer $RYU_NOTIFY_API_KEY",
		]);
		expect(printed.data.curl[0]).toStartWith("curl -X POST");
		expect(run.stdout()).not.toContain("notify-real-secret");
	});

	test("a command that makes no request says so and exits 0", async () => {
		const run = capture({
			RYU_BOX_URL: "https://box.example.com",
			RYU_BOX_API_KEY: "k-secret",
		});
		expect(
			await runCli(["box", "noop", "--dry-run"], run.io, { services: SERVICES })
		).toBe(0);
		expect(run.output()).toContain("the command made no request");
	});

	test("a configuration error before any request still exits 2", async () => {
		const run = capture({ RYU_NOTIFY_URL: "not a url" });
		expect(
			await runCli(["notify", "publish", "--title", "x", "--dry-run"], run.io, {
				services: SERVICES,
			})
		).toBe(2);
		expect(run.output()).toContain("RYU_NOTIFY_URL");
	});
});

describe("curl formatting", () => {
	test("shellQuote escapes single quotes", () => {
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});

	test("placeholders stay expandable", () => {
		expect(
			quoteWithPlaceholders("authorization: Bearer $RYU_GATEWAY_TOKEN")
		).toBe('"authorization: Bearer $RYU_GATEWAY_TOKEN"');
		expect(quoteWithPlaceholders("x: a'b $RYU_X_KEY!")).toBe(
			`'x: a'\\''b '"$RYU_X_KEY"'!'`
		);
		expect(quoteWithPlaceholders("plain")).toBe("'plain'");
	});

	test("auth headers without a placeholder are forced to it, and secrets are scrubbed", () => {
		const curl = toCurl(
			{
				method: "POST",
				url: "http://127.0.0.1:7981/v1/chat/completions",
				headers: [
					["authorization", "Bearer gw-token-value"],
					["x-echo", "gw-token-value"],
				],
				body: '{"token":"gw-token-value"}',
			},
			{ keyPlaceholder: "$RYU_GATEWAY_TOKEN", secrets: ["gw-token-value"] }
		);
		expect(curl).toContain('"authorization: Bearer $RYU_GATEWAY_TOKEN"');
		expect(curl).not.toContain("gw-token-value");
		expect(curl).toContain("[redacted]");
	});

	test("the placeholder names follow the design", () => {
		expect(primaryKeyEnv("notify")).toBe("RYU_NOTIFY_API_KEY");
		expect(primaryKeyEnv("gateway")).toBe("RYU_GATEWAY_TOKEN");
		expect(primaryKeyEnv("managedAgents")).toBe("RYU_API_KEY");
		expect(primaryKeyEnv("mail")).toBe("RYU_MAIL_GATEWAY_KEY");
		expect(
			primaryKeyEnv("mail", { RYU_MAIL_URL: "http://127.0.0.1:7996" })
		).toBe("RYU_MAIL_API_KEY");
		expect(primaryKeyEnv("mail", {}, "https://api.ryuhq.com")).toBe(
			"RYU_MAIL_GATEWAY_KEY"
		);
		expect(primaryKeyEnv("sites")).toBe("RYU_SITES_API_KEY");
	});

	test("hosted Mail with only RYU_API_KEY uses that key's placeholder", () => {
		const env = { RYU_API_KEY: "ryu_real_secret" };
		expect(primaryKeyEnv("mail", env)).toBe("RYU_API_KEY");
		expect(primaryKeyEnv("mail", env, undefined, true)).toBe(
			"RYU_MAIL_GATEWAY_KEY"
		);
		expect(
			primaryKeyEnv("mail", { ...env, RYU_MAIL_GATEWAY_KEY: "rgw_x" })
		).toBe("RYU_MAIL_GATEWAY_KEY");
		expect(
			primaryKeyEnv("mail", { ...env, RYU_MAIL_URL: "http://127.0.0.1:7996" })
		).toBe("RYU_MAIL_API_KEY");
		const credentials = dryRunCredentials("mail", env, {});
		expect(credentials.env.RYU_API_KEY).toBe("$RYU_API_KEY");
		expect(credentials.env.RYU_MAIL_GATEWAY_KEY).toBeUndefined();
	});

	test("dryRunCredentials replaces only the target service's keys", () => {
		const { env, apiKey } = dryRunCredentials(
			"passport",
			{
				RYU_PASSPORT_API_KEY: "a",
				RYU_PASSPORT_RUNTIME_KEY: "b",
				RYU_NOTIFY_API_KEY: "c",
			},
			{}
		);
		expect(env.RYU_PASSPORT_API_KEY).toBe("$RYU_PASSPORT_API_KEY");
		expect(env.RYU_PASSPORT_RUNTIME_KEY).toBe("$RYU_PASSPORT_RUNTIME_KEY");
		expect(env.RYU_NOTIFY_API_KEY).toBe("c");
		expect(apiKey).toBeUndefined();
		expect(
			dryRunCredentials("gateway", {}, {}).env.RYU_GATEWAY_TOKEN
		).toBeUndefined();
		expect(dryRunCredentials("box", {}, { apiKey: "k" }).apiKey).toBe(
			"$RYU_BOX_API_KEY"
		);
	});

	test("the capture fetch records requests and answers a non-retryable 400", async () => {
		const capture = createCaptureFetch();
		const response = await capture.fetch("https://x.example.com/a", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(response.status).toBe(400);
		expect(capture.requests).toEqual([
			{
				method: "POST",
				url: "https://x.example.com/a",
				headers: [["content-type", "application/json"]],
				body: "{}",
			},
		]);
	});
});

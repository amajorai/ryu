import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
	MAIL_CANONICAL_METHODS,
	MAIL_TOP_LEVEL_METHODS,
	mailPageSize,
	type RyuFetch,
} from "@ryuhq/services";
import { type CliIo, runCli } from "../cli.ts";
import { mailCommands, nextMailPage } from "../commands/mail.ts";
import { createServicesMcpServer } from "../mcp/server.ts";
import { workspaceProgram } from "../program.ts";
import { commandLine } from "../registry.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

function stubFetch(respond: (request: Recorded) => Response) {
	const calls: Recorded[] = [];
	const fetch: RyuFetch = async (input, init) => {
		const request = new Request(input, init);
		const recorded: Recorded = {
			body: request.body === null ? null : await request.text(),
			headers: request.headers,
			method: request.method,
			url: request.url,
		};
		calls.push(recorded);
		return respond(recorded);
	};
	return { calls, fetch };
}

const HOSTED_ENV = { RYU_MAIL_GATEWAY_KEY: "rgw_cli_mail_secret" };
const SELF_HOSTED_ENV = {
	RYU_MAIL_API_KEY: "self-hosted-cli-secret",
	RYU_MAIL_URL: "http://127.0.0.1:7996",
};
const NOW = "2026-10-10T12:00:00.000Z";

const INBOX = {
	address: "agent@acme.example",
	agentId: null,
	clientId: null,
	createdAt: NOW,
	id: "inbox_1",
	metadata: {},
	name: "Agent",
	podId: null,
	provider: "webhook",
	updatedAt: NOW,
};

function message(id: string, createdAt = NOW) {
	return {
		attachments: [],
		bcc: [],
		cc: [],
		createdAt,
		direction: "outbound",
		from: "agent@acme.example",
		id,
		inboxId: "inbox_1",
		labels: [],
		status: "sent",
		subject: "Hi",
		to: ["a@example.com"],
	};
}

/** A Mail server stub routed by `METHOD /path`. */
function mailServer(): (request: Recorded) => Response {
	return (request) => {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		switch (route) {
			case "GET /api/mail/status":
				return Response.json({
					apiVersion: "v1",
					configured: true,
					domainMode: "managed",
					inbound: "sns",
					sendConfigured: true,
				});
			case "GET /api/mail/inboxes":
				return Response.json({ inboxes: [INBOX] });
			case "POST /api/mail/inboxes":
				return Response.json(INBOX, { status: 201 });
			case "GET /api/mail/inboxes/inbox_1/messages": {
				const before = url.searchParams.get("before");
				const page =
					before === null ? [message("m2", "2026-10-02T00:00:00.000Z")] : [];
				return Response.json({ messages: page });
			}
			case "GET /api/mail/messages/m1":
				return Response.json(message("m1"));
			case "POST /api/mail/inboxes/inbox_1/send":
				return Response.json(message("sent_1"), { status: 201 });
			default:
				return new Response(`no route ${route}`, { status: 599 });
		}
	};
}

interface Run {
	code: number;
	stderr: string;
	stdout: string;
}

async function run(
	argv: string[],
	io: Partial<CliIo> & { env: Record<string, string> }
): Promise<Run> {
	let stdout = "";
	let stderr = "";
	const code = await runCli(argv, {
		stdin: "",
		fetch: () => Promise.reject(new Error("unexpected network call")),
		stdout: { write: (chunk: string) => (stdout += chunk) },
		stderr: { write: (chunk: string) => (stderr += chunk) },
		...io,
	});
	return { code, stdout, stderr };
}

/** The `ryu.mail.<member>` names a source file calls. */
function mailMembers(file: string): string[] {
	const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
	return [...source.matchAll(/\bryu\.mail\.([A-Za-z_$][\w$]*)/gu)].map(
		(match) => match[1] ?? ""
	);
}

/** `ryu.mail` members that are canonical: service-level verbs and resource namespaces. */
/**
 * The `ryu.mail` members the CLI may call: the resource namespaces (the first
 * segment of every canonical SDK path), the top-level methods, the `send`
 * convenience, and `with`. Derived from the SDK so the guard cannot drift.
 */
const CANONICAL_MAIL_MEMBERS = new Set<string>([
	...Object.keys(MAIL_CANONICAL_METHODS).map(
		(path) => path.split(".")[0] ?? path
	),
	...MAIL_TOP_LEVEL_METHODS,
	"send",
	"with",
]);

describe("canonical spelling", () => {
	test("the mail commands and MCP tools call ryu.mail through resource namespaces", () => {
		// The MCP tools are defined in the @ryuhq/services tool registry.
		for (const file of [
			"commands/mail.ts",
			"../../services/src/tools/mail.ts",
		]) {
			const members = mailMembers(file);
			expect({ file, called: members.length > 0 }).toEqual({
				file,
				called: true,
			});
			expect({
				file,
				flat: members.filter((name) => !CANONICAL_MAIL_MEMBERS.has(name)),
			}).toEqual({ file, flat: [] });
		}
	});
});

describe("ryu-services mail", () => {
	test("registers the design §10 commands", () => {
		expect(mailCommands.map((command) => commandLine("mail", command))).toEqual(
			[
				"ryu-services mail status",
				"ryu-services mail inboxes list",
				"ryu-services mail inboxes create",
				"ryu-services mail messages list",
				"ryu-services mail messages get",
				"ryu-services mail send",
			]
		);
		const readOnly = mailCommands
			.filter((command) => command.readOnly)
			.map((command) => command.path.join(" "));
		expect(readOnly).toEqual([
			"status",
			"inboxes list",
			"messages list",
			"messages get",
		]);
	});

	test("inboxes list prints { data, meta } with the gateway key on the wire", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const result = await run(["mail", "inboxes", "list", "--json"], {
			env: HOSTED_ENV,
			fetch,
		});
		expect(result.code).toBe(0);
		const printed = JSON.parse(result.stdout) as {
			data: { id: string }[];
			meta: { status: number };
		};
		expect(printed.data.map((inbox) => inbox.id)).toEqual(["inbox_1"]);
		expect(printed.meta.status).toBe(200);
		expect(calls[0]?.headers.get("x-gateway-key")).toBe("rgw_cli_mail_secret");
		expect(calls[0]?.headers.get("authorization")).toBeNull();
		expect(result.stdout).not.toContain("rgw_cli_mail_secret");
	});

	test("messages list sends limit and before; --all pages until a short page", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const page = await run(
			[
				"mail",
				"messages",
				"list",
				"inbox_1",
				"--limit",
				"10",
				"--before",
				"2026-10-05T00:00:00.000Z",
				"--json",
			],
			{ env: SELF_HOSTED_ENV, fetch }
		);
		expect(page.code).toBe(0);
		const query = new URL(calls[0]?.url ?? "").searchParams;
		expect(query.get("limit")).toBe("10");
		expect(query.get("before")).toBe("2026-10-05T00:00:00.000Z");
		expect(calls[0]?.headers.get("authorization")).toBe(
			"Bearer self-hosted-cli-secret"
		);

		const all = await run(
			["mail", "messages", "list", "inbox_1", "--all", "--limit", "1"],
			{ env: SELF_HOSTED_ENV, fetch }
		);
		expect(all.code).toBe(0);
		const lines = all.stdout.trim().split("\n");
		expect(
			lines.map((line) => (JSON.parse(line) as { id: string }).id)
		).toEqual(["m2"]);
		// The first page was full (1 of 1), so a second page was requested.
		expect(
			calls.slice(1).map((call) => new URL(call.url).searchParams.get("before"))
		).toEqual([null, "2026-10-02T00:00:00.000Z"]);
	});

	test("one page in human mode: one JSON line per item, paging notes on stderr", async () => {
		const { fetch } = stubFetch(mailServer());
		const inboxes = await run(["mail", "inboxes", "list"], {
			env: HOSTED_ENV,
			fetch,
		});
		expect(inboxes.code).toBe(0);
		const inboxLines = inboxes.stdout.trim().split("\n");
		expect(inboxLines).toHaveLength(1);
		expect(JSON.parse(inboxLines[0] ?? "")).toMatchObject(INBOX);
		expect(inboxes.stderr).toBe("");

		// A full page (1 of --limit 1) may have more: stderr names --before.
		const full = await run(
			["mail", "messages", "list", "inbox_1", "--limit", "1"],
			{ env: SELF_HOSTED_ENV, fetch }
		);
		expect(full.code).toBe(0);
		expect(
			full.stdout
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { id: string }).id)
		).toEqual(["m2"]);
		expect(full.stderr).toBe(
			"More messages may follow: pass --before 2026-10-02T00:00:00.000Z for the next page, or --all for every message.\n"
		);

		// A short page (1 of the default 50) is the last one.
		const short = await run(["mail", "messages", "list", "inbox_1"], {
			env: SELF_HOSTED_ENV,
			fetch,
		});
		expect(short.stderr).toBe("");

		const empty = await run(
			[
				"mail",
				"messages",
				"list",
				"inbox_1",
				"--before",
				"2026-10-02T00:00:00.000Z",
			],
			{ env: SELF_HOSTED_ENV, fetch }
		);
		expect({ code: empty.code, stdout: empty.stdout }).toEqual({
			code: 0,
			stdout: "",
		});
		expect(empty.stderr).toBe("No messages.\n");
	});

	test("nextMailPage clamps the page size like the servers", () => {
		const page = (count: number) =>
			Array.from({ length: count }, (_, index) => ({
				createdAt: `2026-10-0${(index % 9) + 1}T00:00:00.000Z`,
			}));
		expect(nextMailPage(page(49), undefined)).toBeNull();
		expect(nextMailPage(page(50), undefined)).toContain("--before");
		expect(nextMailPage(page(200), 500)).toContain("--before");
		expect(nextMailPage(page(199), 500)).toBeNull();
		expect(nextMailPage([{ createdAt: 1 }], 1)).toBeNull();
	});

	test("nextMailPage uses the SDK's exported page size (mailPageSize, what --all pages by)", () => {
		const page = (count: number) =>
			Array.from({ length: count }, () => ({
				createdAt: "2026-10-01T00:00:00.000Z",
			}));
		for (const limit of [undefined, 0, 1, 7, 50, 199, 200, 201, 1000]) {
			const size = mailPageSize(limit);
			expect(nextMailPage(page(size), limit)).toContain("--before");
			expect(nextMailPage(page(size - 1), limit)).toBeNull();
		}
	});

	test("messages get and status read one resource", async () => {
		const { fetch } = stubFetch(mailServer());
		const got = await run(["mail", "messages", "get", "m1", "--json"], {
			env: HOSTED_ENV,
			fetch,
		});
		expect((JSON.parse(got.stdout) as { data: { id: string } }).data.id).toBe(
			"m1"
		);
		const status = await run(["mail", "status", "--json"], {
			env: HOSTED_ENV,
			fetch,
		});
		expect(
			(JSON.parse(status.stdout) as { data: { configured: boolean } }).data
				.configured
		).toBe(true);
	});

	test("status needs no credentials on hosted Mail and sends none, like the mail_status tool", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const status = await run(["mail", "status", "--json"], { env: {}, fetch });
		expect(status.code).toBe(0);
		expect(calls[0]?.url).toBe("https://api.ryuhq.com/api/mail/status");
		for (const header of ["authorization", "x-api-key", "x-gateway-key"]) {
			expect({ header, sent: calls[0]?.headers.has(header) }).toEqual({
				header,
				sent: false,
			});
		}
		// A ryu_ key on its own makes Mail configured, so status sends it.
		const keyed = stubFetch(mailServer());
		await run(["mail", "status"], {
			env: { RYU_API_KEY: "ryu_cli_mail_key" },
			fetch: keyed.fetch,
		});
		expect(keyed.calls[0]?.headers.get("x-api-key")).toBe("ryu_cli_mail_key");
		// A self-hosted URL without its token is still a configuration error:
		// that server guards its status route.
		const selfHosted = await run(["mail", "status"], {
			env: { RYU_MAIL_URL: SELF_HOSTED_ENV.RYU_MAIL_URL },
		});
		expect(selfHosted.code).not.toBe(0);
		expect(selfHosted.stderr).toContain("RYU_MAIL_API_KEY");
	});

	test("send resolves --from by address and passes --idempotency-key", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const result = await run(
			[
				"mail",
				"send",
				"--from",
				"agent@acme.example",
				"--to",
				"a@example.com",
				"--to",
				"b@example.com",
				"--cc",
				"c@example.com",
				"--subject",
				"Hi",
				"--text",
				"Hello",
				"--idempotency-key",
				"cli-send-0001",
				"--json",
			],
			{ env: HOSTED_ENV, fetch }
		);
		expect(result.code).toBe(0);
		expect(
			calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
		).toEqual(["GET /api/mail/inboxes", "POST /api/mail/inboxes/inbox_1/send"]);
		const send = calls[1];
		expect(send?.headers.get("idempotency-key")).toBe("cli-send-0001");
		expect(JSON.parse(send?.body ?? "{}")).toMatchObject({
			cc: ["c@example.com"],
			subject: "Hi",
			text: "Hello",
			to: ["a@example.com", "b@example.com"],
		});
		const printed = JSON.parse(result.stdout) as {
			data: { id: string };
			meta: { idempotencyKey: string; status: number };
		};
		expect(printed.data.id).toBe("sent_1");
		expect(printed.meta).toMatchObject({
			idempotencyKey: "cli-send-0001",
			status: 201,
		});
	});

	test("send reads --html-file", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const result = await run(
			[
				"mail",
				"send",
				"--from",
				"inbox_1",
				"--to",
				"a@example.com",
				"--subject",
				"Hi",
				"--html-file",
				"./welcome.html",
			],
			{
				env: HOSTED_ENV,
				fetch,
				readFile: (path) =>
					path === "./welcome.html"
						? Promise.resolve("<p>Welcome</p>")
						: Promise.reject(new Error(`no file ${path}`)),
			}
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
			html: "<p>Welcome</p>",
		});
	});

	test("send --html-file --json keeps the send call's meta", async () => {
		const { fetch } = stubFetch(mailServer());
		const result = await run(
			[
				"mail",
				"send",
				"--from",
				"inbox_1",
				"--to",
				"a@example.com",
				"--subject",
				"Hi",
				"--html-file",
				"./welcome.html",
				"--idempotency-key",
				"mail-html-0001",
				"--json",
			],
			{
				env: HOSTED_ENV,
				fetch,
				readFile: () => Promise.resolve("<p>Welcome</p>"),
			}
		);
		expect(result.code).toBe(0);
		const printed = JSON.parse(result.stdout) as {
			meta: { idempotencyKey: string | null; status: number };
		};
		expect(printed.meta.status).toBe(201);
		expect(printed.meta.idempotencyKey).toBe("mail-html-0001");
	});

	test("send usage errors exit 2 without a request", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const neither = await run(
			[
				"mail",
				"send",
				"--from",
				"inbox_1",
				"--to",
				"a@example.com",
				"--subject",
				"Hi",
			],
			{ env: HOSTED_ENV, fetch }
		);
		expect(neither.code).toBe(2);
		expect(neither.stderr).toContain("--text or --html-file");
		const noTo = await run(
			["mail", "send", "--from", "inbox_1", "--subject", "Hi", "--text", "x"],
			{ env: HOSTED_ENV, fetch }
		);
		expect(noTo.code).toBe(2);
		const noInbox = await run(["mail", "messages", "list"], {
			env: HOSTED_ENV,
			fetch,
		});
		expect(noInbox.code).toBe(2);
		expect(calls).toHaveLength(0);
	});

	test("an API error exits 1 with its code", async () => {
		const fetch: RyuFetch = async () =>
			Response.json(
				{ error: "unauthorized" },
				{ status: 401, headers: { "x-request-id": "req_mail_1" } }
			);
		const result = await run(["mail", "inboxes", "list", "--json"], {
			env: SELF_HOSTED_ENV,
			fetch,
		});
		expect(result.code).toBe(1);
		const printed = JSON.parse(result.stdout || result.stderr) as {
			error: { code: string; requestId: string };
		};
		expect(printed.error.code).toBe("unauthenticated");
		expect(printed.error.requestId).toBe("req_mail_1");
	});

	test("--dry-run prints curl with the gateway-key placeholder and sends nothing", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const result = await run(
			[
				"mail",
				"send",
				"--from",
				"inbox_1",
				"--to",
				"a@example.com",
				"--subject",
				"Hi",
				"--text",
				"Hello",
				"--dry-run",
			],
			{ env: HOSTED_ENV, fetch }
		);
		expect(result.code).toBe(0);
		expect(calls).toHaveLength(0);
		expect(result.stdout).toContain("curl");
		expect(result.stdout).toContain(
			"https://api.ryuhq.com/api/mail/inboxes/inbox_1/send"
		);
		expect(result.stdout).toContain("$RYU_MAIL_GATEWAY_KEY");
		expect(result.stdout).toContain("x-gateway-key");
		expect(result.stdout).not.toContain("rgw_cli_mail_secret");
	});
});

describe("ryu-services mail inboxes create on hosted Mail", () => {
	test("--local-part is sent and no --address is needed", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const result = await run(
			[
				"mail",
				"inboxes",
				"create",
				"--name",
				"Support",
				"--local-part",
				"support",
				"--json",
			],
			{ env: HOSTED_ENV, fetch }
		);
		expect(result.code).toBe(0);
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			localPart: "support",
			name: "Support",
		});
		expect(result.stderr).toBe("");
	});

	test("--address is not sent, with a note that hosted Mail ignores it", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const result = await run(
			[
				"mail",
				"inboxes",
				"create",
				"--name",
				"Agent",
				"--address",
				"agent@acme.example",
			],
			{ env: HOSTED_ENV, fetch }
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ name: "Agent" });
		expect(result.stderr).toContain(
			"note: hosted Mail ignores --address; the address comes from --name on the default domain."
		);
	});
});

describe("ryu-services mail: first send on a self-hosted server", () => {
	test("inboxes create posts the name and address with the self-hosted bearer", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const result = await run(
			[
				"mail",
				"inboxes",
				"create",
				"--name",
				"Agent",
				"--address",
				"agent@acme.example",
				"--json",
			],
			{ env: SELF_HOSTED_ENV, fetch }
		);
		expect(result.code).toBe(0);
		expect(
			(JSON.parse(result.stdout) as { data: { id: string } }).data.id
		).toBe("inbox_1");
		expect(calls).toHaveLength(1);
		expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(
			"POST http://127.0.0.1:7996/api/mail/inboxes"
		);
		expect(calls[0]?.headers.get("authorization")).toBe(
			"Bearer self-hosted-cli-secret"
		);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			address: "agent@acme.example",
			name: "Agent",
		});
	});

	test("inboxes create without --address is a usage error that points at its help", async () => {
		const result = await run(["mail", "inboxes", "create", "--name", "A"], {
			env: SELF_HOSTED_ENV,
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain(
			"Self-hosted Mail needs --address, the inbox's full email address."
		);
		expect(result.stderr).toContain(
			`Run ${workspaceProgram()} mail inboxes create --help for usage.`
		);
	});

	test("inboxes create --local-part is refused on self-hosted Mail", async () => {
		const result = await run(
			[
				"mail",
				"inboxes",
				"create",
				"--name",
				"A",
				"--address",
				"a@acme.example",
				"--local-part",
				"a",
			],
			{ env: SELF_HOSTED_ENV }
		);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain(
			"--local-part is a hosted Mail option; self-hosted Mail takes the full --address."
		);
	});

	test("a send without an outbound transport prints the SMTP hint and docs", async () => {
		const { fetch } = stubFetch(() =>
			Response.json(
				{ error: "email transport is not configured" },
				{ status: 400 }
			)
		);
		const argv = [
			"mail",
			"send",
			"--from",
			"inbox_1",
			"--to",
			"a@example.com",
			"--subject",
			"Hi",
			"--text",
			"Hello",
		];
		const human = await run(argv, { env: SELF_HOSTED_ENV, fetch });
		expect(human.code).toBe(1);
		// The hint prints once, on its own line, not again after the message.
		expect(human.stderr).toContain(
			"error bad_request: email transport is not configured\n"
		);
		expect(human.stderr.split("The Mail server has no outbound")).toHaveLength(
			2
		);
		expect(human.stderr).toContain("hint: The Mail server has no outbound");
		expect(human.stderr).toContain("RYU_SMTP_HOST");
		expect(human.stderr).toContain("sendConfigured: true");
		expect(human.stderr).toContain(
			"docs: https://docs.ryuhq.com/docs/standalone/mail#start-the-standalone-service"
		);
		const json = await run([...argv, "--json"], {
			env: SELF_HOSTED_ENV,
			fetch,
		});
		const printed = JSON.parse(json.stdout) as {
			error: { code: string; docs: string; hint: string; message: string };
		};
		expect(printed.error.code).toBe("bad_request");
		expect(printed.error.hint).toContain("RYU_SMTP_HOST");
		expect(printed.error.message).toBe(
			`email transport is not configured. Hint: ${printed.error.hint}`
		);
		expect(printed.error.docs).toContain("#start-the-standalone-service");
	});

	test("send --help marks the required flags and shows its effect, an example and the docs", async () => {
		const result = await run(["mail", "send", "--help"], {
			env: SELF_HOSTED_ENV,
		});
		expect(result.code).toBe(0);
		const line = (flag: string) =>
			result.stdout.split("\n").find((row) => row.includes(`--${flag} <`));
		for (const flag of ["from", "to", "subject"]) {
			expect({ flag, line: line(flag) }).toEqual({
				flag,
				line: expect.stringContaining("(required)"),
			});
		}
		for (const flag of ["cc", "text", "html-file"]) {
			expect(line(flag)).not.toContain("(required)");
		}
		expect(result.stdout).toContain("Effect: Sends real email");
		expect(result.stdout).toContain(
			"Example:\n  ryu-services mail send --from"
		);
		expect(result.stdout).toContain(
			"Docs: https://docs.ryuhq.com/docs/standalone/sdk/mail"
		);
	});
});

async function connectMcp(
	env: Record<string, string>,
	fetch: RyuFetch,
	readOnly = false
) {
	const { server, registration } = createServicesMcpServer({
		config: { env, fetch },
		log: () => undefined,
		services: ["mail"],
		readOnly,
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "mail-test", version: "1.0.0" });
	await client.connect(clientTransport);
	return { client, registration };
}

describe("mail MCP tools", () => {
	test("registers the design §9 tools and mail_status with honest annotations", async () => {
		const { fetch } = stubFetch(mailServer());
		const { client, registration } = await connectMcp(HOSTED_ENV, fetch);
		try {
			expect(registration.tools).toEqual([
				"mail_status",
				"mail_list_inboxes",
				"mail_list_messages",
				"mail_get_message",
				"mail_create_inbox",
				"mail_send",
			]);
			const { tools } = await client.listTools();
			const send = tools.find((tool) => tool.name === "mail_send");
			expect(send?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			});
			const list = tools.find((tool) => tool.name === "mail_list_inboxes");
			expect(list?.annotations?.readOnlyHint).toBe(true);
			expect(list?.description).toContain("`mail_create_inbox`");
			const create = tools.find((tool) => tool.name === "mail_create_inbox");
			expect(create?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});
			expect(create?.inputSchema.required).toEqual(["name", "clientId"]);
			expect(create?.outputSchema).toBeDefined();
		} finally {
			await client.close();
		}
	});

	test("read-only mode leaves out mail_create_inbox and mail_send", async () => {
		const { fetch } = stubFetch(mailServer());
		const { client, registration } = await connectMcp(HOSTED_ENV, fetch, true);
		try {
			expect(registration.tools).toEqual([
				"mail_status",
				"mail_list_inboxes",
				"mail_list_messages",
				"mail_get_message",
			]);
		} finally {
			await client.close();
		}
	});

	test("no Mail env registers only the credential-free mail_status", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const { client, registration } = await connectMcp({}, fetch);
		try {
			expect(registration.tools).toEqual(["mail_status"]);
			expect(registration.services).toEqual([]);
			expect(registration.skipped.map((entry) => entry.service)).toEqual([
				"mail",
			]);
			const status = await client.callTool({
				name: "mail_status",
				arguments: {},
			});
			expect(status.isError).toBeFalsy();
			expect(calls[0]?.url).toBe("https://api.ryuhq.com/api/mail/status");
			expect(calls[0]?.headers.has("authorization")).toBe(false);
			expect(calls[0]?.headers.has("x-api-key")).toBe(false);
			expect(calls[0]?.headers.has("x-gateway-key")).toBe(false);
		} finally {
			await client.close();
		}
	});

	test("a self-hosted URL without its token registers no Mail tools", async () => {
		const { fetch } = stubFetch(mailServer());
		const { client, registration } = await connectMcp(
			{ RYU_MAIL_URL: SELF_HOSTED_ENV.RYU_MAIL_URL },
			fetch
		);
		try {
			expect(registration.tools).toEqual([]);
			expect(registration.credentialFree).toEqual([]);
		} finally {
			await client.close();
		}
	});

	test("tools answer { data, meta } and pass the idempotency key", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const { client } = await connectMcp(HOSTED_ENV, fetch);
		try {
			const listed = await client.callTool({
				name: "mail_list_messages",
				arguments: { inboxId: "inbox_1", limit: 5 },
			});
			expect(listed.isError).toBeFalsy();
			const listedData = (
				listed.structuredContent as { data: { id: string }[] }
			).data;
			expect(listedData.map((item) => item.id)).toEqual(["m2"]);
			expect(new URL(calls[0]?.url ?? "").searchParams.get("limit")).toBe("5");

			const got = await client.callTool({
				name: "mail_get_message",
				arguments: { messageId: "m1" },
			});
			expect((got.structuredContent as { data: { id: string } }).data.id).toBe(
				"m1"
			);

			const sent = await client.callTool({
				name: "mail_send",
				arguments: {
					from: "inbox_1",
					to: ["a@example.com"],
					subject: "Hi",
					text: "Hello",
					idempotencyKey: "mcp-send-0001",
				},
			});
			expect(sent.isError).toBeFalsy();
			const structured = sent.structuredContent as {
				data: { id: string };
				meta: { idempotencyKey: string };
			};
			expect(structured.data.id).toBe("sent_1");
			expect(structured.meta.idempotencyKey).toBe("mcp-send-0001");
			const post = calls.find((call) => call.method === "POST");
			expect(post?.headers.get("idempotency-key")).toBe("mcp-send-0001");
		} finally {
			await client.close();
		}
	});

	test("mail_create_inbox posts the inbox and refuses a create without a clientId", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const { client } = await connectMcp(HOSTED_ENV, fetch);
		try {
			const created = await client.callTool({
				name: "mail_create_inbox",
				arguments: {
					name: "Agent",
					clientId: "agent-inbox",
					localPart: "agent",
				},
			});
			expect(created.isError).toBeFalsy();
			expect(
				(created.structuredContent as { data: { id: string } }).data.id
			).toBe("inbox_1");
			const posts = calls.filter((call) => call.method === "POST");
			expect(posts.map((call) => new URL(call.url).pathname)).toEqual([
				"/api/mail/inboxes",
			]);
			expect(JSON.parse(posts[0]?.body ?? "{}")).toEqual({
				name: "Agent",
				clientId: "agent-inbox",
				localPart: "agent",
			});

			const refused = await client.callTool({
				name: "mail_create_inbox",
				arguments: { name: "Agent" },
			});
			expect(refused.isError).toBe(true);
			expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
		} finally {
			await client.close();
		}
	});

	test("mail_send refuses a missing or non-ASCII key and anything but exactly one body", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const { client } = await connectMcp(HOSTED_ENV, fetch);
		const base = {
			from: "inbox_1",
			to: ["a@example.com"],
			subject: "Hi",
		};
		const refused: Record<string, unknown>[] = [
			{ ...base, text: "Hello" },
			{ ...base, text: "Hello", idempotencyKey: "cl\u00e9-1" },
			{ ...base, text: "Hello", idempotencyKey: "   " },
			{ ...base, text: "Hello", idempotencyKey: "k".repeat(256) },
			{ ...base, idempotencyKey: "mcp-send-0002" },
			{ ...base, text: "Hello", html: "<p>Hello</p>", idempotencyKey: "k-3" },
		];
		try {
			for (const args of refused) {
				const result = await client.callTool({
					name: "mail_send",
					arguments: args,
				});
				expect({ args, isError: result.isError }).toEqual({
					args,
					isError: true,
				});
			}
			expect(calls).toHaveLength(0);
		} finally {
			await client.close();
		}
	});

	test("ids that would address another route are refused before any request", async () => {
		const { calls, fetch } = stubFetch(mailServer());
		const { client } = await connectMcp(HOSTED_ENV, fetch);
		try {
			const attempts: { name: string; arguments: Record<string, unknown> }[] = [
				{ name: "mail_get_message", arguments: { messageId: "../webhooks" } },
				{ name: "mail_get_message", arguments: { messageId: "m1?x=1" } },
				{
					name: "mail_list_messages",
					arguments: { inboxId: "inbox_1/threads" },
				},
				{
					name: "mail_send",
					arguments: {
						from: "inbox_1/messages/msg_9/forward?",
						to: ["attacker@example.com"],
						subject: "Fwd",
						text: "x",
						idempotencyKey: "k-4",
					},
				},
			];
			for (const attempt of attempts) {
				const result = await client.callTool(attempt);
				expect({ attempt, isError: result.isError }).toEqual({
					attempt,
					isError: true,
				});
			}
			expect(calls).toHaveLength(0);
		} finally {
			await client.close();
		}
	});

	test("an API failure is isError with the RyuError code", async () => {
		const fetch: RyuFetch = async () =>
			Response.json(
				{ error: "invalid gateway key" },
				{ status: 401, headers: { "content-type": "application/json" } }
			);
		const { client } = await connectMcp(HOSTED_ENV, fetch);
		try {
			const result = await client.callTool({
				name: "mail_list_inboxes",
				arguments: {},
			});
			expect(result.isError).toBe(true);
			const error = (
				result.structuredContent as {
					error: { code: string; service: string };
				}
			).error;
			expect(error).toMatchObject({ code: "unauthenticated", service: "mail" });
			expect(JSON.stringify(result)).not.toContain("rgw_cli_mail_secret");
		} finally {
			await client.close();
		}
	});
});

import { describe, expect, test } from "bun:test";
import type { RyuFetch } from "@ryuhq/services";
import { type CliIo, runCli } from "../cli.ts";
import { configurationProblemOf } from "../commands/doctor.ts";
import { cliHintText } from "../hints.ts";

function capture(env: Record<string, string>, fetch?: RyuFetch) {
	let out = "";
	let err = "";
	const io: CliIo = {
		env,
		stdin: "",
		stdout: { write: (chunk: string) => (out += chunk) },
		stderr: { write: (chunk: string) => (err += chunk) },
		...(fetch === undefined ? {} : { fetch }),
	};
	return { io, stdout: () => out, stderr: () => err };
}

describe("SDK hints in CLI words", () => {
	test("constructor options become the CLI's --api-key / --base-url flags", () => {
		expect(
			cliHintText(
				"notify",
				"Set RYU_NOTIFY_API_KEY (or pass notify.apiKey to new Ryu()). See https://docs.ryuhq.com/docs/standalone/sdk/notify."
			)
		).toBe(
			"Set RYU_NOTIFY_API_KEY (or pass --api-key). See https://docs.ryuhq.com/docs/standalone/sdk/notify."
		);
		expect(
			cliHintText(
				"sites",
				"Set RYU_SITES_URL and RYU_SITES_API_KEY (or pass sites.baseUrl and sites.apiKey to new Ryu())."
			)
		).toBe(
			"Set RYU_SITES_URL and RYU_SITES_API_KEY (or pass --base-url and --api-key)."
		);
		expect(
			cliHintText(
				"box",
				"Ryu Box did not accept the credentials. Check RYU_BOX_API_KEY (or box.apiKey)."
			)
		).toBe(
			"Ryu Box did not accept the credentials. Check RYU_BOX_API_KEY (or pass --api-key)."
		);
		expect(
			cliHintText(
				"managedAgents",
				"Ryu Managed Agents needs a ryu_ key: set RYU_API_KEY or pass apiKey."
			)
		).toBe(
			"Ryu Managed Agents needs a ryu_ key: set RYU_API_KEY or pass --api-key."
		);
	});

	test("options with no flag are dropped, partial lists say what the flag covers", () => {
		expect(
			cliHintText(
				"passport",
				"Ryu Passport runtime routes need a runtime grant token: set RYU_PASSPORT_RUNTIME_KEY or pass passport.runtimeKey. The administration key is not accepted there."
			)
		).toBe(
			"Ryu Passport runtime routes need a runtime grant token: set RYU_PASSPORT_RUNTIME_KEY. The administration key is not accepted there."
		);
		expect(
			cliHintText(
				"messaging",
				"Set RYU_API_KEY and RYU_ORGANIZATION_ID (or pass apiKey and organizationId to new Ryu())."
			)
		).toBe(
			"Set RYU_API_KEY and RYU_ORGANIZATION_ID (--api-key can stand in for the key)."
		);
		// For Mail, --api-key fills the gateway or self-hosted key, never the ryu_ key.
		expect(
			cliHintText(
				"mail",
				"Set RYU_API_KEY (or pass apiKey) to a ryu_ key, or RYU_MAIL_GATEWAY_KEY (or mail.gatewayKey) for a node gateway key."
			)
		).toBe(
			"Set RYU_API_KEY to a ryu_ key, or RYU_MAIL_GATEWAY_KEY (or pass --api-key) for a node gateway key."
		);
	});

	test("other parentheticals and pass phrases stay as they are", () => {
		const hint =
			"This command needs RYU_PASSPORT_API_KEY (the tenant administration token). Create the inbox first, or pass its id as `from`.";
		expect(cliHintText("passport", hint)).toBe(hint);
	});

	test("a missing Notify key names --api-key, not new Ryu()", async () => {
		const run = capture({ RYU_NOTIFY_URL: "https://notify.example.com" });
		expect(
			await runCli(["notify", "publish", "--title", "x"], run.io)
		).not.toBe(0);
		expect(run.stderr()).toContain("RYU_NOTIFY_API_KEY");
		expect(run.stderr()).toContain("--api-key");
		expect(run.stderr()).not.toContain("new Ryu()");
		expect(run.stderr()).not.toContain("notify.apiKey");
		const json = capture({ RYU_NOTIFY_URL: "https://notify.example.com" });
		await runCli(["notify", "publish", "--title", "x", "--json"], json.io);
		const printed = JSON.parse(json.stdout()) as {
			error: { hint: string; message: string };
		};
		expect(printed.error.hint).toContain("--api-key");
		expect(printed.error.message).not.toContain("new Ryu()");
		expect(printed.error.message.split("Hint:")).toHaveLength(2);
	});

	test("a rejected Box key names --api-key, not box.apiKey", async () => {
		const fetch: RyuFetch = async () =>
			new Response(JSON.stringify({ error: "unauthorized" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		const run = capture(
			{ RYU_BOX_URL: "https://box.example.com", RYU_BOX_API_KEY: "wrong" },
			fetch
		);
		expect(await runCli(["box", "list"], run.io)).toBe(1);
		const hint =
			run
				.stderr()
				.split("\n")
				.find((line) => line.includes("hint:")) ?? "";
		expect(hint).toContain("RYU_BOX_API_KEY");
		expect(hint).toContain("--api-key");
		expect(hint).not.toContain("box.apiKey");
		expect(run.stderr()).not.toContain("wrong");
	});

	test("doctor's configuration problem hint uses CLI words", () => {
		const problem = configurationProblemOf({
			code: "configuration_error",
			details: null,
			hint: "Set RYU_NOTIFY_API_KEY (or pass notify.apiKey to new Ryu()).",
			message: "Ryu Notify is not configured.",
			service: "notify",
		});
		expect(problem.hint).toBe(
			"Set RYU_NOTIFY_API_KEY (or pass --api-key to a `ryu-services notify` command)."
		);
	});

	test("doctor's problem message names the service command, since doctor rejects --api-key", () => {
		const problem = configurationProblemOf({
			code: "configuration_error",
			details: { missing: ["RYU_API_KEY"] },
			hint: null,
			message:
				"Ryu Managed Agents needs a ryu_ key: set RYU_API_KEY or pass apiKey.",
			service: "managedAgents",
		});
		expect(problem.message).toBe(
			"Ryu Managed Agents needs a ryu_ key: set RYU_API_KEY or pass --api-key to a `ryu-services managed-agents` command."
		);
	});

	test("the SDK's timeoutMs option becomes --timeout", () => {
		expect(
			cliHintText(
				"box",
				"Ryu Box at https://box.example.com did not respond in time (raise timeoutMs if the call is slow). Check RYU_BOX_URL."
			)
		).toBe(
			"Ryu Box at https://box.example.com did not respond in time (raise --timeout if the call is slow). Check RYU_BOX_URL."
		);
	});

	test("configuration error messages use CLI words in human and --json output", async () => {
		const human = capture({});
		expect(
			await runCli(["managed-agents", "agents", "list"], human.io)
		).not.toBe(0);
		const errorLine =
			human
				.stderr()
				.split("\n")
				.find((line) => line.startsWith("error ")) ?? "";
		expect(errorLine).toContain("set RYU_API_KEY or pass --api-key.");
		expect(errorLine).not.toContain("pass apiKey");
		const json = capture({});
		await runCli(["managed-agents", "agents", "list", "--json"], json.io);
		const printed = JSON.parse(json.stdout()) as {
			error: { message: string };
		};
		expect(printed.error.message).toContain("or pass --api-key.");
		expect(printed.error.message).not.toContain("pass apiKey");
	});

	test("self-hosted Mail and Passport messages drop SDK options", () => {
		expect(
			cliHintText(
				"mail",
				"Self-hosted Ryu Mail needs its bearer token: set RYU_MAIL_API_KEY (or mail.apiKey). The ryu_ key is sent only to hosted Mail on the control-plane origin."
			)
		).toBe(
			"Self-hosted Ryu Mail needs its bearer token: set RYU_MAIL_API_KEY (or pass --api-key). The ryu_ key is sent only to hosted Mail on the control-plane origin."
		);
		expect(
			cliHintText(
				"passport",
				"Ryu Passport runtime routes need a runtime grant token: set RYU_PASSPORT_RUNTIME_KEY or pass passport.runtimeKey. The administration key is not accepted there."
			)
		).toBe(
			"Ryu Passport runtime routes need a runtime grant token: set RYU_PASSPORT_RUNTIME_KEY. The administration key is not accepted there."
		);
	});
});

// `ryu secrets agent` rendering: template loading checks, one export per
// environment and folder, and change-gated commands.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../cli/secrets-agentd-config.ts";
import {
	fetchValues,
	loadTemplates,
	renderAll,
} from "../cli/secrets-agentd-render.ts";
import { fakeNode, jsonExport } from "./secrets-fixture.ts";

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ryu-agentd-render-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function config(templates: AgentConfig["templates"]): AgentConfig {
	return {
		auth: { kind: "env" },
		defaults: { environment: "prod" },
		leases: [{ name: "db", role: "r", ttlSecs: undefined }],
		renderIntervalMs: null,
		revokeLeasesOnExit: true,
		sinks: [],
		templates,
	};
}

function template(source: string, command: string[] | null = null) {
	return {
		source: join(dir, source),
		destination: join(dir, `${source}.out`),
		mode: 0o600,
		command,
		commandTimeoutMs: 1000,
	};
}

test("loadTemplates refuses a lease placeholder for an unconfigured lease", async () => {
	await writeFile(join(dir, "a.tpl"), "{{lease:cache.password}}");
	await expect(loadTemplates(config([template("a.tpl")]))).rejects.toThrow(
		"names no configured lease"
	);
});

test("fetchValues makes one export per environment and folder", async () => {
	await writeFile(
		join(dir, "a.tpl"),
		"{{secret:A}} {{secret:B}} {{secret:dev:/x/A}}"
	);
	const node = fakeNode({
		"POST /api/vault/agent/export": (call) => {
			const body = JSON.parse(call.body);
			return Response.json(
				jsonExport(
					body.environment === "dev" ? { A: "dev-a" } : { A: "a", B: "b" }
				)
			);
		},
	});
	const agent = {
		url: node.target.url,
		fetch: node.target.fetch,
		vaultToken: "rvt_1",
	};
	const cfg = config([template("a.tpl")]);
	const values = await fetchValues(
		agent,
		await loadTemplates(cfg),
		cfg.defaults
	);
	expect([...values.values()].sort()).toEqual(["a", "b", "dev-a"]);
	expect(node.calls.map((call) => JSON.parse(call.body))).toEqual([
		{ format: "json", path: "/", names: ["A", "B"], environment: "prod" },
		{ format: "json", path: "/x", names: ["A"], environment: "dev" },
	]);
});

describe("renderAll", () => {
	test("writes changed files, runs their command once, and skips failures", async () => {
		await writeFile(join(dir, "ok.tpl"), "A={{secret:A}}");
		await writeFile(join(dir, "bad.tpl"), "MISSING={{secret:NOPE}}");
		await writeFile(join(dir, "bad.tpl.out"), "previous");
		const node = fakeNode({
			"POST /api/vault/agent/export": () =>
				Response.json(jsonExport({ A: "a" })),
		});
		const agent = {
			url: node.target.url,
			fetch: node.target.fetch,
			vaultToken: "rvt_1",
		};
		const commands: string[][] = [];
		let err = "";
		const ctx = {
			env: { RYU_VAULT_TOKEN: "rvt_1", PATH: "/bin" },
			io: {
				out: () => undefined,
				err: (text: string) => {
					err += text;
				},
			},
			spawn: (cmd: string[]) => {
				commands.push(cmd);
				return Promise.resolve(0);
			},
			target: node.target,
		};
		const cfg = config([
			template("ok.tpl", ["reload"]),
			template("bad.tpl", ["never"]),
		]);
		const templates = await loadTemplates(cfg);
		const first = await renderAll(ctx, agent, cfg, templates, new Map());
		expect(first).toEqual({
			changed: [join(dir, "ok.tpl.out")],
			failed: [join(dir, "bad.tpl.out")],
		});
		expect(await readFile(join(dir, "ok.tpl.out"), "utf8")).toBe("A=a");
		expect(await readFile(join(dir, "bad.tpl.out"), "utf8")).toBe("previous");
		expect(err).toContain("no value for secret:NOPE");
		const second = await renderAll(ctx, agent, cfg, templates, new Map());
		expect(second.changed).toEqual([]);
		expect(commands).toEqual([["reload"]]);
	});
});

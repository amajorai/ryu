// `ryu-cli secrets import FILE --format doppler|envkey`: Doppler and EnvKey
// export files are parsed offline and sent to Core's json import. No live
// Doppler or EnvKey API is involved; Core is a fake `fetch`.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	foreignImportContent,
	isForeignImportFormat,
	parseForeignExport,
} from "../cli/secrets-import-sources.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

let dir: string | null = null;
afterEach(async () => {
	if (dir) {
		await rm(dir, { recursive: true, force: true });
		dir = null;
	}
});

async function exportFile(name: string, content: string): Promise<string> {
	dir = await mkdtemp(join(tmpdir(), "ryu-import-"));
	const file = join(dir, name);
	await writeFile(file, content);
	return file;
}

const IMPORTED = {
	ok: true,
	report: { created: 2, updated: 0, skipped: 0, unchanged: 0 },
};

test("a Doppler download drops Doppler's own metadata keys", () => {
	const download = JSON.stringify({
		API_KEY: 'k"1\nnext',
		DATABASE_URL: "postgres://u:p@h/db",
		DOPPLER_CONFIG: "dev",
		DOPPLER_ENVIRONMENT: "dev",
		DOPPLER_PROJECT: "web",
	});
	expect(parseForeignExport("doppler", download, "d.json")).toEqual({
		API_KEY: 'k"1\nnext',
		DATABASE_URL: "postgres://u:p@h/db",
	});
});

test("a Doppler listing imports the computed value", () => {
	const listing = JSON.stringify({
		BASE: { computed: "https://x", note: "", raw: "https://x" },
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal template sequence is the test input.
		URL: { computed: "https://x/api", note: "", raw: "${BASE}/api" },
		RAW_ONLY: { raw: "r" },
	});
	expect(parseForeignExport("doppler", listing, "d.json")).toEqual({
		BASE: "https://x",
		URL: "https://x/api",
		RAW_ONLY: "r",
	});
});

test("an EnvKey export is a flat object of text values", () => {
	expect(parseForeignExport("envkey", '{"A":"1","B":""}', "e.json")).toEqual({
		A: "1",
		B: "",
	});
	// EnvKey has no metadata keys; a DOPPLER_* name is an ordinary value here.
	expect(
		parseForeignExport("envkey", '{"DOPPLER_PROJECT":"x"}', "e.json")
	).toEqual({ DOPPLER_PROJECT: "x" });
});

test("bad files are refused naming keys, never values", () => {
	expect(() => parseForeignExport("envkey", "A=1", "e.env")).toThrow(
		"e.env is not a JSON object of names and values."
	);
	expect(() => parseForeignExport("doppler", "[]", "d.json")).toThrow(
		"d.json is not a JSON object"
	);
	let message = "";
	try {
		parseForeignExport(
			"envkey",
			JSON.stringify({ "bad-name": "hidden1", NUM: 5, OK: "fine" }),
			"e.json"
		);
	} catch (error) {
		message = String(error);
	}
	expect(message).toContain("bad-name, NUM");
	expect(message).not.toContain("hidden1");
	expect(isForeignImportFormat("doppler")).toBe(true);
	expect(isForeignImportFormat("dotenv")).toBe(false);
});

test("import --format doppler sends Core a json import", async () => {
	const file = await exportFile(
		"doppler.json",
		JSON.stringify({ API_KEY: "k", DOPPLER_PROJECT: "web", TOKEN: "t" })
	);
	const node = fakeNode({ "POST /api/vault/import": json(IMPORTED) });
	const result = await runSecrets(
		["import", file, "--no-project", "--format", "doppler", "--env", "dev"],
		node
	);
	expect(result.code).toBe(0);
	const body = JSON.parse(node.calls[0]?.body ?? "{}");
	expect(body.format).toBe("json");
	expect(body.environment).toBe("dev");
	expect(JSON.parse(body.content)).toEqual({ API_KEY: "k", TOKEN: "t" });
	expect(body.content).toBe(
		foreignImportContent(
			"doppler",
			JSON.stringify({ API_KEY: "k", TOKEN: "t" }),
			file
		)
	);
	expect(result.out).toContain("2 created");
});

test("import --format envkey refuses a bad file before calling Core", async () => {
	const file = await exportFile("envkey.json", '{"A": {"nested": true}}');
	const node = fakeNode({ "POST /api/vault/import": json(IMPORTED) });
	const result = await runSecrets(
		["import", file, "--no-project", "--format", "envkey"],
		node
	);
	expect(result.code).toBe(2);
	expect(result.err).toContain("these entries are not a variable name");
	expect(node.calls).toEqual([]);
});

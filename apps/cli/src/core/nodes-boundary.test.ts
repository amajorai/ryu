import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadNodes } from "./nodes.ts";

test("invalid durable node URLs and mesh records use the local fallback", () => {
	const directory = mkdtempSync(join(tmpdir(), "ryu-cli-node-boundary-"));
	const previousDirectory = process.env.RYU_CLI_CONFIG_DIR;
	process.env.RYU_CLI_CONFIG_DIR = directory;
	try {
		for (const node of [
			{ name: "broken", token: null },
			{ name: "broken", url: 42, token: null },
			{
				name: "broken",
				url: "https://node.example",
				token: null,
				mesh: { socks5: 42 },
			},
		]) {
			writeFileSync(
				join(directory, "nodes.json"),
				JSON.stringify({ default: "broken", nodes: [node] })
			);
			expect(loadNodes()).toEqual(defaultConfig());
		}
	} finally {
		if (previousDirectory === undefined) {
			delete process.env.RYU_CLI_CONFIG_DIR;
		} else {
			process.env.RYU_CLI_CONFIG_DIR = previousDirectory;
		}
		rmSync(directory, { recursive: true, force: true });
	}
});

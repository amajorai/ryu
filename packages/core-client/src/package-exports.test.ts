import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

test("Node package resolution admits the actual extension imports and keeps legacy bare subpaths equivalent", () => {
	// WXT/Rollup uses the package export map: a suffix added twice breaks the
	// production background bundle even when Bun's source loader accepts it.
	const imports = [
		"language-packs",
		"client",
		"user-jwt",
		"chat",
		"native-accounts",
		"agents",
		"quest-events",
		"quests",
		"events",
	];
	const scratch = mkdtempSync(join(tmpdir(), "ryu-node-resolver-"));
	const resultPath = join(scratch, "result.json");
	try {
		const child = Bun.spawnSync(
			[
				"node",
				"--input-type=module",
				"-e",
				`
 import { createRequire } from "node:module";
 const require = createRequire(new URL("./package.json", "file://" + process.cwd() + "/"));
 const modules = ${JSON.stringify(imports)};
 (await import("node:fs")).writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(modules.map(name => ({ name, bare: require.resolve("@ryuhq/core-client/" + name), explicit: require.resolve("@ryuhq/core-client/" + name + ".ts") }))));
 `,
			],
			{ cwd: fileURLToPath(new URL("..", import.meta.url)) }
		);
		expect(child.exitCode).toBe(0);
		const resolved = z
			.array(
				z.object({ name: z.string(), bare: z.string(), explicit: z.string() })
			)
			.parse(JSON.parse(readFileSync(resultPath, "utf8")));
		expect(resolved).toHaveLength(imports.length);
		for (const entry of resolved) {
			expect(entry.explicit).toBe(entry.bare);
			expect(entry.explicit).toBe(
				fileURLToPath(new URL(`./${entry.name}.ts`, import.meta.url))
			);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

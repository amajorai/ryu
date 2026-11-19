// The local-Core bootstrap reports each step as a whole catalog sentence, so a
// German CLI prints German progress and failure lines, not English fragments.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliTranslator } from "../i18n/translate.ts";

// Pin the CLI to a German stub catalog before bootstrap loads, the way
// LANG=de_DE.UTF-8 does at startup; the shipped catalog has no entries for
// these sentences yet.
const german = createCliTranslator("de", {
	"downloading {binary} ({asset})…": "{binary} wird heruntergeladen ({asset})…",
	"starting ryu-core on {bind}…": "ryu-core wird auf {bind} gestartet…",
	"could not start ryu-core: {error}":
		"ryu-core konnte nicht gestartet werden: {error}",
	"Could not download {url} (HTTP {status}), so ryu-cli is refusing to install an unverified binary.":
		"{url} konnte nicht heruntergeladen werden (HTTP {status}); ryu-cli installiert keine ungeprüfte Binärdatei.",
});
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	CLI_TRANSLATOR: german,
	createCliTranslator,
	tf: german.tf,
	tr: german.tr,
	trMessage: german.trMessage,
	translateProps: german.translateProps,
}));
const { downloadBinary, ensureCoreRunning } = await import(
	"../core/bootstrap.ts"
);
const { localizedTextOf, renderLocalized } = await import(
	"../cli/localizedText.ts"
);

const ENV_KEYS = [
	"RYU_CORE_BIN",
	"RYU_GATEWAY_BIN",
	"RYU_TUI_NO_BOOTSTRAP",
] as const;
const savedEnv = Object.fromEntries(
	ENV_KEYS.map((key) => [key, process.env[key]])
);
const directories: string[] = [];

afterEach(async () => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	);
});

async function tempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ryu-cli-bootstrap-de-"));
	directories.push(directory);
	return directory;
}

/** A loopback port nothing listens on, so the Core probe reports "down". */
function closedLoopbackPort(): number {
	const server = Bun.serve({
		fetch: () => new Response(null),
		hostname: "127.0.0.1",
		port: 0,
	});
	const port = server.port ?? 0;
	server.stop(true);
	return port;
}

describe("bootstrap progress under a German translator", () => {
	test("the download line is one German sentence", async () => {
		const lines: string[] = [];
		const missing: typeof fetch = Object.assign(
			() => Promise.resolve(new Response("", { status: 404 })),
			{ preconnect: fetch.preconnect }
		);
		await expect(
			downloadBinary("core", {
				arch: "x64",
				binDir: await tempDir(),
				fetcher: missing,
				platform: "linux",
				report: (line) => lines.push(line),
			})
		).rejects.toThrow("HTTP 404");
		const failure = await downloadBinary("core", {
			arch: "x64",
			binDir: await tempDir(),
			fetcher: missing,
			platform: "linux",
			report: () => undefined,
		}).catch((error: unknown) => error);
		const localized =
			failure instanceof Error ? localizedTextOf(failure) : null;
		expect(localized && renderLocalized(localized)).toBe(
			"https://github.com/amajorai/ryu/releases/latest/download/ryu-core-linux-x86_64.sha256 konnte nicht heruntergeladen werden (HTTP 404); ryu-cli installiert keine ungeprüfte Binärdatei."
		);
		// The local file name follows the host (`binName`), the asset the target.
		const localName =
			process.platform === "win32" ? "ryu-core.exe" : "ryu-core";
		expect(lines).toEqual([
			`${localName} wird heruntergeladen (ryu-core-linux-x86_64)…`,
		]);
	});

	test("starting and a failed start report in German", async () => {
		// A directory exists, so it resolves as the binary, but cannot be spawned.
		const notExecutable = await tempDir();
		process.env.RYU_CORE_BIN = notExecutable;
		process.env.RYU_GATEWAY_BIN = notExecutable;
		delete process.env.RYU_TUI_NO_BOOTSTRAP;
		const bind = `127.0.0.1:${closedLoopbackPort()}`;
		const lines: string[] = [];
		await ensureCoreRunning(
			{ token: null, url: `http://${bind}` },
			{ onProgress: (line) => lines.push(line) }
		);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(`ryu-core wird auf ${bind} gestartet…`);
		expect(lines[1]).toStartWith("ryu-core konnte nicht gestartet werden: ");
		expect(lines.join("\n")).not.toContain("could not");
		expect(lines.join("\n")).not.toContain("starting");
	});
});

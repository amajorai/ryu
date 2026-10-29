import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "explicit-remote-token-0123456789";

/**
 * Run one scenario in its own Bun process: `config.ts` caches the config at
 * module scope, and electron is replaced by a double whose `safeStorage` (when
 * `sealing` is on) reverses and base64-encodes, standing in for the OS keychain.
 */
async function runScenario(
	root: string,
	sealing: boolean,
	body: string,
	env: Record<string, string> = {}
): Promise<unknown> {
	const runner = join(root, `run-${crypto.randomUUID()}.ts`);
	const safeStorage = sealing
		? `safeStorage:{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>"gnome_libsecret",
			encryptString:(v)=>Buffer.from("os:"+[...v].reverse().join("")),
			decryptString:(b)=>{const t=b.toString();if(!t.startsWith("os:"))throw new Error("bad");return [...t.slice(3)].reverse().join("");}},`
		: "";
	await writeFile(
		runner,
		`
import {mock} from "bun:test";
mock.module(${JSON.stringify(Bun.resolveSync("electron", import.meta.dirname))},()=>({${safeStorage}app:{getPath:()=>${JSON.stringify(root)}}}));
const config=await import(${JSON.stringify(join(import.meta.dirname, "config.ts"))});
const result=await (async()=>{${body}})();
console.log(JSON.stringify(result));
`
	);
	const child = Bun.spawn(["bun", runner], {
		env: { ...process.env, RYU_TOKEN: "", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) {
		throw new Error(err);
	}
	return JSON.parse(out.trim().split("\n").at(-1) ?? "null");
}

test("an explicit token is persisted only sealed, redacted to the renderer, and kept on a placeholder patch", async () => {
	const root = await mkdtemp(join(tmpdir(), "island-token-"));
	try {
		const result = await runScenario(
			root,
			true,
			`config.saveSettings({coreBaseUrl:"https://remote.example",coreToken:${JSON.stringify(SECRET)}});
			 const settings=config.getSettings();
			 config.saveSettings({coreToken:"••••••"});
			 return {settings,auth:config.coreHeaders().Authorization};`
		);
		expect(result).toEqual({
			settings: expect.objectContaining({ coreToken: "••••••" }),
			auth: `Bearer ${SECRET}`,
		});
		const file = join(root, "island-services.json");
		const raw = await Bun.file(file).text();
		expect(raw).not.toContain(SECRET);
		expect(JSON.parse(raw)).toHaveProperty("coreTokenSealed");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		// A fresh process opens the sealed token.
		expect(
			await runScenario(
				root,
				true,
				"return config.coreHeaders().Authorization;"
			)
		).toBe(`Bearer ${SECRET}`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a plaintext token from an older build is resealed; an inherited RYU_TOKEN copy is dropped", async () => {
	const root = await mkdtemp(join(tmpdir(), "island-token-legacy-"));
	const file = join(root, "island-services.json");
	try {
		await writeFile(
			file,
			JSON.stringify({
				coreBaseUrl: "https://remote.example",
				coreToken: SECRET,
			})
		);
		expect(
			await runScenario(
				root,
				true,
				"return config.coreHeaders().Authorization;"
			)
		).toBe(`Bearer ${SECRET}`);
		expect(await Bun.file(file).text()).not.toContain(SECRET);

		await writeFile(
			file,
			JSON.stringify({
				coreBaseUrl: "https://remote.example",
				coreToken: "env-copy",
			})
		);
		expect(
			await runScenario(
				root,
				true,
				"return {auth:config.coreHeaders().Authorization,settings:config.getSettings().coreToken};",
				{ RYU_TOKEN: "env-copy" }
			)
		).toEqual({ auth: "Bearer env-copy", settings: null });
		const rewritten = JSON.parse(await Bun.file(file).text());
		expect(rewritten).not.toHaveProperty("coreToken");
		expect(rewritten).not.toHaveProperty("coreTokenSealed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("without an OS-backed safeStorage the explicit token stays in memory only", async () => {
	const root = await mkdtemp(join(tmpdir(), "island-token-nosealing-"));
	try {
		expect(
			await runScenario(
				root,
				false,
				`config.saveSettings({coreBaseUrl:"https://remote.example",coreToken:${JSON.stringify(SECRET)}});
				 return config.coreHeaders().Authorization;`
			)
		).toBe(`Bearer ${SECRET}`);
		const raw = await Bun.file(join(root, "island-services.json")).text();
		expect(raw).not.toContain(SECRET);
		expect(JSON.parse(raw)).not.toHaveProperty("coreTokenSealed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a settings save keeps the sealed token on disk when safeStorage cannot open it", async () => {
	const root = await mkdtemp(join(tmpdir(), "island-token-keep-"));
	const file = join(root, "island-services.json");
	try {
		await runScenario(
			root,
			true,
			`config.saveSettings({coreBaseUrl:"https://remote.example",coreToken:${JSON.stringify(SECRET)}});
			 return true;`
		);
		const sealed = JSON.parse(await Bun.file(file).text()).coreTokenSealed;
		expect(typeof sealed).toBe("string");

		// No usable keyring: the token stays sealed on disk across an unrelated save.
		await runScenario(
			root,
			false,
			"config.saveSettings({engine:{pollIntervalSeconds:30}}); return true;"
		);
		expect(JSON.parse(await Bun.file(file).text()).coreTokenSealed).toBe(
			sealed
		);

		// A failed decrypt behaves the same: the sealed value is not discarded.
		await writeFile(
			file,
			JSON.stringify({
				coreBaseUrl: "https://remote.example",
				coreTokenSealed: "bm90LWEtdmFsaWQtc2VhbA==",
			})
		);
		await runScenario(
			root,
			true,
			"config.saveSettings({engine:{cooldownSeconds:60}}); return true;"
		);
		expect(JSON.parse(await Bun.file(file).text()).coreTokenSealed).toBe(
			"bm90LWEtdmFsaWQtc2VhbA=="
		);

		// An explicit clear still removes it.
		await runScenario(
			root,
			true,
			'config.saveSettings({coreToken:""}); return true;'
		);
		expect(JSON.parse(await Bun.file(file).text())).not.toHaveProperty(
			"coreTokenSealed"
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

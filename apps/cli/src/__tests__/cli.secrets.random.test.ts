// `ryu-cli secrets set NAME --random` - a locally generated value of Core's
// alphabets, recorded generator metadata, and nothing printed.

import { expect, test } from "bun:test";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import {
	RANDOM_ALPHABETS,
	RANDOM_DEFAULT_LENGTH,
	randomGeneratorFrom,
	randomValue,
} from "../cli/secrets-random.ts";
import { fakeNode, runSecrets, secretRow } from "./secrets-fixture.ts";

function putNode() {
	return fakeNode({
		"PUT /api/vault/secrets/DB_PASSWORD": () =>
			Response.json({ ok: true, secret: secretRow("DB_PASSWORD", []) }),
	});
}

test("random values use only the charset's alphabet, at the requested length", () => {
	for (const charset of [
		"alphanumeric",
		"hex",
		"base64url",
		"symbols",
	] as const) {
		const value = randomValue(200, charset);
		expect(value).toHaveLength(200);
		const alphabet = new Set(RANDOM_ALPHABETS[charset]);
		expect([...value].every((char) => alphabet.has(char))).toBe(true);
	}
	expect(RANDOM_ALPHABETS.hex).toBe("0123456789abcdef");
	expect(
		new Set(Array.from({ length: 20 }, () => randomValue(32, "hex"))).size
	).toBe(20);
});

test("--random parses length and charset and rejects out-of-range input", () => {
	expect(
		randomGeneratorFrom(parseSecretsArgs(["set", "X", "--random"]))
	).toEqual({
		kind: "random",
		length: RANDOM_DEFAULT_LENGTH,
		charset: "alphanumeric",
	});
	expect(
		randomGeneratorFrom(
			parseSecretsArgs([
				"set",
				"X",
				"--random",
				"--length=64",
				"--charset",
				"alnum",
			])
		)
	).toEqual({ kind: "random", length: 64, charset: "alphanumeric" });
	expect(randomGeneratorFrom(parseSecretsArgs(["set", "X"]))).toBeUndefined();
	for (const bad of [
		["--random", "--length", "7"],
		["--random", "--length", "257"],
		["--random", "--length", "1.5"],
		["--random", "--charset", "emoji"],
		["--length", "32"],
	]) {
		expect(() =>
			randomGeneratorFrom(parseSecretsArgs(["set", "X", ...bad]))
		).toThrow();
	}
});

test("set --random stores a generated secret with its generator and never prints it", async () => {
	const node = putNode();
	const result = await runSecrets(
		[
			"set",
			"DB_PASSWORD",
			"--random",
			"--length",
			"48",
			"--charset",
			"symbols",
			"--type",
			"secret",
			"--no-project",
		],
		node
	);
	expect(result.code).toBe(0);
	const body = JSON.parse(node.calls[0]?.body ?? "{}");
	expect(body.value).toHaveLength(48);
	expect(body.metadata).toEqual({
		valueType: "secret",
		generator: { kind: "random", length: 48, charset: "symbols" },
	});
	expect(result.out + result.err).not.toContain(body.value);
	expect(result.out).toContain("new random value");
	expect(result.out).toContain("48 symbols");
});

test("set --random refuses an explicit value and does not read stdin", async () => {
	const node = putNode();
	let read = false;
	const result = await runSecrets(
		["set", "DB_PASSWORD", "hunter2", "--random", "--no-project"],
		node,
		{
			readStdin: () => {
				read = true;
				return Promise.resolve("piped");
			},
		}
	);
	expect(result.code).toBe(2);
	expect(result.err).toContain("not both");
	expect(node.calls).toHaveLength(0);
	const piped = await runSecrets(
		["set", "DB_PASSWORD", "--random", "--no-project"],
		node,
		{
			readStdin: () => {
				read = true;
				return Promise.resolve("piped");
			},
		}
	);
	expect(piped.code).toBe(0);
	expect(read).toBe(false);
	expect(JSON.parse(node.calls[0]?.body ?? "{}").value).not.toBe("piped");
});

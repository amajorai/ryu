import { describe, expect, test } from "bun:test";
import { buildContainerEnv, renderEnvFile } from "./vaultIsolation-args.ts";

describe("isolation container environment", () => {
	test("the env file holds the proxy with the token; bad names are refused", () => {
		const env = buildContainerEnv({ port: 8080, token: "t/1" });
		expect(Object.values(env).some((value) => value.includes("t%2F1"))).toBe(
			true
		);
		expect(renderEnvFile({ A: "1", B: "2" })).toBe("A=1\nB=2\n");
		expect(() => renderEnvFile({ "1A": "x" })).toThrow(
			"invalid container environment name 1A"
		);
	});
});

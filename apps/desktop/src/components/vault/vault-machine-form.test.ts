import { describe, expect, test } from "bun:test";
import type { VaultMachine } from "@/src/lib/api/vault-machines.ts";
import {
	appRoleInput,
	machineKindLabel,
	machineTokenInput,
	secretIdInput,
	usesSecretIds,
} from "./vault-machine-form.ts";

const machine = (kind: string): VaultMachine => ({
	id: "mid_1",
	name: "ci",
	auth: { kind },
	policies: [],
	tokenTtlSecs: 3600,
	disabled: false,
	createdAt: 1,
	createdBy: null,
});

describe("appRoleInput", () => {
	test("sends the name, de-duplicated policies and the token lifetime", () => {
		expect(
			appRoleInput({ name: " ci ", policies: "a, b\na", ttl: "15m" })
		).toEqual({
			input: { name: "ci", policies: ["a", "b"], tokenTtlSecs: 900 },
		});
		expect(appRoleInput({ name: "ci", policies: "", ttl: "" })).toEqual({
			input: { name: "ci", policies: [] },
		});
	});

	test("refuses a name Core refuses, an unreadable duration and one under 1m", () => {
		for (const name of ["CI", "-ci", "a b", "x".repeat(65), ""]) {
			expect(appRoleInput({ name, policies: "", ttl: "" })).toHaveProperty(
				"problem"
			);
		}
		expect(appRoleInput({ name: "ci", policies: "", ttl: "soon" })).toEqual({
			problem: "Durations look like 90s, 15m, 1h or 7d.",
		});
		for (const ttl of ["30s", "25h", "7d"]) {
			expect(appRoleInput({ name: "ci", policies: "", ttl })).toEqual({
				problem: "Token lifetime must be from 1m to 24h.",
			});
		}
		expect(appRoleInput({ name: "ci", policies: "", ttl: "24h" })).toEqual({
			input: { name: "ci", policies: [], tokenTtlSecs: 86_400 },
		});
	});
});

describe("secretIdInput", () => {
	test("blank fields send nothing; set fields send their limits", () => {
		expect(secretIdInput({ cidrs: "", ttl: "", uses: "" })).toEqual({
			input: {},
		});
		expect(
			secretIdInput({ cidrs: "10.0.0.0/8, 10.0.0.0/8", ttl: "1h", uses: "1" })
		).toEqual({
			input: { ttlSecs: 3600, uses: 1, cidrList: ["10.0.0.0/8"] },
		});
	});

	test("zero, negative and fractional uses are refused rather than meaning unlimited", () => {
		for (const uses of ["0", "-1", "1.5", "many"]) {
			expect(secretIdInput({ cidrs: "", ttl: "", uses })).toEqual({
				problem: "Uses must be a whole number of 1 or more.",
			});
		}
	});
});

describe("machineTokenInput", () => {
	test("a role, lifetime and use count become the token request", () => {
		expect(
			machineTokenInput({ role: " deploy ", ttl: "2h", uses: "5" })
		).toEqual({ input: { role: "deploy", ttlSecs: 7200, numUses: 5 } });
		expect(machineTokenInput({ role: "", ttl: "", uses: "" })).toEqual({
			input: {},
		});
	});

	test("a validity Core would clamp is refused, not silently shortened", () => {
		for (const ttl of ["5s", "2d"]) {
			expect(machineTokenInput({ role: "", ttl, uses: "" })).toEqual({
				problem: "A token is valid for 10s to 24h.",
			});
		}
		expect(machineTokenInput({ role: "", ttl: "10s", uses: "" })).toEqual({
			input: { ttlSecs: 10 },
		});
	});

	test("an unreadable lifetime or zero uses is refused", () => {
		expect(machineTokenInput({ role: "", ttl: "1y", uses: "" })).toHaveProperty(
			"problem"
		);
		expect(machineTokenInput({ role: "", ttl: "", uses: "0" })).toHaveProperty(
			"problem"
		);
	});
});

test("kind labels, and only AppRole uses secret ids", () => {
	expect(machineKindLabel(machine("approle"))).toBe("AppRole");
	expect(machineKindLabel(machine("aws-iam"))).toBe("AWS IAM");
	expect(machineKindLabel(machine("future"))).toBe("future");
	expect(usesSecretIds(machine("approle"))).toBe(true);
	expect(usesSecretIds(machine("jwt"))).toBe(false);
});

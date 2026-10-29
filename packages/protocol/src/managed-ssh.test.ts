import { describe, expect, test } from "bun:test";
import {
	isManagedSshBackup,
	isManagedSshRecoveryShare,
	isManagedSshScope,
	isManagedSshSharePolicy,
} from "./managed-ssh.ts";

const recoveryId = "12345678-1234-4123-8123-123456789abc";
const share = {
	version: 1,
	scope: "org:test",
	recoveryId,
	index: 1,
	value: `${"A".repeat(43)}B`,
};
const recovery = {
	version: 2,
	algorithm: "SHAMIR-GF256/AES-256-GCM",
	scope: share.scope,
	recoveryId,
	policy: { total: 3, threshold: 2, managed: 1 },
	iv: "A".repeat(16),
	ciphertext: "A".repeat(100),
	managedShares: [share],
};

describe("managed SSH envelope admission", () => {
	test("admits both bounded backup algorithms", () => {
		expect(isManagedSshBackup(recovery)).toBe(true);
		expect(
			isManagedSshBackup({
				version: 1,
				algorithm: "PBKDF2-SHA256/AES-256-GCM",
				iterations: 600_000,
				salt: `${"A".repeat(22)}==`,
				iv: recovery.iv,
				ciphertext: recovery.ciphertext,
			})
		).toBe(true);
	});
	test("retains threshold and scope bounds", () => {
		expect(isManagedSshSharePolicy(recovery.policy)).toBe(true);
		expect(
			isManagedSshSharePolicy({ total: 3, threshold: 2, managed: 2 })
		).toBe(false);
		expect(
			isManagedSshSharePolicy({ total: 3, threshold: 4, managed: 1 })
		).toBe(false);
		expect(isManagedSshScope("org:test/user-1")).toBe(true);
		expect(isManagedSshScope("org: test")).toBe(false);
	});
	test("binds encoded shares to their index, recovery and scope", () => {
		expect(isManagedSshRecoveryShare(share)).toBe(true);
		expect(isManagedSshRecoveryShare({ ...share, index: 2 })).toBe(false);
		expect(
			isManagedSshBackup({
				...recovery,
				managedShares: [{ ...share, scope: "other" }],
			})
		).toBe(false);
		expect(
			isManagedSshBackup({
				...recovery,
				managedShares: [
					{ ...share, recoveryId: "12345678-1234-4123-8123-123456789abd" },
				],
			})
		).toBe(false);
		expect(
			isManagedSshBackup({
				...recovery,
				policy: { total: 4, threshold: 3, managed: 2 },
				managedShares: [share, share],
			})
		).toBe(false);
	});
	test("rejects secret fields and malformed ciphertext without changing input", () => {
		const before = JSON.stringify(recovery);
		expect(isManagedSshBackup({ ...recovery, plaintext: "private-key" })).toBe(
			false
		);
		expect(
			isManagedSshBackup({ ...recovery, ciphertext: "A".repeat(101) })
		).toBe(false);
		expect(isManagedSshBackup({ ...recovery, managedShares: [] })).toBe(false);
		expect(isManagedSshBackup(undefined)).toBe(false);
		expect(isManagedSshBackup(null)).toBe(false);
		expect(isManagedSshBackup([])).toBe(false);
		expect(JSON.stringify(recovery)).toBe(before);
	});
	test("retains legacy inherited fields and original own-field count semantics", () => {
		const inherited = Object.create({ total: 3 });
		Object.assign(inherited, { threshold: 2, managed: 1, extra: true });
		expect(isManagedSshSharePolicy(inherited)).toBe(true);
		expect(isManagedSshSharePolicy({ ...recovery.policy, extra: true })).toBe(
			false
		);
	});
});

test("rejects excessive or policy-mismatched shares before reading elements", () => {
	for (const length of [2, 65_000]) {
		const shares = new Array(length);
		Object.defineProperty(shares, "0", {
			get() {
				throw new Error("share visited before admission");
			},
		});
		expect(isManagedSshBackup({ ...recovery, managedShares: shares })).toBe(
			false
		);
	}
});

import { describe, expect, test } from "bun:test";
import { ipv4InCidr, parseNetworkConfig } from "./vaultIsolation-network.ts";

describe("isolation network", () => {
	test("CIDR membership", () => {
		expect(ipv4InCidr("172.18.0.5", "172.18.0.0/16")).toBe(true);
		expect(ipv4InCidr("10.0.0.1", "172.18.0.0/16")).toBe(false);
	});

	test("a network without JSON is refused", () => {
		expect(() => parseNetworkConfig("ryu-vault-x", "not json")).toThrow(
			"docker network inspect ryu-vault-x"
		);
	});
});

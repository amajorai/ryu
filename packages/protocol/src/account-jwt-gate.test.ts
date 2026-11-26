import { describe, expect, test } from "bun:test";
import {
	hasAdmissionCredential,
	hasConfidentialTransport,
	mayAttachAccountJwt,
} from "./account-jwt-gate.ts";

const accountNode = {
	addedByLink: false,
	token: "node-token",
	url: "https://node.example.com",
};

describe("mayAttachAccountJwt", () => {
	test("a node the user added, with a token, over https", () => {
		expect(mayAttachAccountJwt(accountNode)).toBe(true);
	});

	test("a node saved from a link never qualifies, whatever it supplies", () => {
		expect(mayAttachAccountJwt({ ...accountNode, addedByLink: true })).toBe(
			false
		);
		expect(
			mayAttachAccountJwt({
				addedByLink: true,
				token: "node-token",
				url: "http://127.0.0.1:7980",
			})
		).toBe(false);
		expect(
			mayAttachAccountJwt({
				addedByLink: true,
				delegation: "node.bound.delegation",
				url: "https://node.example.com",
			})
		).toBe(false);
	});

	test("a missing link answer fails closed", () => {
		const unknown = { token: "node-token", url: "https://node.example.com" };
		// @ts-expect-error addedByLink is required; an untyped caller gets no JWT.
		expect(mayAttachAccountJwt(unknown)).toBe(false);
	});

	test("plain http to another host never qualifies", () => {
		for (const url of [
			"http://192.168.1.50:7980",
			"http://node.local:7980",
			"http://node.example.com",
			"http://localhost.evil.tld:7980",
		]) {
			expect(mayAttachAccountJwt({ ...accountNode, url })).toBe(false);
		}
	});

	test("plain http to this device qualifies", () => {
		for (const url of [
			"http://127.0.0.1:7980",
			"http://localhost:7980",
			"http://[::1]:7980",
		]) {
			expect(mayAttachAccountJwt({ ...accountNode, url })).toBe(true);
		}
	});

	test("a node with no credential of its own never qualifies", () => {
		for (const token of [null, undefined, "", "   "]) {
			expect(mayAttachAccountJwt({ ...accountNode, token })).toBe(false);
		}
	});

	test("a managed delegation counts as the admission credential", () => {
		expect(
			mayAttachAccountJwt({
				addedByLink: false,
				delegation: "node.bound.delegation",
				token: null,
				url: "https://node.example.com",
			})
		).toBe(true);
		expect(hasAdmissionCredential({ delegation: " ", token: null })).toBe(
			false
		);
	});

	test("a URL that cannot be read never qualifies", () => {
		for (const url of [
			"",
			"node.example.com",
			"https://trusted@node.example.com",
			"https://user:pass@127.0.0.1:7980",
			"ftp://node.example.com",
			"https://node.example.com\\@evil.tld",
		]) {
			expect(mayAttachAccountJwt({ ...accountNode, url })).toBe(false);
		}
	});
});

describe("hasConfidentialTransport", () => {
	test("https anywhere, http on this device only", () => {
		expect(hasConfidentialTransport("https://node.example.com")).toBe(true);
		expect(hasConfidentialTransport("HTTPS://NODE.EXAMPLE.COM")).toBe(true);
		expect(hasConfidentialTransport("http://127.0.0.1:7980")).toBe(true);
		expect(hasConfidentialTransport("http://192.168.1.50:7980")).toBe(false);
		expect(hasConfidentialTransport("http://2130706433")).toBe(false);
	});
});

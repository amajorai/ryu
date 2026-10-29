import { expect, test } from "bun:test";
import {
	buildConnectCallbackDeepLink,
	parseConnectCallbackDeepLink,
	parseRyuDeepLink,
} from "./deep-link.ts";

test("callback session round-trips without becoming an install or navigation intent", () => {
	const sessionUri = "https://connect.example/session?a=1&b=two+three#fragment";
	const link = buildConnectCallbackDeepLink(sessionUri);
	expect(parseConnectCallbackDeepLink(link)).toEqual({ sessionUri });
	expect(parseRyuDeepLink(link)).toBeNull();
});

test("callback builders preserve the requested profile scheme", () => {
	for (const profile of [
		"release",
		"dev",
		"beta",
		"nightly",
		"canary",
	] as const) {
		const link = buildConnectCallbackDeepLink("session", profile);
		expect(
			link.startsWith(profile === "release" ? "ryu://" : `ryu-${profile}://`)
		).toBe(true);
		expect(parseConnectCallbackDeepLink(link)).toEqual({
			sessionUri: "session",
		});
	}
});

test("callback links cannot select credentials, accounts, nodes, or identities", () => {
	const link = buildConnectCallbackDeepLink("session");
	for (const suffix of [
		"&node=https://other.test",
		"&user_id=other",
		"&accountId=other",
		"&token=secret",
		"&session_uri=second",
		"#fragment",
	]) {
		expect(parseConnectCallbackDeepLink(link + suffix)).toBeNull();
	}
	for (const link of [
		"ryu://connect/other?session_uri=x",
		"ryu://connect/complete?session_uri=%ZZ",
		"ryu://connect/complete?session_uri=%0A",
		"https://connect/complete?session_uri=x",
	]) {
		expect(parseConnectCallbackDeepLink(link)).toBeNull();
	}
});

test("callback size and encoding fail closed", () => {
	for (const session of [
		"",
		"a".repeat(4097),
		"界".repeat(1366),
		"has space",
		"\ud800",
	]) {
		expect(() => buildConnectCallbackDeepLink(session)).toThrow(
			"Invalid Connect"
		);
	}
	expect(
		parseConnectCallbackDeepLink(buildConnectCallbackDeepLink("a".repeat(4096)))
			?.sessionUri.length
	).toBe(4096);
});

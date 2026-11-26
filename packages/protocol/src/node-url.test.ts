import { describe, expect, test } from "bun:test";
import {
	nodeDisplayHost,
	parseLinkedNodeUrl,
	parseNodeUrl,
	sameNodeOrigin,
} from "./node-url.ts";

describe("parseNodeUrl", () => {
	test("reads scheme, host and port of a plain node URL", () => {
		expect(parseNodeUrl("https://node.example.com:7980")).toEqual({
			displayHost: "node.example.com:7980",
			host: "node.example.com",
			hostKind: "name",
			loopback: false,
			nonAscii: false,
			origin: "https://node.example.com:7980",
			port: "7980",
			punycode: false,
			scheme: "https",
			url: "https://node.example.com:7980",
		});
	});

	test("refuses userinfo, whoever it claims to be", () => {
		for (const url of [
			"https://trusted@evil.tld",
			"https://trusted.example.com@evil.tld",
			"https://user:pass@evil.tld:7980",
			"https://trusted.example.com:443@evil.tld",
			"https://@evil.tld",
			"http://trusted@127.0.0.1:7980",
		]) {
			expect(parseNodeUrl(url)).toBeNull();
			expect(nodeDisplayHost(url)).toBeNull();
		}
	});

	test("lower-cases a mixed-case scheme and host, keeps the path", () => {
		const parts = parseNodeUrl("HtTpS://Node.Example.COM:7980/Base/");
		expect(parts?.scheme).toBe("https");
		expect(parts?.displayHost).toBe("node.example.com:7980");
		expect(parts?.url).toBe("https://node.example.com:7980/Base/");
	});

	test("refuses every scheme but http and https", () => {
		for (const url of [
			"ftp://node.example.com",
			"javascript://node.example.com",
			"file:///etc/passwd",
			"node.example.com:7980",
			"//node.example.com",
			"https:/node.example.com",
		]) {
			expect(parseNodeUrl(url)).toBeNull();
		}
	});

	test("refuses what a browser would read as a different host", () => {
		for (const url of [
			"https://trusted.example.com\\@evil.tld",
			"https://evil.tld\\.trusted.example.com",
			"https://trusted.example.com%2eevil.tld",
			"https://trusted.example.com evil.tld",
			"https://trusted.example.com\t.evil.tld",
			"https://trusted.example.com\n.evil.tld",
			"https://",
			"https://:7980",
			"https://a..b",
			"https://.example.com",
		]) {
			expect(parseNodeUrl(url)).toBeNull();
		}
	});

	test("refuses a space, a control character or a backslash after the host", () => {
		// A browser rewrites these (a backslash becomes a slash), so the address
		// is refused whole. Leading and trailing whitespace is only trimmed.
		for (const url of [
			"https://node.example.com/a b",
			"https://node.example.com/a\\b",
			"https://node.example.com/a\u0000b",
			"https://node.example.com/?q=a\u007fb",
		]) {
			expect(parseNodeUrl(url)).toBeNull();
		}
		expect(parseNodeUrl("  https://node.example.com/a  ")?.url).toBe(
			"https://node.example.com/a"
		);
	});

	test("shows punycode as punycode and flags it", () => {
		const parts = parseNodeUrl("https://xn--pple-43d.com");
		expect(parts?.punycode).toBe(true);
		expect(parts?.displayHost).toBe("xn--pple-43d.com");
		expect(parts?.nonAscii).toBe(false);
	});

	test("an unencoded international host is flagged and no link may carry it", () => {
		const url = "https://\u0430pple.com";
		expect(parseNodeUrl(url)?.nonAscii).toBe(true);
		expect(parseLinkedNodeUrl(url)).toBeNull();
		expect(nodeDisplayHost(url)).toBeNull();
		expect(parseLinkedNodeUrl("https://b\u00fccher.example")).toBeNull();
	});

	test("validates the port", () => {
		expect(parseNodeUrl("http://192.168.1.50:7980")?.port).toBe("7980");
		expect(parseNodeUrl("https://node.example.com")?.port).toBeNull();
		for (const url of [
			"https://node.example.com:",
			"https://node.example.com:65536",
			"https://node.example.com:123456",
			"https://node.example.com:80a",
			"https://node.example.com:-1",
			"https://node.example.com:80:90",
		]) {
			expect(parseNodeUrl(url)).toBeNull();
		}
	});

	test("a trailing dot is kept and is never this device", () => {
		const parts = parseNodeUrl("https://node.example.com.");
		expect(parts?.displayHost).toBe("node.example.com.");
		expect(parseNodeUrl("http://localhost.:7980")?.loopback).toBe(false);
		expect(parseNodeUrl("http://127.0.0.1.:7980")).toBeNull();
	});

	test("knows this device from the LAN", () => {
		for (const url of [
			"http://localhost:7980",
			"http://LOCALHOST",
			"http://127.0.0.1:7980",
			"http://127.9.9.9",
			"http://[::1]:7980",
		]) {
			expect(parseNodeUrl(url)?.loopback).toBe(true);
		}
		for (const url of [
			"http://192.168.1.50:7980",
			"http://10.0.0.5",
			"http://node.local:7980",
			"http://127.example.com",
			"http://localhost.evil.tld",
			"http://foo.localhost",
			"http://[fe80::1]:7980",
			"http://[::ffff:127.0.0.1]",
		]) {
			expect(parseNodeUrl(url)?.loopback).toBe(false);
		}
	});

	test("refuses a numeric host that is not a dotted quad", () => {
		for (const url of [
			"http://2130706433",
			"http://127.1",
			"http://0x7f.0.0.1",
			"http://127.0.0.256",
			"http://127.0.0.01",
			"http://1.2.3.4.5",
		]) {
			expect(parseNodeUrl(url)).toBeNull();
		}
	});

	test("reads bracketed IPv6 and refuses a malformed one", () => {
		expect(parseNodeUrl("https://[2001:db8::1]:7980")?.displayHost).toBe(
			"[2001:db8::1]:7980"
		);
		expect(parseNodeUrl("https://[2001:DB8::1]")?.host).toBe("2001:db8::1");
		for (const url of [
			"https://[]",
			"https://[::1",
			"https://[::1]x",
			"https://[evil.tld]",
			"https://2001:db8::1",
		]) {
			expect(parseNodeUrl(url)).toBeNull();
		}
	});
});

describe("sameNodeOrigin", () => {
	test("ignores case, path and a default port", () => {
		expect(
			sameNodeOrigin(
				"https://Node.Example.com/",
				"https://node.example.com:443"
			)
		).toBe(true);
		expect(
			sameNodeOrigin("http://node.example.com", "https://node.example.com")
		).toBe(false);
		expect(
			sameNodeOrigin(
				"https://node.example.com",
				"https://node.example.com:7980"
			)
		).toBe(false);
		expect(sameNodeOrigin("not a url", "not a url")).toBe(false);
	});
});

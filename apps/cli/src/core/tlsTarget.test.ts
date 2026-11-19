import { afterEach, expect, test } from "bun:test";
import { parseArgs, runCli } from "../cli/dispatch.ts";
import { tlsSettings, withTargetTls } from "./tlsTarget.ts";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const files = (path: string) => {
	if (path === "/ca.pem") {
		return PEM;
	}
	if (path === "/empty.pem") {
		return "not a certificate";
	}
	throw new Error("ENOENT");
};
const none = { caCert: null, tlsSkipVerify: false };

test("parseArgs reads --ca-cert in both forms and --tls-skip-verify", () => {
	expect(parseArgs(["list", "--ca-cert", "/ca.pem"]).flags.caCert).toBe(
		"/ca.pem"
	);
	expect(parseArgs(["--ca-cert=/ca.pem", "list"]).flags.caCert).toBe("/ca.pem");
	const flags = parseArgs(["list", "--tls-skip-verify"]).flags;
	expect(flags.tlsSkipVerify).toBe(true);
	expect(parseArgs(["list"]).flags).toMatchObject(none);
});

test("settings come from flags first, then the environment", () => {
	expect(tlsSettings(none, {}, files)).toBeNull();
	expect(tlsSettings(none, { RYU_TLS_SKIP_VERIFY: "0" }, files)).toBeNull();
	expect(tlsSettings(none, { RYU_CA_CERT: "/ca.pem" }, files)).toEqual({
		ca: PEM,
	});
	expect(tlsSettings(none, { RYU_TLS_SKIP_VERIFY: "1" }, files)).toEqual({
		rejectUnauthorized: false,
	});
	expect(
		tlsSettings(
			{ caCert: "/ca.pem", tlsSkipVerify: false },
			{ RYU_CA_CERT: "/missing.pem" },
			files
		)
	).toEqual({ ca: PEM });
	expect(() =>
		tlsSettings({ caCert: "/missing.pem", tlsSkipVerify: false }, {}, files)
	).toThrow("Could not read the CA bundle /missing.pem");
	expect(() =>
		tlsSettings({ caCert: "/empty.pem", tlsSkipVerify: false }, {}, files)
	).toThrow("holds no PEM certificate");
});

test("https requests carry the settings; http targets and no settings are untouched", async () => {
	const seen: unknown[] = [];
	const inner = (_input: RequestInfo | URL, init?: RequestInit) => {
		seen.push((init as { tls?: unknown } | undefined)?.tls);
		return Promise.resolve(new Response("ok"));
	};
	const https = { fetch: inner, token: "t", url: "https://node.example" };
	const wrapped = withTargetTls(https, { ca: PEM });
	await wrapped.fetch?.("https://node.example/api/health", { method: "GET" });
	expect(seen).toEqual([{ ca: PEM }]);

	const http = { fetch: inner, token: "t", url: "http://127.0.0.1:7980" };
	expect(withTargetTls(http, { ca: PEM })).toBe(http);
	expect(withTargetTls(https, null)).toBe(https);
});

const TLS_ENV = ["RYU_CA_CERT", "RYU_TLS_SKIP_VERIFY"] as const;
const savedTlsEnv = TLS_ENV.map((name) => [name, process.env[name]] as const);

afterEach(() => {
	for (const [name, value] of savedTlsEnv) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

/** Runs `ryu-cli secrets` (help only, no request) and returns its stderr. */
async function secretsHelpStderr(argv: string[]): Promise<string> {
	for (const name of TLS_ENV) {
		delete process.env[name];
	}
	const err: string[] = [];
	const io = { err: (s: string) => err.push(s), out: () => undefined };
	await runCli(["secrets", ...argv], { io });
	return err.join("");
}

const SKIP_WARNING =
	"Warning: TLS certificate verification is off; the node token goes to whoever answers.";

test("--tls-skip-verify and RYU_TLS_SKIP_VERIFY print the warning on stderr", async () => {
	expect(await secretsHelpStderr(["--tls-skip-verify"])).toContain(
		SKIP_WARNING
	);
	const err: string[] = [];
	delete process.env.RYU_CA_CERT;
	process.env.RYU_TLS_SKIP_VERIFY = "1";
	await runCli(["secrets"], {
		io: { err: (s: string) => err.push(s), out: () => undefined },
	});
	expect(err.join("")).toContain(SKIP_WARNING);
});

test("the default path verifies certificates and prints no warning", async () => {
	expect(await secretsHelpStderr([])).not.toContain("TLS certificate");
	process.env.RYU_TLS_SKIP_VERIFY = "0";
	const err: string[] = [];
	await runCli(["secrets"], {
		io: { err: (s: string) => err.push(s), out: () => undefined },
	});
	expect(err.join("")).not.toContain("TLS certificate");
});

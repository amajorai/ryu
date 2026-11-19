import { expect, test } from "bun:test";
import {
	buildVaultBrokerContainerConfig,
	buildVaultProxyEnv,
	VAULT_BROKER_PLACEHOLDER,
	vaultBrokerPlaceholderNames,
	vaultProxyEnvFromGrant,
} from "./broker-env.ts";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

test("the proxy env matches Core's broker::proxy_env for a loopback session", () => {
	const env = buildVaultProxyEnv({
		token: "rvb_tok/en",
		port: 8901,
		caPath: "/data/broker/ca.pem",
		caBundlePath: "/data/broker/ca-bundle.pem",
	});
	expect(env).toEqual({
		HTTPS_PROXY: "http://rvb:rvb_tok%2Fen@127.0.0.1:8901",
		HTTP_PROXY: "http://rvb:rvb_tok%2Fen@127.0.0.1:8901",
		https_proxy: "http://rvb:rvb_tok%2Fen@127.0.0.1:8901",
		http_proxy: "http://rvb:rvb_tok%2Fen@127.0.0.1:8901",
		NO_PROXY: "localhost,127.0.0.1,::1",
		no_proxy: "localhost,127.0.0.1,::1",
		NODE_USE_ENV_PROXY: "1",
		NODE_EXTRA_CA_CERTS: "/data/broker/ca.pem",
		DENO_CERT: "/data/broker/ca.pem",
		SSL_CERT_FILE: "/data/broker/ca-bundle.pem",
		REQUESTS_CA_BUNDLE: "/data/broker/ca-bundle.pem",
		CURL_CA_BUNDLE: "/data/broker/ca-bundle.pem",
		GIT_SSL_CAINFO: "/data/broker/ca-bundle.pem",
	});
});

test("placeholders, IPv6 hosts, and invalid input", () => {
	const env = buildVaultProxyEnv({
		token: "t",
		port: 1,
		host: "::1",
		placeholders: ["ANTHROPIC_API_KEY"],
	});
	expect(env.ANTHROPIC_API_KEY).toBe(VAULT_BROKER_PLACEHOLDER);
	expect(VAULT_BROKER_PLACEHOLDER).toBe("__ryu_broker__");
	expect(env.HTTPS_PROXY).toBe("http://rvb:t@[::1]:1");
	expect(env.SSL_CERT_FILE).toBeUndefined();
	expect(() => buildVaultProxyEnv({ token: "t", port: 0 })).toThrow("port");
	expect(() =>
		buildVaultProxyEnv({ token: "t", port: 1, placeholders: ["A=B"] })
	).toThrow("invalid variable name");
});

test("placeholder names come from auth references, else the catalog", () => {
	expect(
		vaultBrokerPlaceholderNames([
			{
				name: "anthropic-prod",
				auth: {
					type: "api_key",
					header: "x-api-key",
					value: "secret:CLAUDE_KEY",
				},
			},
			{ name: "Anthropic" },
			"openai",
			"github",
			"internal-api",
			{ name: "weird", auth: { value: "secret:not-an-env-name" } },
		])
	).toEqual([
		"ANTHROPIC_API_KEY",
		"CLAUDE_KEY",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"OPENAI_API_KEY",
	]);
});

test("a grant renders env with placeholders; a down broker yields null", () => {
	const session = {
		id: "s1",
		label: "",
		environment: "dev",
		mintedBy: "u",
		createdAt: "2030-01-01T00:00:00Z",
		expiresAt: "2030-01-01T01:00:00Z",
		services: ["anthropic"],
	};
	const proxy = {
		port: 8901,
		url: "http://127.0.0.1:8901",
		caPath: "/ca.pem",
		caBundlePath: "/bundle.pem",
		caUrl: "",
		env: {},
	};
	const env = vaultProxyEnvFromGrant({ token: "rvb_1", session, proxy });
	expect(env?.ANTHROPIC_API_KEY).toBe("__ryu_broker__");
	expect(env?.NODE_EXTRA_CA_CERTS).toBe("/ca.pem");
	expect(
		vaultProxyEnvFromGrant({ token: "rvb_1", session, proxy: null })
	).toBeNull();
});

test("the container config mounts the CA, maps the gateway, and proxies everything", () => {
	const config = buildVaultBrokerContainerConfig({
		token: "rvb_2",
		port: 8901,
		caPem: PEM,
		placeholders: ["OPENAI_API_KEY"],
	});
	expect(config.caFile).toEqual({
		path: "/etc/ryu-broker/ca.pem",
		content: PEM,
	});
	expect(config.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
	expect(config.env.HTTPS_PROXY).toBe(
		"http://rvb:rvb_2@host.docker.internal:8901"
	);
	expect(config.env.NO_PROXY).toBe("");
	expect(config.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ryu-broker/ca.pem");
	expect(config.env.REQUESTS_CA_BUNDLE).toBe("/etc/ryu-broker/ca.pem");
	expect(config.env.OPENAI_API_KEY).toBe("__ryu_broker__");
	expect(
		buildVaultBrokerContainerConfig({
			token: "t",
			port: 1,
			caPem: PEM,
			caBundlePath: "/etc/ssl/bundle.pem",
		}).env.SSL_CERT_FILE
	).toBe("/etc/ssl/bundle.pem");
	expect(() =>
		buildVaultBrokerContainerConfig({ token: "t", port: 1, caPem: "nope" })
	).toThrow("PEM");
});

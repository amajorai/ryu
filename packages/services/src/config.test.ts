import { describe, expect, test } from "bun:test";
import {
	AVAILABILITY,
	assertBrowserSafe,
	CONTROL_PLANE_URL,
	constructorOptionFor,
	credentialEnvVarsFor,
	DEFAULT_BOX_URL,
	DEFAULT_GATEWAY_URL,
	DEFAULT_NOTIFY_URL,
	defaultErrorHint,
	ENV_VARS,
	type RyuOptions,
	resolveServiceConfig,
	SERVICE_TITLES,
	urlEnvVarFor,
} from "./config.ts";
import { createEnvReader } from "./env.ts";
import {
	knownServerHint,
	messageWithoutHint,
	RyuConfigurationError,
	type RyuError,
	type RyuService,
} from "./errors.ts";
import { SERVICE_ROUTES } from "./routes.ts";

const SERVICES = Object.keys(SERVICE_ROUTES) as RyuService[];

function resolve(
	service: RyuService,
	env: Record<string, string>,
	options: RyuOptions = {}
) {
	return resolveServiceConfig(service, options, createEnvReader(env));
}

function configError(run: () => unknown): RyuError {
	try {
		run();
	} catch (error) {
		if (error instanceof RyuConfigurationError) {
			return error;
		}
		throw error;
	}
	throw new Error("expected a configuration error");
}

describe("resolveServiceConfig", () => {
	test("a missing URL or key names the env vars", () => {
		const error = configError(() => resolve("connect", {}));
		expect(error.code).toBe("configuration_error");
		expect(error.status).toBe(0);
		expect(error.details).toEqual({
			missing: ["RYU_CONNECT_URL", "RYU_CONNECT_API_KEY"],
		});
		expect(error.message).toContain("RYU_CONNECT_URL");
		expect(error.docs).toBe(
			"https://docs.ryuhq.com/docs/standalone/sdk/connect"
		);
		expect(configError(() => resolve("notify", {})).docs).toBe(
			"https://docs.ryuhq.com/docs/standalone/sdk/notify"
		);
		expect(
			configError(() =>
				resolve("box", { RYU_BOX_URL: "http://127.0.0.1:8090" })
			).details
		).toEqual({
			missing: ["RYU_BOX_API_KEY"],
		});
	});

	test("messages and hints use display names and join required vars with 'and'", () => {
		const error = configError(() => resolve("passport", {}));
		expect(messageWithoutHint(error)).toBe(
			"Ryu Passport is not configured: set RYU_PASSPORT_URL and RYU_PASSPORT_API_KEY. It has no default URL."
		);
		expect(error.hint).toBe(
			"Set RYU_PASSPORT_URL and RYU_PASSPORT_API_KEY (or pass passport.baseUrl and passport.apiKey to new Ryu()). See https://docs.ryuhq.com/docs/standalone/sdk/passport."
		);
		expect(error.hint).not.toContain(" or RYU_");
	});

	test("a missing key alone does not claim the URL is missing", () => {
		const error = configError(() =>
			resolve("sites", { RYU_SITES_URL: "http://127.0.0.1:47871" })
		);
		expect(messageWithoutHint(error)).toBe(
			"Ryu Sites is not configured: set RYU_SITES_API_KEY."
		);
		expect(error.hint).toContain("sites.apiKey");
	});

	test("Mail's hint keeps its real alternatives", () => {
		const error = configError(() => resolve("mail", {}));
		expect(error.hint).toContain(
			"Set RYU_API_KEY (or pass apiKey) to a ryu_ key with Mail scopes for hosted Mail, or RYU_MAIL_GATEWAY_KEY (or mail.gatewayKey) for a node gateway key, or RYU_MAIL_URL and RYU_MAIL_API_KEY"
		);
	});

	test("an unparseable URL is named but never echoed", () => {
		const error = configError(() =>
			resolve("notify", {
				RYU_NOTIFY_API_KEY: "k",
				RYU_NOTIFY_URL: "notify.example.com/?token=abc123",
			})
		);
		expect(error.code).toBe("invalid_url");
		expect(error.message).toContain("RYU_NOTIFY_URL");
		expect(error.message).toContain("Ryu Notify");
		expect(JSON.stringify(error)).not.toContain("abc123");
	});

	test("a URL written without its scheme names the fix, not the value", () => {
		for (const value of [
			"127.0.0.1:48721",
			"localhost:8021",
			"sites.example.com/x",
			"[::1]:8021",
			"LOCALHOST",
		]) {
			const error = configError(() =>
				resolve("sites", { RYU_SITES_API_KEY: "k", RYU_SITES_URL: value })
			);
			expect(error.code).toBe("invalid_url");
			expect(error.hint).toBe(
				"Add the scheme, for example http://127.0.0.1:8021 or https://api.example.com."
			);
			expect(error.message.endsWith(`Hint: ${error.hint}`)).toBe(true);
			expect(JSON.stringify(error)).not.toContain(value);
			expect(error.message).not.toContain(value);
		}
		for (const value of [
			"not a url",
			"nope",
			"ftp://sites.example.com",
			"mailto:x",
			"http:127.0.0.1:8021",
			"http:/127.0.0.1:8021",
		]) {
			const error = configError(() =>
				resolve("sites", { RYU_SITES_API_KEY: "k", RYU_SITES_URL: value })
			);
			expect(error.code).toBe("invalid_url");
			expect(error.hint).toBeNull();
		}
	});

	test("a scheme without its // is rejected, as Python's urlsplit rejects it", () => {
		// WHATWG `new URL` would repair these into http://127.0.0.1:8021.
		for (const value of [
			"http:127.0.0.1:8021",
			"http:/127.0.0.1:8021",
			"https:\\\\127.0.0.1:8021",
		]) {
			const error = configError(() =>
				resolve("sites", { RYU_SITES_API_KEY: "k", RYU_SITES_URL: value })
			);
			expect(error.code).toBe("invalid_url");
		}
		for (const value of [
			"HTTP://127.0.0.1:8021",
			"https://sites.example.com",
		]) {
			expect(
				resolve("sites", { RYU_SITES_API_KEY: "k", RYU_SITES_URL: value })
					.baseUrl
			).toBe(value);
		}
	});

	test("every env var maps to a constructor option and every service has a title", () => {
		for (const row of ENV_VARS) {
			expect(constructorOptionFor(row.name)).not.toBe(row.name);
		}
		expect(Object.keys(SERVICE_TITLES).sort()).toEqual([...SERVICES].sort());
	});

	test("the wrong-service hint names config.ts's URL env var and title", () => {
		// errors.ts keeps private copies (config.ts imports errors.ts).
		for (const service of SERVICES) {
			const other = service === "box" ? "notify" : "box";
			const hint = knownServerHint(service, 401, "", {
				type: `https://docs.ryuhq.com/docs/standalone/${other}-api#unauthorized`,
			});
			expect(hint?.hint).toStartWith(
				`${urlEnvVarFor(service)} points at ${SERVICE_TITLES[other]}, not ${SERVICE_TITLES[service]}:`
			);
		}
	});

	describe("default error hints", () => {
		const notify = resolve("notify", {
			RYU_NOTIFY_API_KEY: "notify_secret_key",
			RYU_NOTIFY_URL: "http://user:pw@127.0.0.1:1/base?x=1",
		});

		test("a 401 names the service key env var and constructor option", () => {
			const hint = defaultErrorHint(
				{ code: "unauthenticated", status: 401 },
				notify
			);
			expect(hint).toBe(
				"Ryu Notify did not accept the credentials. Check RYU_NOTIFY_API_KEY (or notify.apiKey)."
			);
			expect(hint).not.toContain("notify_secret_key");
		});

		test("a 403 on a per-service key names the key env var", () => {
			const hint = defaultErrorHint({ code: "forbidden", status: 403 }, notify);
			expect(hint).toContain("Check RYU_NOTIFY_API_KEY (or notify.apiKey).");
			expect(hint).not.toContain("notify_secret_key");
		});

		test("Managed Agents names RYU_API_KEY and RYU_ORGANIZATION_ID on a 401 only", () => {
			const agents = resolve("managedAgents", { RYU_API_KEY: "ryu_secret" });
			const hint = defaultErrorHint(
				{ code: "unauthenticated", status: 401 },
				agents
			);
			expect(hint).toBe(
				"Ryu Managed Agents did not accept the credentials. Check RYU_API_KEY and RYU_ORGANIZATION_ID (or apiKey and organizationId)."
			);
			expect(hint).not.toContain("ryu_secret");
			expect(
				defaultErrorHint({ code: "forbidden", status: 403 }, agents)
			).toBeNull();
		});

		test("Connect gets no key-and-scopes 403 hint: its runtime keys carry no scopes", () => {
			const connect = resolve("connect", {
				RYU_CONNECT_API_KEY: "connect_secret",
				RYU_CONNECT_URL: "http://127.0.0.1:8094",
			});
			expect(
				defaultErrorHint({ code: "tool_denied", status: 403 }, connect)
			).toBeNull();
			expect(
				defaultErrorHint({ code: "unauthorized", status: 401 }, connect)
			).toBe(
				"Ryu Connect did not accept the credentials. Check RYU_CONNECT_API_KEY (or connect.apiKey)."
			);
		});

		test("Mail names the key its mode sends", () => {
			const hosted = resolve("mail", { RYU_MAIL_GATEWAY_KEY: "g" });
			expect(
				defaultErrorHint({ code: "unauthenticated", status: 401 }, hosted)
			).toContain("Check RYU_MAIL_GATEWAY_KEY (or mail.gatewayKey).");
			const selfHosted = resolve("mail", {
				RYU_MAIL_API_KEY: "m",
				RYU_MAIL_URL: "http://127.0.0.1:2",
			});
			expect(
				defaultErrorHint({ code: "unauthenticated", status: 401 }, selfHosted)
			).toContain("Check RYU_MAIL_API_KEY (or mail.apiKey).");
		});

		test("a connection error names the origin, RYU_<SVC>_URL and doctor", () => {
			const hint = defaultErrorHint(
				{ code: "connection_error", status: 0 },
				notify
			);
			expect(hint).toBe(
				"Could not reach Ryu Notify at http://127.0.0.1:1. Check RYU_NOTIFY_URL (or notify.baseUrl). Run `ryu-services doctor --check` to test the connection."
			);
		});

		test("a timeout names the request origin without path, query or userinfo", () => {
			const hint = defaultErrorHint(
				{
					code: "timeout",
					status: 0,
					url: "http://ops:hunter2@127.0.0.1:1/v1/messages?x=1",
				},
				notify
			);
			expect(hint).toContain(
				"Ryu Notify at http://127.0.0.1:1 did not respond in time"
			);
			expect(hint).toContain("Check RYU_NOTIFY_URL (or notify.baseUrl).");
			expect(hint).toContain("ryu-services doctor --check");
			for (const leaked of ["hunter2", "ops", "/v1/messages", "x=1", "pw"]) {
				expect(hint).not.toContain(leaked);
			}
		});

		test("a transport failure on another origin names the service origin, not the foreign one", () => {
			const hint = defaultErrorHint(
				{
					code: "connection_error",
					status: 0,
					url: "https://elsewhere.example.org/attachment",
				},
				notify
			);
			expect(hint).toContain(
				"Could not reach Ryu Notify at http://127.0.0.1:1."
			);
			expect(hint).not.toContain("elsewhere.example.org");
		});

		test("a Gateway without a token says no credential was sent", () => {
			const gateway = resolve("gateway", {});
			const expected =
				"Ryu Gateway requires a credential and none was sent. Set RYU_GATEWAY_TOKEN (or gateway.apiKey).";
			expect(
				defaultErrorHint({ code: "unauthenticated", status: 401 }, gateway)
			).toBe(expected);
			expect(
				defaultErrorHint({ code: "forbidden", status: 403 }, gateway)
			).toBe(expected);
			const withToken = resolve("gateway", { RYU_GATEWAY_TOKEN: "gw_secret" });
			const hint = defaultErrorHint(
				{ code: "unauthenticated", status: 401 },
				withToken
			);
			expect(hint).toBe(
				"Ryu Gateway did not accept the credentials. Check RYU_GATEWAY_TOKEN (or gateway.apiKey)."
			);
			expect(hint).not.toContain("gw_secret");
		});

		test("other errors get no default hint", () => {
			expect(
				defaultErrorHint({ code: "not_found", status: 404 }, notify)
			).toBeNull();
			expect(
				defaultErrorHint({ code: "aborted", status: 0 }, notify)
			).toBeNull();
		});
	});

	test.each([
		["notify", "RYU_NOTIFY_API_KEY", DEFAULT_NOTIFY_URL],
		["box", "RYU_BOX_API_KEY", DEFAULT_BOX_URL],
	] as const)("%s defaults to its hosted origin and needs %s", (service, keyEnv, url) => {
		expect(url).toBe(`https://${service}.ryuhq.com`);
		expect(resolve(service, { [keyEnv]: "k" })).toMatchObject({
			apiKey: "k",
			auth: "bearer",
			baseUrl: url,
		});
		expect(configError(() => resolve(service, {})).details).toEqual({
			missing: [keyEnv],
		});
		expect(
			ENV_VARS.find((row) => row.service === service && row.role === "url")
				?.default
		).toBe(url);
		// RYU_<SVC>_URL still points it at a self-hosted origin.
		expect(
			resolve(service, {
				[keyEnv]: "k",
				[`RYU_${service.toUpperCase()}_URL`]: "http://127.0.0.1:9000",
			}).baseUrl
		).toBe("http://127.0.0.1:9000");
	});

	test.each([
		["connect", "RYU_CONNECT_URL", "RYU_CONNECT_API_KEY"],
		["passport", "RYU_PASSPORT_URL", "RYU_PASSPORT_API_KEY"],
		["sites", "RYU_SITES_URL", "RYU_SITES_API_KEY"],
	] as const)("%s has no default URL and reads %s / %s", (service, urlEnv, keyEnv) => {
		expect(
			configError(() => resolve(service, { [keyEnv]: "k" })).details
		).toEqual({ missing: [urlEnv] });
		expect(
			resolve(service, { [keyEnv]: "k", [urlEnv]: "http://127.0.0.1:9000" })
		).toMatchObject({
			apiKey: "k",
			auth: "bearer",
			baseUrl: "http://127.0.0.1:9000",
		});
	});

	test("constructor options win over env", () => {
		const config = resolve(
			"notify",
			{
				RYU_NOTIFY_API_KEY: "env_key",
				RYU_NOTIFY_URL: "http://env.example.com",
			},
			{ notify: { apiKey: "opt_key", baseUrl: "http://opt.example.com" } }
		);
		expect(config.apiKey).toBe("opt_key");
		expect(config.baseUrl).toBe("http://opt.example.com");
	});

	test("Managed Agents defaults to the control plane and reads RYU_API_KEY and RYU_ORGANIZATION_ID", () => {
		expect(
			resolve("managedAgents", {
				RYU_API_KEY: "ryu_k",
				RYU_ORGANIZATION_ID: "org_1",
			})
		).toMatchObject({
			apiKey: "ryu_k",
			auth: "x-api-key",
			baseUrl: CONTROL_PLANE_URL,
			organizationId: "org_1",
		});
		expect(
			resolve("managedAgents", {
				RYU_API_KEY: "ryu_k",
				RYU_API_URL: "https://staging.example.com",
			}).baseUrl
		).toBe("https://staging.example.com");
		expect(configError(() => resolve("managedAgents", {})).details).toEqual({
			missing: ["RYU_API_KEY"],
		});
	});

	test("RYU_API_KEY is never used for a service outside the control plane", () => {
		const env = { RYU_API_KEY: "ryu_secret" };
		for (const service of SERVICES.filter(
			(name) =>
				name !== "managedAgents" &&
				name !== "gateway" &&
				name !== "mail" &&
				(name as string) !== "messaging"
		)) {
			expect(() => resolve(service, env)).toThrow(RyuConfigurationError);
		}
		expect(resolve("gateway", env).apiKey).toBeNull();
		// A self-hosted Mail URL never receives the ryu_ key.
		const error = configError(() =>
			resolve(
				"mail",
				{ ...env, RYU_MAIL_URL: "http://127.0.0.1:7996" },
				{ apiKey: "ryu_secret" }
			)
		);
		expect(error.details).toEqual({ missing: ["RYU_MAIL_API_KEY"] });
		expect(JSON.stringify(error)).not.toContain("ryu_secret");
	});

	test("hosted Mail takes the ryu_ key as x-api-key, with the organization", () => {
		expect(
			resolve("mail", { RYU_API_KEY: "ryu_k", RYU_ORGANIZATION_ID: "org_1" })
		).toMatchObject({
			apiKey: "ryu_k",
			auth: "x-api-key",
			baseUrl: CONTROL_PLANE_URL,
			mailMode: "hosted",
			organizationId: "org_1",
		});
		// The apiKey and organizationId options, and RYU_API_URL, apply too.
		expect(
			resolve(
				"mail",
				{ RYU_API_URL: "https://staging.example.com" },
				{ apiKey: "ryu_opt", organizationId: "org_opt" }
			)
		).toMatchObject({
			apiKey: "ryu_opt",
			baseUrl: "https://staging.example.com",
			organizationId: "org_opt",
		});
		// A RYU_MAIL_URL on the control-plane origin keeps the ryu_ key.
		expect(
			resolve("mail", {
				RYU_API_KEY: "ryu_k",
				RYU_MAIL_URL: "https://api.ryuhq.com",
			}).auth
		).toBe("x-api-key");
	});

	test("Mail credential precedence: options before env, then gateway key, self-hosted bearer, ryu_ key", () => {
		const all = {
			RYU_API_KEY: "ryu_k",
			RYU_MAIL_API_KEY: "sk",
			RYU_MAIL_GATEWAY_KEY: "gk",
		};
		expect(resolve("mail", all)).toMatchObject({
			apiKey: "gk",
			auth: "x-gateway-key",
		});
		expect(
			resolve("mail", { ...all, RYU_MAIL_URL: "http://127.0.0.1:7996" })
		).toMatchObject({ apiKey: "sk", auth: "bearer" });
		expect(
			resolve("mail", {
				RYU_API_KEY: "ryu_k",
				RYU_MAIL_API_KEY: "sk",
				RYU_MAIL_URL: "http://127.0.0.1:7996",
			})
		).toMatchObject({ apiKey: "sk", auth: "bearer" });
		// A key passed as an option beats every env credential.
		expect(
			resolve(
				"mail",
				{ RYU_API_KEY: "ryu_k" },
				{ mail: { gatewayKey: "gk_opt" } }
			)
		).toMatchObject({ apiKey: "gk_opt", auth: "x-gateway-key" });
		expect(
			resolve("mail", { RYU_MAIL_GATEWAY_KEY: "gk" }, { apiKey: "ryu_opt" })
		).toMatchObject({ apiKey: "ryu_opt", auth: "x-api-key" });
		// An explicit self-hosted bearer is not silently swapped for an env
		// gateway key: without a URL it fails naming RYU_MAIL_URL.
		expect(
			configError(() =>
				resolve(
					"mail",
					{ RYU_MAIL_GATEWAY_KEY: "gk" },
					{ mail: { apiKey: "sk_opt" } }
				)
			).details
		).toEqual({ missing: ["RYU_MAIL_URL"] });
		// Within options, the same order applies.
		expect(
			resolve("mail", {}, { apiKey: "ryu_opt", mail: { gatewayKey: "gk_opt" } })
		).toMatchObject({ apiKey: "gk_opt", auth: "x-gateway-key" });
		// The ryu_ option never goes to a self-hosted URL: env self-hosted wins.
		expect(
			resolve(
				"mail",
				{ RYU_MAIL_API_KEY: "sk", RYU_MAIL_URL: "http://127.0.0.1:7996" },
				{ apiKey: "ryu_opt" }
			)
		).toMatchObject({ apiKey: "sk", auth: "bearer" });
		// managedAgents.apiKey never selects hosted Mail.
		expect(
			configError(() =>
				resolve("mail", {}, { managedAgents: { apiKey: "ryu_ma" } })
			).details
		).toEqual({
			missing: ["RYU_API_KEY", "RYU_MAIL_GATEWAY_KEY", "RYU_MAIL_API_KEY"],
		});
	});

	test("hosted Mail on a ryu_ key names RYU_API_KEY in auth hints", () => {
		const config = resolve("mail", { RYU_API_KEY: "ryu_k" });
		expect(credentialEnvVarsFor(config)).toEqual([
			"RYU_API_KEY",
			"RYU_ORGANIZATION_ID",
		]);
		expect(
			defaultErrorHint({ code: "insufficient_scope", status: 403 }, config)
		).toBe(
			"Ryu Mail accepted the key but it may not do this; check its scopes and tenant. Check RYU_API_KEY and RYU_ORGANIZATION_ID (or apiKey and organizationId)."
		);
	});

	test("Gateway defaults to the local gateway and its token is optional", () => {
		expect(resolve("gateway", {})).toMatchObject({
			apiKey: null,
			baseUrl: DEFAULT_GATEWAY_URL,
		});
		expect(
			resolve("gateway", {
				RYU_GATEWAY_TOKEN: "gw",
				RYU_GATEWAY_URL: "http://10.0.0.2:7981",
			})
		).toMatchObject({
			apiKey: "gw",
			baseUrl: "http://10.0.0.2:7981",
		});
	});

	test("hosted Mail defaults to the control plane for a gateway key; self-hosted needs a URL", () => {
		expect(resolve("mail", { RYU_MAIL_GATEWAY_KEY: "gk" })).toMatchObject({
			apiKey: "gk",
			auth: "x-gateway-key",
			baseUrl: CONTROL_PLANE_URL,
			mailMode: "hosted",
		});
		expect(
			configError(() => resolve("mail", { RYU_MAIL_API_KEY: "sk" })).details
		).toEqual({
			missing: ["RYU_MAIL_URL"],
		});
		expect(configError(() => resolve("mail", {})).details).toEqual({
			missing: ["RYU_API_KEY", "RYU_MAIL_GATEWAY_KEY", "RYU_MAIL_API_KEY"],
		});
	});

	test("with both Mail keys, a non-control-plane URL selects self-hosted Bearer", () => {
		const both = { RYU_MAIL_API_KEY: "sk", RYU_MAIL_GATEWAY_KEY: "gk" };
		expect(
			resolve("mail", { ...both, RYU_MAIL_URL: "http://127.0.0.1:7996" })
		).toMatchObject({
			apiKey: "sk",
			auth: "bearer",
			baseUrl: "http://127.0.0.1:7996",
			mailMode: "self-hosted",
		});
		expect(
			resolve("mail", { ...both, RYU_MAIL_URL: "https://api.ryuhq.com" })
		).toMatchObject({
			apiKey: "gk",
			mailMode: "hosted",
		});
		expect(resolve("mail", both).mailMode).toBe("hosted");
	});

	test("Connect management and Passport runtime keys", () => {
		expect(
			resolve("connect", {
				RYU_CONNECT_API_KEY: "rt",
				RYU_CONNECT_MANAGEMENT_KEY: "mg",
				RYU_CONNECT_URL: "http://127.0.0.1:8094",
			}).managementKey
		).toBe("mg");
		expect(
			resolve("passport", {
				RYU_PASSPORT_API_KEY: "ad",
				RYU_PASSPORT_RUNTIME_KEY: "rt",
				RYU_PASSPORT_URL: "http://127.0.0.1:8093",
			}).runtimeKey
		).toBe("rt");
	});

	test("an invalid URL is a configuration error", () => {
		const error = configError(() =>
			resolve("notify", {
				RYU_NOTIFY_API_KEY: "k",
				RYU_NOTIFY_URL: "not a url",
			})
		);
		expect(error.code).toBe("invalid_url");
	});

	test("empty or whitespace constructor values count as unset", () => {
		const box = configError(() =>
			resolve("box", {}, { box: { apiKey: "", baseUrl: "https://box.test" } })
		);
		expect(box.details).toEqual({ missing: ["RYU_BOX_API_KEY"] });
		const mail = configError(() =>
			resolve("mail", {}, { mail: { gatewayKey: "  " } })
		);
		expect(mail.code).toBe(box.code);
		const managed = configError(() =>
			resolve("managedAgents", {}, { apiKey: " " })
		);
		expect(managed.details).toEqual({ missing: ["RYU_API_KEY"] });
		// A blank option falls back to env instead of masking it.
		const notify = resolve(
			"notify",
			{
				RYU_NOTIFY_API_KEY: "env_key",
				RYU_NOTIFY_URL: "https://notify.test",
			},
			{ notify: { apiKey: "", baseUrl: " " } }
		);
		expect(notify.apiKey).toBe("env_key");
		expect(notify.baseUrl).toBe("https://notify.test");
		const trimmed = resolve(
			"connect",
			{},
			{
				connect: {
					apiKey: " key ",
					baseUrl: "https://connect.test",
					managementKey: "",
				},
			}
		);
		expect(trimmed.apiKey).toBe("key");
		expect(trimmed.managementKey).toBeNull();
	});
});

describe("env reader", () => {
	test("env: false reads nothing; blank values count as unset", () => {
		expect(createEnvReader(false)("PATH")).toBeUndefined();
		const read = createEnvReader({ A: "  ", B: " value " });
		expect(read("A")).toBeUndefined();
		expect(read("B")).toBe("value");
	});

	test("the default reads process.env", () => {
		process.env.RYU_SERVICES_CONFIG_TEST = "yes";
		try {
			expect(createEnvReader(undefined)("RYU_SERVICES_CONFIG_TEST")).toBe(
				"yes"
			);
		} finally {
			Reflect.deleteProperty(process.env, "RYU_SERVICES_CONFIG_TEST");
		}
	});
});

describe("ENV_VARS and AVAILABILITY", () => {
	test("no RYU_MANAGED_AGENTS_* names, unique names, every service covered", () => {
		const names = ENV_VARS.map((row) => row.name);
		expect(
			names.filter((name) => name.startsWith("RYU_MANAGED_AGENTS_"))
		).toEqual([]);
		// Messaging reuses the control-plane rows, so a name is unique per service.
		const keys = ENV_VARS.map((row) => `${row.service}:${row.name}`);
		expect(new Set(keys).size).toBe(keys.length);
		expect(
			ENV_VARS.filter((row) => row.service === "messaging").map(
				(row) => row.name
			)
		).toEqual(["RYU_API_URL", "RYU_API_KEY", "RYU_ORGANIZATION_ID"]);
		expect(
			new Set(
				ENV_VARS.filter((row) => row.service !== "messaging").map(
					(row) => row.name
				)
			).size
		).toBe(ENV_VARS.filter((row) => row.service !== "messaging").length);
		expect(new Set(ENV_VARS.map((row) => row.service))).toEqual(
			new Set(SERVICES)
		);
		expect(names).toContain("RYU_GATEWAY_URL");
		expect(names).toContain("RYU_GATEWAY_TOKEN");
	});

	test("every env var the resolver reads is documented", () => {
		const read = new Set<string>();
		const env = createEnvReader({});
		const spy = (name: string) => {
			read.add(name);
			return env(name);
		};
		for (const service of SERVICES) {
			try {
				resolveServiceConfig(service, {}, spy);
			} catch {
				// Missing config is expected; only the names matter here.
			}
		}
		const documented = new Set(ENV_VARS.map((row) => row.name));
		for (const name of read) {
			expect(documented.has(name)).toBe(true);
		}
	});

	test("AVAILABILITY labels every service and no other", () => {
		expect(Object.keys(AVAILABILITY).sort()).toEqual([...SERVICES].sort());
		expect(AVAILABILITY.managedAgents).toStartWith("Preview");
		// The published ryu-sites mirror (0.4.0) has no standalone mode; the
		// docs carry the same gate in a callout (standalone-sdk-docs.test.ts).
		expect(AVAILABILITY.sites).toContain(
			"standalone mode needs a ryu-sites release after 0.4.0"
		);
	});
});

describe("browser guard", () => {
	const browser = {
		document: {},
		navigator: { userAgent: "Mozilla/5.0" },
		window: {},
	};

	test("a key in a browser throws unless dangerouslyAllowBrowser is set", () => {
		const error = configError(() =>
			assertBrowserSafe({ notify: { apiKey: "k" } }, browser)
		);
		expect(error.code).toBe("browser_key_exposure");
		expect(error.service).toBe("notify");
		expect(() =>
			assertBrowserSafe(
				{ dangerouslyAllowBrowser: true, notify: { apiKey: "k" } },
				browser
			)
		).not.toThrow();
		expect(() => assertBrowserSafe({}, browser)).not.toThrow();
	});

	test("a key in an env object passed to the constructor is guarded too", () => {
		const error = configError(() =>
			assertBrowserSafe(
				{ env: { RYU_NOTIFY_API_KEY: "k", RYU_NOTIFY_URL: "https://n" } },
				browser
			)
		);
		expect(error.code).toBe("browser_key_exposure");
		expect(error.service).toBe("notify");
		expect(() =>
			assertBrowserSafe({ env: { RYU_NOTIFY_URL: "https://n" } }, browser)
		).not.toThrow();
	});

	test("web and service workers count as browsers", () => {
		const worker = {
			importScripts: () => undefined,
			navigator: { userAgent: "Mozilla/5.0" },
		};
		expect(
			configError(() => assertBrowserSafe({ box: { apiKey: "k" } }, worker))
				.code
		).toBe("browser_key_exposure");
	});

	test("server runtimes are never blocked", () => {
		expect(() =>
			assertBrowserSafe(
				{ apiKey: "ryu_k" },
				{ process: { versions: { node: "22.0.0" } } }
			)
		).not.toThrow();
		expect(() => assertBrowserSafe({ apiKey: "ryu_k" })).not.toThrow();
	});
});

describe("default origins are exported", () => {
	test("the package entry point re-exports the hosted Box and Notify defaults", async () => {
		const entry = await import("./index.ts");
		expect(entry.DEFAULT_BOX_URL).toBe("https://box.ryuhq.com");
		expect(entry.DEFAULT_NOTIFY_URL).toBe("https://notify.ryuhq.com");
		expect(entry.DEFAULT_GATEWAY_URL).toBe(DEFAULT_GATEWAY_URL);
	});
});

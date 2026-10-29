import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let pilotFlag: boolean | null = true;
mock.module("@/src/lib/feature-flags.ts", () => ({
	readFeatureFlag: () => pilotFlag,
}));

const { rememberInstalledTemplate, reportTemplateUse } = await import(
	"./template-rewards.ts"
);

const originalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;
const requests: { body: string; url: string }[] = [];
let responseStatus = 200;

function storage(): Storage {
	const values = new Map<string, string>();
	return {
		clear: () => values.clear(),
		get length() {
			return values.size;
		},
		key: (index: number) => Array.from(values.keys())[index] ?? null,
		getItem: (key: string) => values.get(key) ?? null,
		removeItem: (key: string) => values.delete(key),
		setItem: (key: string, value: string) => values.set(key, value),
	};
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("template rewards reporter", () => {
	beforeEach(() => {
		pilotFlag = true;
		responseStatus = 200;
		requests.length = 0;
		globalThis.localStorage = storage();
		globalThis.localStorage.setItem("ryu_session_token", "token");
		globalThis.fetch = Object.assign(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				// The auth client probes its session on import; only count reports.
				if (url.endsWith("/api/template-rewards/usage")) {
					requests.push({
						url,
						body: typeof init?.body === "string" ? init.body : "",
					});
				}
				return Promise.resolve(new Response("{}", { status: responseStatus }));
			},
			{ preconnect: originalFetch.preconnect }
		);
	});

	afterEach(() => {
		globalThis.localStorage = originalStorage;
		globalThis.fetch = originalFetch;
	});

	test("reports an installed listing once per day", async () => {
		rememberInstalledTemplate("agent_local", "research-agent");
		reportTemplateUse("agent_local");
		await flush();
		reportTemplateUse("agent_local");
		await flush();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toEndWith("/api/template-rewards/usage");
		expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
			items: [{ kind: "agent", itemId: "research-agent" }],
		});
	});

	test("stays silent for unknown agents, signed-out users, or the flag off", async () => {
		rememberInstalledTemplate("agent_local", "research-agent");
		reportTemplateUse("agent_hand_made");
		pilotFlag = null;
		reportTemplateUse("agent_local");
		pilotFlag = true;
		globalThis.localStorage.removeItem("ryu_session_token");
		reportTemplateUse("agent_local");
		await flush();
		expect(requests).toHaveLength(0);
	});

	test("retries on a later turn when the report failed", async () => {
		rememberInstalledTemplate("agent_local", "research-agent");
		responseStatus = 503;
		reportTemplateUse("agent_local");
		await flush();
		responseStatus = 200;
		reportTemplateUse("agent_local");
		await flush();
		expect(requests).toHaveLength(2);
	});
});

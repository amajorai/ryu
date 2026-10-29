import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { configureGatewayProviderAccount } from "@/src/lib/api/gateway.ts";
import { useGatewayProviderConfig } from "./useGatewayProviderConfig.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const nodeA: ApiTarget = {
	url: "http://node-a.test",
	token: null,
	userJwt: null,
};
const nodeB: ApiTarget = {
	url: "http://node-b.test",
	token: null,
	userJwt: null,
};
let activeNode = nodeA;
const getActiveNode = () => activeNode;
let latest: ReturnType<typeof useGatewayProviderConfig> | null = null;
function Probe({ target, open = true }: { target: ApiTarget; open?: boolean }) {
	latest = useGatewayProviderConfig({
		target,
		open,
		reachable: true,
		getActiveNode,
	});
	return null;
}
function current() {
	if (!latest) {
		throw new Error("Provider configuration hook did not mount");
	}
	return latest;
}
function response(revision: string, count: number) {
	return Response.json({
		// The gateway's config view always carries its redacted auth section.
		auth: { require_auth: false, api_keys: [] },
		configRevision: revision,
		providers: {
			openai: {
				api_key: "***",
				base_url: "https://openai.invalid",
				api_key_count: count,
			},
			// The gateway serializes every core provider slot, unset ones as null.
			anthropic: null,
			core: null,
			genai: null,
			local: null,
			openrouter: null,
			accounts: {
				openai: Array.from({ length: count }, (_, index) => ({
					id: String(index + 1).repeat(64),
					name: `Account ${index + 1}`,
					enabled: true,
					priority: index,
				})),
			},
		},
	});
}

test("opening loads saved accounts and revision, while node switches reject delayed old snapshots", async () => {
	const originalFetch = globalThis.fetch;
	const pending: {
		url: string;
		signal: AbortSignal | null | undefined;
		resolve: (value: Response) => void;
	}[] = [];
	const writes: unknown[] = [];
	const fetchMock = mock(
		(...args: Parameters<typeof fetch>): Promise<Response> => {
			if (args[1]?.method === "PUT") {
				writes.push(JSON.parse(String(args[1].body)));
				return Promise.resolve(
					Response.json({
						success: true,
						accountsApplied: true,
						gateway_restarted: false,
					})
				);
			}
			return new Promise((resolve) =>
				pending.push({ url: String(args[0]), signal: args[1]?.signal, resolve })
			);
		}
	);
	globalThis.fetch = Object.assign(fetchMock, { preconnect: () => undefined });
	const root = createRoot(document.createElement("div"));
	try {
		await act(async () => {
			root.render(<Probe target={nodeA} />);
		});
		expect(pending[0]?.url).toBe("http://node-a.test/api/gateway/config");
		expect(current().providers).toBeNull();
		await act(async () => {
			pending[0]?.resolve(response("a".repeat(64), 2));
		});
		expect(current().providers?.accounts?.openai).toHaveLength(2);
		expect(current().revision).toBe("a".repeat(64));
		const account = current().providers?.accounts?.openai?.[0];
		if (!account) {
			throw new Error("Initial authoritative account was not loaded");
		}
		await configureGatewayProviderAccount(
			nodeA,
			"openai",
			account,
			current().revision ?? undefined
		);
		expect(writes[0]).toEqual(
			expect.objectContaining({
				accountId: account.id,
				expectedRevision: "a".repeat(64),
			})
		);
		let oldRefresh: Promise<void> | undefined;
		await act(async () => {
			oldRefresh = current().refresh();
		});
		activeNode = nodeB;
		await act(async () => {
			root.render(<Probe target={nodeB} />);
		});
		expect(pending[1]?.signal?.aborted).toBe(true);
		expect(current().providers).toBeNull();
		expect(current().revision).toBeNull();
		await act(async () => {
			pending[1]?.resolve(response("c".repeat(64), 3));
			await oldRefresh;
		});
		expect(current().providers).toBeNull();
		await act(async () => {
			pending[2]?.resolve(response("b".repeat(64), 1));
		});
		expect(current().providers?.accounts?.openai).toHaveLength(1);
		expect(current().revision).toBe("b".repeat(64));
		await act(async () => {
			root.render(<Probe open={false} target={nodeB} />);
		});
		expect(current().providers).toBeNull();
		expect(pending[2]?.signal?.aborted).toBe(true);
	} finally {
		await act(() => root.unmount());
		globalThis.fetch = originalFetch;
		activeNode = nodeA;
	}
});

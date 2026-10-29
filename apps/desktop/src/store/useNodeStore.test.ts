import { createFetchFixture } from "../test-fixtures/native-fetch-fixture.ts";
// apps/desktop/src/store/useNodeStore.test.ts
//
// Tests for per-tab node routing — the primitive that lets each desktop tab
// talk to a different connected node. `useActiveNode()` resolves a tab's node
// by calling `getActiveNode(tabId)`, and the tab context menu writes the
// override with `setTabOverride(tabId, name)`. Both must agree on the SAME tab
// id; an earlier bug had the chat page mint its own random id, so overrides
// written against the real tab id were never read. The regression case below
// locks that contract.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ManagedNode } from "@/src/lib/api/managed-nodes.ts";
import type { Node } from "./useNodeStore.ts";

// The store's non-test-relevant managed-node fetcher reaches the control-plane
// auth client. Stub that boundary and load the store dynamically afterwards, so
// these tests exercise the routing behavior without a network dependency.
// Mutable so a test can decide what the control plane "returns" for this run;
// the module factory only ever runs once, so the indirection is what makes the
// managed-node path testable at all.
type ManagedNodeFixture = Pick<ManagedNode, "name" | "userJwt" | "url"> &
	Partial<Pick<ManagedNode, "orgId" | "serverId">>;
let managedNodes: ManagedNodeFixture[] | null = [];
mock.module("@/src/lib/api/managed-nodes.ts", () => ({
	fetchManagedNodes: () => Promise.resolve(managedNodes),
}));
const { useNodeStore, stopAutoSelectProbe, stopCloudTokenRefresh } =
	await import("./useNodeStore.ts");

const LOCAL: Node = {
	name: "local",
	url: "http://127.0.0.1:7980",
	token: null,
	userJwt: null,
};
const REMOTE: Node = {
	name: "remote",
	url: "http://10.0.0.5:7980",
	token: "t",
	userJwt: null,
};
const REMOTE_B: Node = {
	name: "remote-b",
	url: "http://10.0.0.6:7980",
	token: "t",
	userJwt: null,
};

beforeEach(() => {
	useNodeStore.setState({
		nodes: [LOCAL, REMOTE],
		defaultNode: "local",
		tabOverrides: {},
	});
});

afterEach(() => {
	useNodeStore.setState({
		nodes: [LOCAL],
		defaultNode: "local",
		tabOverrides: {},
	});
});

describe("per-tab node routing", () => {
	test("no override resolves to the default node", () => {
		const { getActiveNode } = useNodeStore.getState();
		expect(getActiveNode().name).toBe("local");
		expect(getActiveNode("tab-A").name).toBe("local");
	});

	test("an override routes only the overridden tab to its node", () => {
		useNodeStore.getState().setTabOverride("tab-A", "remote");
		const { getActiveNode } = useNodeStore.getState();

		// The overridden tab resolves to the remote node...
		expect(getActiveNode("tab-A")).toEqual(REMOTE);
		// ...while another tab and the default getter stay on local.
		expect(getActiveNode("tab-B").name).toBe("local");
		expect(getActiveNode().name).toBe("local");
	});

	test("two tabs can target two different nodes at once", () => {
		const s = useNodeStore.getState();
		s.setTabOverride("tab-A", "remote");
		s.setTabOverride("tab-B", "local");
		const { getActiveNode } = useNodeStore.getState();
		expect(getActiveNode("tab-A").url).toBe(REMOTE.url);
		expect(getActiveNode("tab-B").url).toBe(LOCAL.url);
		expect(getActiveNode("tab-A").url).not.toBe(getActiveNode("tab-B").url);
	});

	test("clearing an override reverts the tab to the default node", () => {
		useNodeStore.getState().setTabOverride("tab-A", "remote");
		expect(useNodeStore.getState().getActiveNode("tab-A").name).toBe("remote");

		useNodeStore.getState().clearTabOverride("tab-A");
		expect(useNodeStore.getState().getActiveNode("tab-A").name).toBe("local");
	});

	test("regression: reader and writer must use the same tab id", () => {
		// Writer pins the real tab id; the old bug read against a different
		// (randomly minted) id, so the override silently never applied.
		useNodeStore.getState().setTabOverride("tab-real", "remote");
		const { getActiveNode } = useNodeStore.getState();

		expect(getActiveNode("tab-real").name).toBe("remote"); // correct wiring
		expect(getActiveNode("tab-random").name).toBe("local"); // old broken wiring
	});

	test("an override pointing at a removed node falls back to local", () => {
		useNodeStore.getState().setTabOverride("tab-A", "ghost");
		expect(useNodeStore.getState().getActiveNode("tab-A").name).toBe("local");
	});
});

// Auto node selection (M10): "a client prefers a reachable REMOTE node, else
// local compute." The store models a PERSISTED opt-in flag; the node picker's
// switch writes it and a periodic probe keeps the pick honest. Two properties are
// under test: the local-first safety rule (while the flag is OFF the selection
// path — and the network — must be untouched) and the remote-first policy (while
// it is ON, a reachable remote must beat a reachable local, or the toggle is a
// no-op on every normal install).
describe("auto node selection", () => {
	const originalFetch = globalThis.fetch;

	/**
	 * Swap in a fetch that only answers for the `reachable` URL prefix(es),
	 * counting every call. `null` = nothing on the network answers.
	 */
	function stubFetch(reachable: string | string[] | null): () => number {
		let calls = 0;
		const up = reachable === null ? [] : [reachable].flat();
		globalThis.fetch = createFetchFixture(
			originalFetch,
			(input: RequestInfo | URL) => {
				calls += 1;
				const url = String(input);
				if (up.some((prefix) => url.startsWith(prefix))) {
					return Promise.resolve(new Response(null, { status: 200 }));
				}
				return Promise.reject(new Error("unreachable"));
			}
		);
		return () => calls;
	}

	afterEach(() => {
		// A leaked interval would keep the runner alive and probe across tests.
		stopAutoSelectProbe();
		globalThis.fetch = originalFetch;
		useNodeStore.setState({ autoSelect: false, autoSelectedNode: null });
	});

	test("OFF (the default): selection is byte-identical to the manual default", () => {
		// Even with a stale pick sitting in state, an OFF flag must never consult it.
		useNodeStore.setState({ autoSelect: false, autoSelectedNode: "remote" });
		const { getActiveNode } = useNodeStore.getState();

		expect(getActiveNode()).toEqual(LOCAL);
		expect(getActiveNode("tab-A")).toEqual(LOCAL);
	});

	test("OFF: a probe tick is inert and never touches the network", async () => {
		const calls = stubFetch(REMOTE.url);
		useNodeStore.setState({ autoSelect: false, autoSelectedNode: null });

		// This is the body the interval runs; while OFF it must do nothing at all.
		await useNodeStore.getState().probeAutoSelect();

		expect(calls()).toBe(0);
		expect(useNodeStore.getState().autoSelectedNode).toBeNull();
	});

	test("public reachability probes never forward node credentials", async () => {
		const probes: RequestInit[] = [];
		globalThis.fetch = createFetchFixture(
			originalFetch,
			(_input: RequestInfo | URL, init?: RequestInit) => {
				probes.push(init ?? {});
				return Promise.resolve(new Response(null, { status: 200 }));
			}
		);
		useNodeStore.setState({
			nodes: [{ ...REMOTE, userJwt: "node-bound-delegation" }],
			defaultNode: REMOTE.name,
			autoSelect: true,
			autoSelectedNode: null,
		});

		await useNodeStore.getState().probeAutoSelect();

		expect(probes).toHaveLength(1);
		const headers = new Headers(probes[0]?.headers);
		expect(headers.get("Authorization") ?? undefined).toBeUndefined();
		expect(headers.get("x-ryu-user-jwt") ?? undefined).toBeUndefined();
	});

	test("ON: an unreachable default falls through to a reachable remote", async () => {
		// Only the remote answers; the manual default (local) is down.
		stubFetch(REMOTE.url);
		useNodeStore.setState({ autoSelect: true, autoSelectedNode: null });

		await useNodeStore.getState().probeAutoSelect();

		expect(useNodeStore.getState().autoSelectedNode).toBe("remote");
		// ...and the pick is what selection actually resolves to.
		expect(useNodeStore.getState().getActiveNode()).toEqual(REMOTE);
	});

	test("ON: a reachable REMOTE beats a reachable local default", async () => {
		// THE case that proves the toggle is not a visual no-op. Both nodes are UP
		// and the manual default is the local one — i.e. a normal, healthy install.
		// The old manual-default-first probe short-circuited on local here and
		// resolved exactly what the OFF path resolves; the spec (M10) says prefer
		// the reachable REMOTE. Stubbing local reachable is load-bearing: with only
		// the remote up, the OLD code also lands on "remote" and this proves nothing.
		stubFetch([LOCAL.url, REMOTE.url]);
		useNodeStore.setState({
			autoSelect: true,
			autoSelectedNode: null,
			defaultNode: "local",
		});

		await useNodeStore.getState().probeAutoSelect();

		expect(useNodeStore.getState().autoSelectedNode).toBe("remote");
		expect(useNodeStore.getState().getActiveNode()).toEqual(REMOTE);
	});

	test("ON: no remote reachable falls back to LOCAL compute", async () => {
		// The "else local compute" half of the policy, with a HEALTHY local (distinct
		// from the nothing-answers case below, where local is down too).
		stubFetch(LOCAL.url);
		useNodeStore.setState({
			autoSelect: true,
			autoSelectedNode: null,
			defaultNode: "local",
		});

		await useNodeStore.getState().probeAutoSelect();

		expect(useNodeStore.getState().autoSelectedNode).toBe("local");
		expect(useNodeStore.getState().getActiveNode()).toEqual(LOCAL);
	});

	test("ON: an explicitly-chosen remote default wins over another reachable remote", async () => {
		// Manual choice still RANKS the remotes: the default remote is probed first
		// even though another remote is equally reachable and listed before it.
		stubFetch([REMOTE.url, REMOTE_B.url]);
		useNodeStore.setState({
			nodes: [LOCAL, REMOTE, REMOTE_B],
			autoSelect: true,
			autoSelectedNode: null,
			defaultNode: "remote-b",
		});

		await useNodeStore.getState().probeAutoSelect();

		expect(useNodeStore.getState().autoSelectedNode).toBe("remote-b");
		expect(useNodeStore.getState().getActiveNode()).toEqual(REMOTE_B);
	});

	test("ON: a manual tab override still beats the remote pick", async () => {
		// Remote-first must never override manual intent: both nodes are up, the
		// probe picks the remote, and a per-tab pin to local still wins for that tab.
		stubFetch([LOCAL.url, REMOTE.url]);
		useNodeStore.setState({ autoSelect: true, autoSelectedNode: null });
		await useNodeStore.getState().probeAutoSelect();
		expect(useNodeStore.getState().autoSelectedNode).toBe("remote");

		useNodeStore.getState().setTabOverride("tab-A", "local");

		expect(useNodeStore.getState().getActiveNode("tab-A")).toEqual(LOCAL);
		expect(useNodeStore.getState().getActiveNode()).toEqual(REMOTE);
	});

	test("ON: a tab override still beats the auto-selected node", async () => {
		stubFetch(REMOTE.url);
		useNodeStore.setState({ autoSelect: true, autoSelectedNode: null });
		await useNodeStore.getState().probeAutoSelect();
		useNodeStore.getState().setTabOverride("tab-A", "local");

		// Manual intent always wins over the probe's preference.
		expect(useNodeStore.getState().getActiveNode("tab-A")).toEqual(LOCAL);
		expect(useNodeStore.getState().getActiveNode()).toEqual(REMOTE);
	});

	test("no reachable node at all fails over to local", async () => {
		stubFetch(null); // nothing answers
		useNodeStore.setState({ autoSelect: true, autoSelectedNode: "remote" });

		await useNodeStore.getState().probeAutoSelect();

		expect(useNodeStore.getState().autoSelectedNode).toBe("local");
		expect(useNodeStore.getState().getActiveNode()).toEqual(LOCAL);
	});

	test("a DOWN remote default fails over to local compute", async () => {
		// The case auto-select exists for, and the one a `defaultNode: "local"`
		// fixture can never catch: the manual default is a remote that is dead.
		// Resolving back to the default here would strand the app on the dead node.
		stubFetch(null); // neither the remote default nor any other remote answers
		useNodeStore.setState({
			autoSelect: true,
			autoSelectedNode: null,
			defaultNode: "remote",
		});

		await useNodeStore.getState().probeAutoSelect();

		expect(useNodeStore.getState().autoSelectedNode).toBe("local");
		expect(useNodeStore.getState().getActiveNode()).toEqual(LOCAL);
	});

	test("opting out clears the pick, and no later tick can re-pick", async () => {
		useNodeStore.setState({ autoSelect: true, autoSelectedNode: "remote" });
		const calls = stubFetch(REMOTE.url);

		useNodeStore.getState().setAutoSelect(false);

		expect(useNodeStore.getState().autoSelect).toBe(false);
		expect(useNodeStore.getState().autoSelectedNode).toBeNull();
		expect(useNodeStore.getState().getActiveNode()).toEqual(LOCAL);

		// Even if a tick somehow outlived the opt-out, its body is inert — so the
		// stopped timer can never resurrect a remote pick behind the user's back.
		await useNodeStore.getState().probeAutoSelect();
		expect(calls()).toBe(0);
		expect(useNodeStore.getState().autoSelectedNode).toBeNull();
	});
});

// A managed (cloud) node authenticates with a SHORT-LIVED (~15 min) user JWT the
// control plane mints per `/nodes` fetch, so the credential an added node holds
// has to be re-adopted on every hydrate — otherwise `refreshCloudTokens` swaps a
// token nobody reads and the node 401s an hour into the session. This also makes
// the web dashboard's tokenless connection string work: the browser holds no node
// secret to put in one, so the token can only arrive this way.
describe("managed cloud node credentials", () => {
	const CLOUD_URL = "http://cloud-1.example.com:7980";

	afterEach(() => {
		// hydrateCloudNodes arms the JWT-refresh timer whenever it finds a cloud
		// node; a leaked interval would keep the test runner alive.
		stopCloudTokenRefresh();
		managedNodes = [];
		useNodeStore.setState({ cloudNodes: [], localNodes: [], nodes: [LOCAL] });
	});

	test("an unadded cloud node is available for zero-setup adoption", async () => {
		useNodeStore.setState({ localNodes: [LOCAL], nodes: [LOCAL] });
		managedNodes = [{ name: "prod", url: CLOUD_URL, userJwt: "jwt-fresh" }];

		await useNodeStore.getState().hydrateCloudNodes();

		const cloud = useNodeStore
			.getState()
			.nodes.find((node) => node.url === CLOUD_URL);
		expect(cloud?.managed).toBe(true);
		expect(cloud?.userJwt).toBe("jwt-fresh");
		expect(useNodeStore.getState().suggestedCloudNodes).toHaveLength(1);
	});

	test("an added cloud node adopts the freshly minted token", async () => {
		// The node as it sits on disk: added from a tokenless connect link, or
		// holding a JWT that has since expired.
		useNodeStore.setState({
			localNodes: [
				LOCAL,
				{ name: "cloud-prod", url: CLOUD_URL, token: null, userJwt: null },
			],
			nodes: [LOCAL],
		});
		managedNodes = [{ name: "prod", url: CLOUD_URL, userJwt: "jwt-fresh" }];

		await useNodeStore.getState().hydrateCloudNodes();

		const added = useNodeStore
			.getState()
			.nodes.find((n) => n.url === CLOUD_URL);
		expect(added?.userJwt).toBe("jwt-fresh");
		expect(added?.managed).toBe(true);
		// It is added, so it must not also be offered as a suggestion.
		expect(useNodeStore.getState().suggestedCloudNodes).toEqual([]);
	});

	test("a self-hosted node's token is never overwritten", async () => {
		useNodeStore.setState({ localNodes: [LOCAL, REMOTE], nodes: [LOCAL] });
		managedNodes = [{ name: "prod", url: CLOUD_URL, userJwt: "jwt-fresh" }];

		await useNodeStore.getState().hydrateCloudNodes();

		const remote = useNodeStore
			.getState()
			.nodes.find((n) => n.name === REMOTE.name);
		expect(remote).toEqual(REMOTE);
	});

	test("a control plane that mints no token leaves the stored one alone", async () => {
		useNodeStore.setState({
			localNodes: [
				{
					name: "cloud-prod",
					url: CLOUD_URL,
					token: "stored-node-token",
					userJwt: null,
				},
			],
			nodes: [LOCAL],
		});
		managedNodes = [{ name: "prod", url: CLOUD_URL, userJwt: null }];

		await useNodeStore.getState().hydrateCloudNodes();

		expect(useNodeStore.getState().nodes[0]?.token).toBe("stored-node-token");
	});

	test("drops a managed node that disappears from the refreshed scope", async () => {
		const stale = {
			managed: true,
			name: "cloud-prod",
			orgId: "org_1",
			token: null,
			url: CLOUD_URL,
			userJwt: "expired-jwt",
		};
		useNodeStore.setState({
			cloudNodes: [stale],
			localNodes: [LOCAL, stale],
			nodes: [LOCAL, stale],
		});
		managedNodes = [];

		await useNodeStore.getState().refreshCloudTokens();

		expect(useNodeStore.getState().cloudNodes).toEqual([]);
		expect(
			useNodeStore.getState().nodes.some((node) => node.url === CLOUD_URL)
		).toBe(false);
	});

	test("retains managed nodes when the scope refresh is unavailable", async () => {
		const stale = {
			managed: true,
			name: "cloud-prod",
			orgId: "org_1",
			token: null,
			url: CLOUD_URL,
			userJwt: "still-valid",
		};
		useNodeStore.setState({
			cloudNodes: [stale],
			localNodes: [LOCAL, stale],
			nodes: [LOCAL, stale],
		});
		managedNodes = null;

		await useNodeStore.getState().refreshCloudTokens();

		expect(useNodeStore.getState().cloudNodes).toEqual([stale]);
		expect(
			useNodeStore.getState().nodes.some((node) => node.url === CLOUD_URL)
		).toBe(true);
	});

	test("adds a newly visible managed node during a successful refresh", async () => {
		const newCloudUrl = "http://cloud-2.example.com:7980";
		const existing = {
			managed: true,
			name: "cloud-prod",
			token: null,
			url: CLOUD_URL,
			userJwt: "still-valid",
		};
		useNodeStore.setState({
			cloudNodes: [existing],
			localNodes: [LOCAL],
			nodes: [LOCAL, existing],
		});
		managedNodes = [{ name: "new", url: newCloudUrl, userJwt: "new-jwt" }];

		await useNodeStore.getState().refreshCloudTokens();

		expect(useNodeStore.getState().cloudNodes).toEqual([
			expect.objectContaining({
				name: "cloud-new",
				url: newCloudUrl,
				userJwt: "new-jwt",
			}),
		]);
		expect(useNodeStore.getState().suggestedCloudNodes[0]?.url).toBe(
			newCloudUrl
		);
	});

	test("clears a legacy managed JWT from the node bearer slot", async () => {
		useNodeStore.setState({
			localNodes: [
				{
					name: "cloud-prod",
					url: CLOUD_URL,
					token: "header.payload.signature",
					userJwt: null,
				},
			],
			nodes: [LOCAL],
		});
		managedNodes = [{ name: "prod", url: CLOUD_URL, userJwt: "jwt-fresh" }];

		await useNodeStore.getState().hydrateCloudNodes();

		const managed = useNodeStore.getState().nodes[0];
		expect(managed?.token).toBeNull();
		expect(managed?.userJwt).toBe("jwt-fresh");
	});

	// A managed node's `orgId`/`serverId` are the ONLY way any desktop surface can
	// address its server row (`/api/servers/orgs/:orgId/servers/:serverId/...`) —
	// the quiet-hour picker reads them off `getActiveNode()`. They arrive on the
	// cloud record, but the display set is built by folding cloud onto the
	// LOCAL record, which Tauri persists with only name/url/token. Spreading the
	// local record alone therefore drops both ids silently, and every surface that
	// needs them reads `undefined` and hides itself: a feature that looks shipped
	// and does nothing. This asserts they survive the fold.
	test("a managed node keeps the ids that address its server row", async () => {
		useNodeStore.setState({
			localNodes: [
				{ name: "cloud-prod", url: CLOUD_URL, token: "stored", userJwt: null },
			],
			nodes: [LOCAL],
		});
		managedNodes = [
			{
				name: "prod",
				url: CLOUD_URL,
				userJwt: "jwt",
				orgId: "org_1",
				serverId: "srv_1",
			},
		];

		await useNodeStore.getState().hydrateCloudNodes();

		const node = useNodeStore.getState().nodes[0];
		expect(node?.managed).toBe(true);
		expect(node?.orgId).toBe("org_1");
		expect(node?.serverId).toBe("srv_1");
	});

	// Adopted and resumed nodes are never linked to a server row, so the control
	// plane sends `serverId: null`. That must arrive as null rather than
	// `undefined`-by-omission or, worse, a leftover id from another node — the
	// picker's whole gate is "hide unless both ids are present".
	test("an unlinked managed node reports no server row rather than a stale one", async () => {
		useNodeStore.setState({
			localNodes: [
				{ name: "cloud-prod", url: CLOUD_URL, token: "stored", userJwt: null },
			],
			nodes: [LOCAL],
		});
		managedNodes = [
			{
				name: "prod",
				url: CLOUD_URL,
				userJwt: "jwt",
				orgId: "org_1",
				serverId: null,
			},
		];

		await useNodeStore.getState().hydrateCloudNodes();

		const node = useNodeStore.getState().nodes[0];
		expect(node?.orgId).toBe("org_1");
		expect(node?.serverId).toBeNull();
	});
});

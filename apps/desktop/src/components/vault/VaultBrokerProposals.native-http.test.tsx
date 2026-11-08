import {
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import type { Root } from "react-dom/client";
import {
	flush,
	installAnimationApis,
	registerDomWithNativeNetworking,
	until,
} from "../settings/unswept-a.test-support.ts";

// The REAL pending-proposals list against a loopback node, opened from a
// tapped proposal notification: the deep link's proposal is highlighted
// until a person decides it, and a link to a proposal that is no longer
// pending says so instead of highlighting nothing.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
registerDomWithNativeNetworking();

const TOKEN = "vault-broker-proposals-node-token";
const EXPIRES = "2026-10-20T12:00:00.000Z";

interface Proposal {
	createdAt: string;
	credentials: { ref: string }[];
	environment: string;
	expiresAt: string;
	id: string;
	message: string;
	requestedBy: string;
	services: { host?: string; name?: string }[];
	status: "approved" | "pending" | "rejected";
}

function proposal(id: string, message: string): Proposal {
	return {
		createdAt: EXPIRES,
		credentials: [{ ref: "secret:LINEAR_TOKEN" }],
		environment: "dev",
		expiresAt: EXPIRES,
		id,
		message,
		requestedBy: "runtime:acp",
		services: [{ host: "api.linear.app", name: "linear" }],
		status: "pending",
	};
}

let proposals: Proposal[] = [];
let unexpected: string[] = [];

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}${url.search}`;
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			unexpected.push(`unauthenticated ${route}`);
			return NativeResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		if (route === "GET /api/vault/broker/proposals?status=pending") {
			return NativeResponse.json({
				proposals: proposals.filter((row) => row.status === "pending"),
			});
		}
		const decided =
			/^POST \/api\/vault\/broker\/proposals\/([^/?]+)\/approve$/.exec(route);
		const row = proposals.find((p) => p.id === decided?.[1]);
		if (!row) {
			unexpected.push(route);
			return NativeResponse.json({ error: "Undeclared" }, { status: 404 });
		}
		row.status = "approved";
		return NativeResponse.json({ ok: true });
	},
});
const target = {
	token: TOKEN,
	url: `http://127.0.0.1:${server.port}`,
	userJwt: null,
};

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { BrokerProposals } = await import("./VaultBrokerProposals.tsx");
const { clearVaultFocus, getVaultFocus, requestVaultFocus } = await import(
	"@/src/lib/vault-focus.ts"
);
installAnimationApis();

let root: Root | null = null;

async function mount(): Promise<void> {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<BrokerProposals target={target} />
			</QueryClientProvider>
		)
	);
	await until(
		() => document.querySelector('[data-slot="skeleton-rows"]') === null,
		"proposals settled"
	);
	await flush(4);
}

function row(id: string): HTMLElement {
	const found = document.querySelector<HTMLElement>(
		`[data-proposal-id="${id}"]`
	);
	if (!found) {
		throw new Error(`No proposal row ${id}`);
	}
	return found;
}

beforeEach(() => {
	proposals = [
		proposal("prop_a", "Read GitHub issues"),
		proposal("prop_b", "Read Linear issues"),
	];
	unexpected = [];
	clearVaultFocus();
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	document.body.replaceChildren();
});

test("the linked proposal is highlighted until a person decides it", async () => {
	requestVaultFocus({ tab: "broker", proposalId: "prop_b" });
	await mount();
	expect(row("prop_b").getAttribute("aria-current")).toBe("true");
	expect(row("prop_a").getAttribute("aria-current")).toBeNull();
	expect(document.querySelector('[role="status"]')).toBeNull();

	const approve = [...row("prop_b").querySelectorAll("button")].find(
		(control) => control.textContent?.includes("Approve")
	);
	await act(async () => approve?.click());
	await until(
		() => document.querySelector('[data-proposal-id="prop_b"]') === null,
		"decided proposal left the list"
	);
	expect(getVaultFocus()).toBeNull();
	expect(row("prop_a").getAttribute("aria-current")).toBeNull();
	expect(unexpected).toEqual([]);
});

test("a link to a proposal that is no longer pending says so", async () => {
	requestVaultFocus({ tab: "broker", proposalId: "prop_gone" });
	await mount();
	expect(document.querySelector('[role="status"]')?.textContent).toContain(
		"already decided or has expired"
	);
	expect(document.querySelector('[aria-current="true"]')).toBeNull();
	expect(unexpected).toEqual([]);
});

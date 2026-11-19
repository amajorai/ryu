import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import type { Root } from "react-dom/client";
import {
	button,
	click,
	flush,
	installAnimationApis,
	maybeButton,
	openDialogs,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

import {
	MINTED,
	machine,
	nativeFetch,
	node,
	resetNode,
	SECRET_ID,
	server,
	target,
} from "./VaultMachinesPanel.native-http.test-support.ts";

// The REAL Machines tab, AppRole dialog and credentials dialog against a
// loopback node that keeps identities, secret ids and tokens as Core does.
setDefaultTimeout(20_000);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { VaultMachinesPanel } = await import("./VaultMachinesPanel.tsx");
await import("./VaultAppRoleDialog.tsx");
await import("./VaultMachineCredentials.tsx");
await import("./VaultMachineSecretIds.tsx");
await import("./VaultMachineTokens.tsx");
await import("./VaultRevokeButton.tsx");
await import("./VaultShownOnce.tsx");
await import("./use-issue-once.ts");
installAnimationApis();

let root: Root | null = null;
let client: QueryClientType | null = null;
/** Undoes a test's `navigator.clipboard` stub. */
let restoreClipboard: (() => void) | null = null;

async function mount(): Promise<void> {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const queries = client;
	await act(async () =>
		root?.render(
			<QueryClientProvider client={queries}>
				<Toaster />
				<VaultMachinesPanel target={target} />
			</QueryClientProvider>
		)
	);
	await flush(4);
}

async function setValue(id: string, value: string): Promise<void> {
	const element = document.getElementById(id) as
		| HTMLInputElement
		| HTMLSelectElement
		| null;
	if (!element) {
		throw new Error(`No #${id}: ${text()}`);
	}
	const proto =
		element instanceof HTMLSelectElement
			? HTMLSelectElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	await act(async () => {
		setter?.call(element, value);
		element.dispatchEvent(
			new Event(element instanceof HTMLSelectElement ? "change" : "input", {
				bubbles: true,
			})
		);
	});
	await flush(2);
}

function confirms(): HTMLElement[] {
	return [
		...document.querySelectorAll<HTMLElement>('[role="alertdialog"]'),
	].filter((dialog) => !dialog.hasAttribute("data-closed"));
}

/** Close the credentials dialog while a value is shown: it asks first. */
async function closeAnyway(): Promise<void> {
	await click(button("Close", openDialogs()[0]));
	await until(() => confirms().length === 1, "close confirmation");
	await click(button("Close anyway", confirms()[0]));
	await until(() => openDialogs().length === 0, "closed");
}

/** Everything React Query holds (queries and mutations), as text. */
function cached(): string {
	const queries =
		client
			?.getQueryCache()
			.getAll()
			.map((query) => query.state) ?? [];
	const mutations =
		client
			?.getMutationCache()
			.getAll()
			.map((mutation) => mutation.state) ?? [];
	return JSON.stringify([queries, mutations]);
}

beforeEach(resetNode);

afterEach(async () => {
	restoreClipboard?.();
	restoreClipboard = null;
	await act(async () => root?.unmount());
	root = null;
	client = null;
	document.body.replaceChildren();
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	window.fetch = nativeFetch;
});

test("Disable and Delete send nothing until confirmed, say what they leave, then reach Core", async () => {
	await mount();
	await until(() => text().includes("github"), "machines");
	expect(text()).toContain("AppRole");
	expect(text()).toContain("JWT");

	await click(button("Disable ci"));
	await until(() => confirms().length === 1, "confirm");
	expect(text()).toContain("Its tokens are revoked with their child tokens");
	expect(text()).toContain("Its secret IDs are kept");
	expect(text()).toContain("dynamic credential leases they hold");
	expect(node.writes).toEqual([]);
	await click(button("Disable", confirms()[0]));
	await until(() => node.writes.length === 1, "disabled");
	expect(node.writes[0]).toEqual({
		route: "PATCH /api/vault/machines/mid_ci",
		body: { disabled: true },
	});
	await until(() => maybeButton("Enable ci") !== null, "enable offered");
	expect(text()).toContain("Disabled");

	await click(button("Delete github"));
	await until(() => confirms().length === 1, "confirm delete");
	expect(text()).toContain("This cannot be undone.");
	await click(button("Cancel", confirms()[0]));
	await until(() => confirms().length === 0, "cancelled");
	expect(node.writes.length).toBe(1);
	await click(button("Delete github"));
	await until(() => confirms().length === 1, "confirm delete again");
	await click(button("Delete", confirms()[0]));
	await until(() => node.writes.length === 2, "deleted");
	expect(node.writes[1]?.route).toBe("DELETE /api/vault/machines/mid_github");
	await until(() => maybeButton("Delete github") === null, "row gone");
});

test("a bad AppRole name is explained and nothing is sent; a good one opens its credentials", async () => {
	await mount();
	await until(() => text().includes("ci"), "machines");
	await click(button("New AppRole"));
	await until(() => openDialogs().length === 1, "dialog");
	await setValue("approle-name", "Deploy Bot");
	await click(button("Create AppRole", openDialogs()[0]));
	await until(() => text().includes("lowercase letters"), "problem");
	expect(node.writes).toEqual([]);

	await setValue("approle-name", "deploy");
	await setValue("approle-policies", "deploy-read, deploy-read");
	await setValue("approle-ttl", "30m");
	await click(button("Create AppRole", openDialogs()[0]));
	await until(() => text().includes("Role ID role-deploy"), "credentials");
	expect(node.writes[0]).toEqual({
		route: "POST /api/vault/machines",
		body: {
			name: "deploy",
			policies: ["deploy-read"],
			tokenTtlSecs: 1800,
			auth: { kind: "approle" },
		},
	});
});

test("a secret id and a token are shown once, never cached, and gone after the dialog closes", async () => {
	await mount();
	await until(() => text().includes("github"), "machines");
	await click(button("Credentials for ci"));
	await until(() => text().includes("Secret IDs"), "credentials");

	await setValue("machine-secret-id-uses", "0");
	await click(button("Issue secret ID", openDialogs()[0]));
	await until(() => text().includes("1 or more"), "uses problem");
	expect(node.writes).toEqual([]);
	await setValue("machine-secret-id-uses", "1");
	await click(button("Issue secret ID", openDialogs()[0]));
	await until(
		() =>
			(
				document.getElementById(
					"machine-issued-secret-id"
				) as HTMLInputElement | null
			)?.value === SECRET_ID,
		"secret id shown"
	);
	expect(node.writes[0]).toEqual({
		route: "POST /api/vault/machines/mid_ci/secret-ids",
		body: { uses: 1 },
	});

	await setValue("machine-token-role", "deploy");
	await setValue("machine-token-ttl", "1h");
	await click(button("Issue token", openDialogs()[0]));
	await until(
		() =>
			(
				document.getElementById(
					"machine-issued-token"
				) as HTMLInputElement | null
			)?.value === MINTED,
		"token shown"
	);
	expect(node.writes[1]).toEqual({
		route: "POST /api/vault/tokens",
		body: { role: "deploy", ttlSecs: 3600, identity: "mid_ci" },
	});
	await until(() => text().includes("tok-acc"), "token listed");
	expect(cached()).not.toContain(SECRET_ID);
	expect(cached()).not.toContain(MINTED);

	await closeAnyway();
	await click(button("Credentials for ci"));
	await until(() => text().includes("tok-acc"), "reopened");
	expect(document.getElementById("machine-issued-secret-id")).toBeNull();
	expect(document.getElementById("machine-issued-token")).toBeNull();
	expect(document.body.innerHTML).not.toContain(SECRET_ID);
	expect(document.body.innerHTML).not.toContain(MINTED);

	await click(button("Revoke token tok-acc", openDialogs()[0]));
	expect(node.writes.length).toBe(2);
	await click(button("Revoke token tok-acc now", openDialogs()[0]));
	await until(() => node.writes.length === 3, "revoked");
	expect(node.writes[2]?.route).toBe("POST /api/vault/tokens/tok-acc/revoke");
	await until(() => text().includes("No live tokens."), "token gone");
});

test("a JWT identity has no secret ids, and a disabled one offers no new token", async () => {
	node.machines = [machine("github", "jwt", { disabled: true })];
	await mount();
	await until(() => text().includes("github"), "machines");
	await click(button("Credentials for github"));
	await until(() => text().includes("No live tokens."), "credentials");
	expect(text()).not.toContain("Secret IDs");
	expect(text()).toContain("It is disabled");
	const issue = button("Issue token", openDialogs()[0]) as HTMLButtonElement;
	expect(issue.disabled).toBe(true);
});

test("the dialog stays open while a secret id is being issued, then shows it", async () => {
	const { promise, resolve: release } = Promise.withResolvers<void>();
	node.hold = promise;
	await mount();
	await until(() => text().includes("github"), "machines");
	await click(button("Credentials for ci"));
	await until(() => text().includes("Secret IDs"), "credentials");
	await click(button("Issue secret ID", openDialogs()[0]));
	await until(() => node.writes.length === 1, "request sent");
	expect(button("Issue secret ID", openDialogs()[0]).disabled).toBe(true);

	await click(button("Close", openDialogs()[0]));
	await flush(4);
	expect(openDialogs().length).toBe(1);

	release();
	await until(
		() =>
			(
				document.getElementById(
					"machine-issued-secret-id"
				) as HTMLInputElement | null
			)?.value === SECRET_ID,
		"secret id shown after the slow reply"
	);
	expect(document.activeElement?.id).toBe("machine-issued-secret-id");
	await closeAnyway();
});

test("a token validity Core would clamp is refused before anything is sent", async () => {
	await mount();
	await until(() => text().includes("github"), "machines");
	await click(button("Credentials for ci"));
	await until(() => text().includes("Secret IDs"), "credentials");
	await setValue("machine-token-ttl", "7d");
	await click(button("Issue token", openDialogs()[0]));
	await until(() => text().includes("10s to 24h"), "range problem");
	expect(node.writes).toEqual([]);
	const field = document.getElementById("machine-token-ttl");
	expect(field?.getAttribute("aria-describedby")).toBe("machine-token-problem");
});

test("a disable Core could not finish names the stuck lease and still shows the identity disabled", async () => {
	node.stuckLease = "lease_stuck";
	await mount();
	await until(() => text().includes("github"), "machines");
	await click(button("Disable ci"));
	await until(() => confirms().length === 1, "confirm");
	await click(button("Disable", confirms()[0]));
	await until(() => text().includes("lease_stuck"), "error names the lease");
	await until(() => maybeButton("Enable ci") !== null, "list refreshed");
});

async function issueToken(): Promise<void> {
	await click(button("Credentials for ci"));
	await until(() => text().includes("Secret IDs"), "credentials");
	await click(button("Issue token", openDialogs()[0]));
	await until(
		() =>
			(
				document.getElementById(
					"machine-issued-token"
				) as HTMLInputElement | null
			)?.value === MINTED,
		"token shown"
	);
}

test("closing with a value on screen asks first; Keep open keeps it", async () => {
	await mount();
	await until(() => text().includes("github"), "machines");
	await issueToken();
	await click(button("Close", openDialogs()[0]));
	await until(() => confirms().length === 1, "close confirmation");
	expect(text()).toContain("is not shown again");
	await click(button("Keep open", confirms()[0]));
	await until(() => confirms().length === 0, "kept");
	// Escape asks the same question instead of dropping the value.
	await act(async () => {
		(document.activeElement ?? document.body).dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
	await until(() => confirms().length === 1, "escape asks first");
	await click(button("Keep open", confirms()[0]));
	await until(() => confirms().length === 0, "kept after escape");
	expect(
		(document.getElementById("machine-issued-token") as HTMLInputElement).value
	).toBe(MINTED);
	// Done dismisses it; closing then needs no confirmation, and focus is back
	// on the button that issued it.
	await click(button("Done", openDialogs()[0]));
	await until(
		() => document.activeElement === button("Issue token", openDialogs()[0]),
		"focus returned"
	);
	await click(button("Close", openDialogs()[0]));
	await until(() => openDialogs().length === 0, "closed without asking");
	expect(confirms()).toEqual([]);
});

test("copy writes the value to the clipboard and says so when it cannot", async () => {
	const copied: string[] = [];
	let refuse = false;
	const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	restoreClipboard = () => {
		if (original) {
			Object.defineProperty(navigator, "clipboard", original);
		} else {
			Reflect.deleteProperty(navigator, "clipboard");
		}
	};
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: (value: string) => {
				if (refuse) {
					return Promise.reject(new Error("denied"));
				}
				copied.push(value);
				return Promise.resolve();
			},
		},
	});
	await mount();
	await until(() => text().includes("github"), "machines");
	await issueToken();
	await click(button("Copy New token", openDialogs()[0]));
	await until(() => text().includes("Copied"), "copied toast");
	expect(copied).toEqual([MINTED]);
	refuse = true;
	await click(button("Copy New token", openDialogs()[0]));
	await until(() => text().includes("Could not copy"), "refused toast");
	expect(copied).toEqual([MINTED]);
});

test("a refused revoke, disable or delete says so and changes nothing on screen", async () => {
	node.tokens = [
		{
			accessor: "tok-acc",
			identityId: "mid_ci",
			policies: ["ci-read"],
			role: null,
			createdAt: 1,
			expiresAt: 1_900_000_000_000,
			numUsesRemaining: null,
			revokedAt: null,
		},
	];
	node.failWrites = true;
	await mount();
	await until(() => text().includes("github"), "machines");

	await click(button("Disable ci"));
	await until(() => confirms().length === 1, "confirm disable");
	await click(button("Disable", confirms()[0]));
	await until(() => text().includes("The node said no"), "disable error");
	expect(maybeButton("Disable ci")).not.toBeNull();
	await until(() => confirms().length === 1, "confirm stays open");
	await click(button("Cancel", confirms()[0]));
	await until(() => confirms().length === 0, "cancelled");

	await click(button("Delete github"));
	await until(() => confirms().length === 1, "confirm delete");
	await click(button("Delete", confirms()[0]));
	await until(() => node.writes.length === 2, "delete sent");
	await until(
		() => text().includes("The node said no to DELETE"),
		"delete error"
	);
	await click(button("Cancel", confirms()[0]));
	await until(() => confirms().length === 0, "cancelled delete");
	expect(maybeButton("Delete github")).not.toBeNull();

	await click(button("Credentials for ci"));
	await until(() => text().includes("tok-acc"), "token listed");
	await click(button("Revoke token tok-acc", openDialogs()[0]));
	await click(button("Revoke token tok-acc now", openDialogs()[0]));
	await until(() => node.writes.length === 3, "revoke sent");
	await until(() => text().includes("That did not work"), "revoke error");
	expect(text()).toContain("tok-acc");
	expect(maybeButton("Revoke token tok-acc", openDialogs()[0])).not.toBeNull();
});

test("an identity that drops out mid-issue leaves no stuck state for the next dialog", async () => {
	const { promise, resolve: release } = Promise.withResolvers<void>();
	node.hold = promise;
	await mount();
	await until(() => text().includes("github"), "machines");
	await click(button("Credentials for ci"));
	await until(() => text().includes("Secret IDs"), "credentials");
	await click(button("Issue secret ID", openDialogs()[0]));
	await until(() => node.writes.length === 1, "request sent");

	// Another admin deletes `ci`; the refetch drops it while the issue waits.
	node.machines = node.machines.filter((item) => item.id !== "mid_ci");
	await act(async () => {
		await client?.invalidateQueries();
	});
	await until(() => openDialogs().length === 0, "dialog gone with ci");
	release();
	await flush(4);

	await click(button("Credentials for github"));
	await until(() => text().includes("No live tokens."), "github credentials");
	await click(button("Close", openDialogs()[0]));
	await until(() => openDialogs().length === 0, "closed at once");
	expect(confirms()).toEqual([]);
});

test("an identity that drops out mid-issue and comes back reopens clean", async () => {
	const { promise, resolve: release } = Promise.withResolvers<void>();
	node.hold = promise;
	await mount();
	await until(() => text().includes("github"), "machines");
	await click(button("Credentials for ci"));
	await until(() => text().includes("Secret IDs"), "credentials");
	await click(button("Issue secret ID", openDialogs()[0]));
	await until(() => node.writes.length === 1, "request sent");

	// A refetch briefly omits `ci`, then the next one has it again.
	const all = node.machines;
	node.machines = node.machines.filter((item) => item.id !== "mid_ci");
	await act(async () => {
		await client?.invalidateQueries();
	});
	await until(() => openDialogs().length === 0, "dialog gone with ci");
	release();
	await flush(4);
	node.machines = all;
	await act(async () => {
		await client?.invalidateQueries();
	});
	await until(() => openDialogs().length === 1, "ci back");
	expect(document.getElementById("machine-issued-secret-id")).toBeNull();
	await click(button("Close", openDialogs()[0]));
	await until(() => openDialogs().length === 0, "closed at once");
	expect(confirms()).toEqual([]);
});

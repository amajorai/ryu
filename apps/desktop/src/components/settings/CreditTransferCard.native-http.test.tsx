import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { TransferableView } from "@/src/lib/api/orgs.ts";

// Native loopback control-plane transport and production card/client/auth store.
// Fixture balances prove UI/client request and readback, not real MongoDB transactions.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// The behavior waits remain4500ms; allow cleanup to finish before Bun cancels a test body.
setDefaultTimeout(20_000);
let requests: Array<{
	method: string;
	path: string;
	token: string | null;
	body: unknown;
	idempotencyKey: string | null;
}> = [];
let unexpected: string[] = [];
let rejectedEgress: string[] = [];
let pending = 0;
const pendingTransports = new Set<object>();
let refuseReads = false;
let refuseTransfer = false;
// Commit the next transfer, then answer 503 as if the response were lost.
let loseNextTransferResponse = false;
// Mirrors the server's durable ref: the key bound to source, destination and amount.
let committedTransfers = new Map<string, unknown>();
let holdStepUp = false;
let refuseStepUpCode: number | null = null;
let releaseStepUp: (() => void) | null = null;
interface HeldRead {
	arrived: boolean;
	code: number;
	release?: () => void;
	token: string;
}
let holds: HeldRead[] = [];
let views = new Map<string, TransferableView>();
let destinationWallets = new Map<
	string,
	NonNullable<TransferableView["source"]>
>();
const bearer = (account: string) => `Bearer credit-session-${account}`;
function initialView(account: string): TransferableView {
	const from = `${account}-personal`;
	const to = `${account}-team`;
	return {
		orgs: [
			{
				id: from,
				name: `${account} Personal`,
				slug: from,
				role: "owner",
				canSendFrom: true,
				isPersonal: true,
			},
			{
				id: to,
				name: `${account} Team`,
				slug: to,
				role: "admin",
				canSendFrom: true,
				isPersonal: false,
			},
		],
		source: {
			orgId: from,
			topupMicroUsd: 5_000_000,
			grants: [
				{
					id: `${account}-grant`,
					pool: "bedrock",
					originalMicroUsd: 3_000_000,
					remainingMicroUsd: 3_000_000,
					expiresAt: null,
				},
			],
		},
	};
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const token = request.headers.get("authorization");
		const account =
			token === bearer("A") ? "A" : token === bearer("B") ? "B" : null;
		const body = request.method === "POST" ? await request.json() : null;
		requests.push({
			method: request.method,
			path: url.pathname + url.search,
			token,
			body,
			idempotencyKey: request.headers.get("idempotency-key"),
		});
		if (!account) {
			unexpected.push("Unadmitted bearer");
			return NativeResponse.json(
				{ error: "Unadmitted bearer" },
				{ status: 401 }
			);
		}
		// Better Auth's real shared-storage observer refreshes this exact session route.
		if (
			request.method === "GET" &&
			url.pathname === "/api/auth/get-session" &&
			!url.search
		) {
			const timestamp = "2026-10-09T00:00:00.000Z";
			return NativeResponse.json({
				session: {
					id: `credit-session-${account}`,
					token: `credit-session-${account}`,
					userId: `credit-user-${account}`,
					activeOrganizationId: `${account}-personal`,
					activeTeamId: null,
					createdAt: timestamp,
					updatedAt: timestamp,
					expiresAt: "2027-10-01T00:00:00.000Z",
				},
				user: {
					id: `credit-user-${account}`,
					name: `Credit User ${account}`,
					email: `${account.toLowerCase()}@credit.example.test`,
					emailVerified: true,
					image: null,
					createdAt: timestamp,
					updatedAt: timestamp,
				},
			});
		}
		if (
			request.method === "GET" &&
			url.pathname === "/api/credits/transferable" &&
			[...url.searchParams.keys()].every((k) => k === "orgId")
		) {
			const view = structuredClone(views.get(account));
			if (!view) {
				throw new Error("Missing independent account fixture");
			}
			const source = url.searchParams.get("orgId");
			if (source === `${account}-team`) {
				view.source = structuredClone(destinationWallets.get(account)!);
			}
			if (source && !view.orgs.some((org) => org.id === source)) {
				return NativeResponse.json(
					{ error: "Foreign source workspace" },
					{ status: 403 }
				);
			}
			const held = holds.find((h) => h.token === token && !h.arrived);
			const code = held?.code ?? (refuseReads ? 403 : 200);
			if (held) {
				held.arrived = true;
				await new Promise<void>((resolve) => {
					held.release = resolve;
				});
			}
			return code === 200
				? NativeResponse.json(view)
				: NativeResponse.json(
						{ error: "Transferable credits refused" },
						{ status: code }
					);
		}
		if (
			request.method === "GET" &&
			url.pathname === "/api/step-up/status" &&
			url.search === "?scope=billing"
		) {
			if (holdStepUp && account === "A") {
				holdStepUp = false;
				await new Promise<void>((resolve) => {
					releaseStepUp = resolve;
				});
			}
			if (refuseStepUpCode !== null) {
				return NativeResponse.json(
					{ error: `Billing preflight refused ${refuseStepUpCode}` },
					{ status: refuseStepUpCode }
				);
			}
			return NativeResponse.json({
				scope: "billing",
				action: "Move credits",
				satisfied: true,
				methods: ["totp"],
				enrolmentRequired: false,
				twoFactorEnabled: true,
				windowMs: 300_000,
			});
		}
		if (
			request.method === "POST" &&
			url.pathname === "/api/credits/transfer" &&
			!url.search
		) {
			const view = views.get(account)!;
			const input = body as {
				fromOrgId?: unknown;
				toOrgId?: unknown;
				grantIds?: unknown;
				topupMicroUsd?: unknown;
			};
			if (refuseTransfer) {
				return NativeResponse.json(
					{ error: "Transfer refused" },
					{ status: 403 }
				);
			}
			if (
				!input ||
				Object.keys(input).some(
					(k) =>
						!["fromOrgId", "toOrgId", "grantIds", "topupMicroUsd"].includes(k)
				) ||
				!Array.isArray(input.grantIds) ||
				typeof input.topupMicroUsd !== "number" ||
				!Number.isSafeInteger(input.topupMicroUsd) ||
				input.topupMicroUsd < 0 ||
				!request.headers.get("idempotency-key")
			) {
				unexpected.push("Incorrect transfer SDK payload");
				return NativeResponse.json(
					{ error: "Incorrect transfer payload" },
					{ status: 400 }
				);
			}
			if (
				input.fromOrgId !== `${account}-personal` ||
				input.toOrgId !== `${account}-team`
			) {
				return NativeResponse.json(
					{ error: "Foreign transfer workspace" },
					{ status: 403 }
				);
			}
			const refId = `${request.headers.get("idempotency-key")}:${input.fromOrgId}:${input.toOrgId}:${input.topupMicroUsd}`;
			const replay = committedTransfers.get(refId);
			if (replay) {
				return NativeResponse.json(replay);
			}
			const source = view.source!;
			const grantIds = input.grantIds;
			const moved = source.grants.filter((g) => grantIds.includes(g.id));
			if (input.topupMicroUsd > source.topupMicroUsd) {
				return NativeResponse.json(
					{ error: "Insufficient fixture balance" },
					{ status: 409 }
				);
			}
			source.grants = source.grants.filter((g) => !grantIds.includes(g.id));
			source.topupMicroUsd -= input.topupMicroUsd;
			const destination = destinationWallets.get(account)!;
			destination.grants.push(...structuredClone(moved));
			destination.topupMicroUsd += input.topupMicroUsd;
			const result = {
				ok: true,
				reason: null,
				movedGrantIds: moved.map((g) => g.id),
				movedGrantMicroUsd: moved.reduce(
					(sum, g) => sum + g.remainingMicroUsd,
					0
				),
				movedTopupMicroUsd: input.topupMicroUsd,
			};
			committedTransfers.set(refId, result);
			if (loseNextTransferResponse) {
				loseNextTransferResponse = false;
				return NativeResponse.json(
					{ error: "Gateway timeout after commit" },
					{ status: 503 }
				);
			}
			return NativeResponse.json(result);
		}
		unexpected.push(`${request.method} ${url.pathname}${url.search}`);
		return NativeResponse.json(
			{ error: "Unknown finite owner contract" },
			{ status: 503 }
		);
	},
});
// Set the canonical build-time backend input BEFORE importing production modules.
const previousBackend = process.env.VITE_APP_BACKEND_URL;
process.env.VITE_APP_BACKEND_URL = server.url.origin;
globalThis.fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new NativeRequest(input, init);
		if (new URL(request.url).origin !== server.url.origin) {
			rejectedEgress.push(request.url);
			throw new Error("Unowned credit HTTP origin");
		}
		const transport = {};
		pendingTransports.add(transport);
		pending = pendingTransports.size;
		let consumed = false;
		const settle = () => {
			if (consumed) {
				return;
			}
			consumed = true;
			pendingTransports.delete(transport);
			pending = pendingTransports.size;
		};
		const observe = (response: Response): Response => {
			const text = response.text.bind(response);
			const json = response.json.bind(response);
			const clone = response.clone.bind(response);
			// Delegate original native body methods and clones; count each transport once.
			response.text = async () => {
				try {
					return await text();
				} finally {
					settle();
				}
			};
			response.json = async () => {
				try {
					return await json();
				} finally {
					settle();
				}
			};
			response.clone = () => observe(clone());
			return response;
		};
		try {
			return observe(await nativeFetch(input, init));
		} catch (error) {
			settle();
			throw error;
		}
	},
	{ preconnect: nativeFetch.preconnect }
);
window.fetch = globalThis.fetch;
const { createRoot } = await import("react-dom/client");
const { CreditTransferCard } = await import("./CreditTransferCard.tsx");
const { TOKEN_KEY, BACKEND_URL } = await import("@/lib/auth-client.ts");
const { fetchTransferable } = await import("@/src/lib/api/orgs.ts");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
let root: Root;
let container: HTMLDivElement;
const previousToken = localStorage.getItem(TOKEN_KEY);
async function until(check: () => boolean) {
	const deadline = Date.now() + 4500;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(
				`Credit UI did not settle: ${document.body.textContent}; ${JSON.stringify(requests)}`
			);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}
async function readActualWallet(orgId?: string) {
	let view: Awaited<ReturnType<typeof fetchTransferable>> | undefined;
	await act(async () => {
		view = await fetchTransferable(orgId);
	});
	return view!;
}
async function mount() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<CreditTransferCard />
				<Toaster position="bottom-right" />
			</QueryClientProvider>
		)
	);
}
async function unmountCard() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<Toaster position="bottom-right" />
			</QueryClientProvider>
		)
	);
}
async function account(account: string) {
	await act(async () => {
		const old = localStorage.getItem(TOKEN_KEY);
		localStorage.setItem(TOKEN_KEY, `credit-session-${account}`);
		// The real shared-storage notification another Desktop window receives.
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: TOKEN_KEY,
				oldValue: old,
				newValue: `credit-session-${account}`,
				storageArea: localStorage,
			})
		);
	});
}
async function visible(account: string) {
	await until(() => !!container.querySelector(`#grant-${account}-grant`));
}
async function click(name: string) {
	const button = [...document.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === name
	);
	if (!button) {
		throw new Error(`Production ${name} button absent`);
	}
	await act(async () => button.click());
}
async function setTopup(value: string) {
	const input = container.querySelector<HTMLInputElement>("#transfer-topup")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
}
function moveButton() {
	return [...document.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === "Move credits"
	);
}
async function chooseTeamDestination() {
	const destination = container.querySelector<HTMLElement>("#transfer-dest");
	if (!destination) {
		throw new Error("Production destination selector absent");
	}
	await act(async () => destination.click());
	await until(() =>
		[...document.querySelectorAll('[role="option"]')].some((o) =>
			o.textContent?.includes("A Team")
		)
	);
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((o) => o.textContent?.includes("A Team"))!;
	await act(async () => option.click());
}
async function prepareTransfer() {
	const destination = container.querySelector<HTMLElement>("#transfer-dest");
	if (!destination) {
		throw new Error("Production destination selector absent");
	}
	await act(async () => destination.click());
	await until(() =>
		[...document.querySelectorAll('[role="option"]')].some((o) =>
			o.textContent?.includes("A Team")
		)
	);
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((o) => o.textContent?.includes("A Team"))!;
	await act(async () => option.click());
	const grant = container.querySelector<HTMLElement>("#grant-A-grant")!;
	await act(async () => grant.click());
	const input = container.querySelector<HTMLInputElement>("#transfer-topup")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)!.set!.call(input, "1.25");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
}
beforeEach(async () => {
	// biome-ignore lint/suspicious/noMisplacedAssertion: Every actual test verifies the canonical backend input before HTTP.
	expect(BACKEND_URL).toBe(server.url.origin);
	// biome-ignore lint/suspicious/noMisplacedAssertion: A previous case must have no live transports before another fixture can start.
	expect(pendingTransports.size).toBe(0);
	requests = [];
	unexpected = [];
	rejectedEgress = [];
	holds = [];
	pending = 0;
	refuseReads = false;
	refuseTransfer = false;
	loseNextTransferResponse = false;
	committedTransfers = new Map();
	refuseStepUpCode = null;
	holdStepUp = false;
	releaseStepUp = null;
	views = new Map([
		["A", initialView("A")],
		["B", initialView("B")],
	]);
	destinationWallets = new Map(
		["A", "B"].map((a): [string, NonNullable<TransferableView["source"]>] => [
			a,
			{ orgId: `${a}-team`, grants: [], topupMicroUsd: 0 },
		])
	);
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
		sileo.clear();
	});
	localStorage.setItem(TOKEN_KEY, "credit-session-A");
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	let cleanupError: unknown;
	let unmounted = false;
	try {
		await act(async () => {
			for (const h of holds) {
				h.release?.();
			}
			releaseStepUp?.();
			root.unmount();
			unmounted = true;
			await queryClient.cancelQueries();
			queryClient.clear();
		});
		await until(() => pendingTransports.size === 0);
	} catch (error) {
		cleanupError = error;
	} finally {
		// Failed assertions/transport waits must never leave a previous mounted card.
		await act(async () => {
			if (!unmounted) {
				root.unmount();
			}
			await queryClient.cancelQueries();
			queryClient.clear();
			sileo.clear();
		});
		container.remove();
	}
	if (cleanupError) {
		throw cleanupError;
	}
	// biome-ignore lint/suspicious/noMisplacedAssertion: Every test rejects unknown owner contracts/authentication.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: Every test rejects unowned network access.
	expect(rejectedEgress).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	if (previousBackend === undefined) {
		delete process.env.VITE_APP_BACKEND_URL;
	} else {
		process.env.VITE_APP_BACKEND_URL = previousBackend;
	}
	if (previousToken === null) {
		localStorage.removeItem(TOKEN_KEY);
	} else {
		localStorage.setItem(TOKEN_KEY, previousToken);
	}
});
test("loads authenticated transferable grants and agrees with independent SDK readback", async () => {
	await mount();
	await visible("A");
	const readback = await readActualWallet();
	expect(readback).toEqual(views.get("A")!);
	expect(container.textContent).toContain("A Personal");
	expect(container.textContent).not.toContain("B Personal");
	expect(requests.every((r) => r.token === bearer("A"))).toBe(true);
});
test("current authority read403 stays visible and explicit Retry obtains fresh admitted grants", async () => {
	refuseReads = true;
	await mount();
	await until(
		() =>
			pending === 0 &&
			queryClient
				.getQueryCache()
				.getAll()
				.some((q) => q.state.status === "error") &&
			container.querySelector('[role="alert"]') !== null
	);
	expect(container.querySelector('[role="alert"]')).not.toBeNull();
	expect(container.querySelector("#grant-A-grant")).toBeNull();
	refuseReads = false;
	await click("Retry");
	await visible("A");
	expect(requests.at(-1)?.token).toBe(bearer("A"));
});
test("shared-storage account change drops the prior account's cached grants on remount", async () => {
	await mount();
	await visible("A");
	await unmountCard();
	await account("B");
	await mount();
	await visible("B");
	expect(container.querySelector("#grant-A-grant")).toBeNull();
	expect(requests.some((r) => r.token === bearer("B"))).toBe(true);
});
for (const code of [200, 403]) {
	test(`held retired account read${code} cannot supply the remounted current account`, async () => {
		const held: HeldRead = { token: bearer("A"), code, arrived: false };
		holds.push(held);
		await mount();
		await until(() => held.arrived);
		await unmountCard();
		await account("B");
		await mount();
		await visible("B");
		await act(async () => held.release?.());
		await until(() => pending === 0);
		expect(container.querySelector("#grant-A-grant")).toBeNull();
		expect(container.querySelector("#grant-B-grant")).not.toBeNull();
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});
}
test("moves the selected grant and exact topup through actual step-up and transfer clients, then reads back the changed fixture", async () => {
	await mount();
	await visible("A");
	await prepareTransfer();
	await click("Move credits");
	await until(
		() =>
			requests.some((r) => r.method === "POST") &&
			!container.querySelector("#grant-A-grant")
	);
	const post = requests.find((r) => r.method === "POST")!;
	expect(post).toMatchObject({
		path: "/api/credits/transfer",
		token: bearer("A"),
		body: {
			fromOrgId: "A-personal",
			toOrgId: "A-team",
			grantIds: ["A-grant"],
			topupMicroUsd: 1_250_000,
		},
	});
	expect(
		requests.some(
			(r) =>
				r.path === "/api/step-up/status?scope=billing" &&
				r.token === bearer("A")
		)
	).toBe(true);
	const readback = await readActualWallet("A-personal");
	expect(readback.source?.topupMicroUsd).toBe(3_750_000);
	expect(readback.source?.grants).toEqual([]);
	const destination = await readActualWallet("A-team");
	expect(destination.source?.topupMicroUsd).toBe(1_250_000);
	expect(destination.source?.grants.map((g) => g.id)).toEqual(["A-grant"]);
});
test("refused transfer keeps actual fixture balances and selected inputs available for Retry", async () => {
	await mount();
	await visible("A");
	await prepareTransfer();
	refuseTransfer = true;
	await click("Move credits");
	await until(() => requests.some((r) => r.method === "POST") && pending === 0);
	expect(
		container.querySelector<HTMLInputElement>("#grant-A-grant")?.checked
	).toBe(true);
	expect(
		container.querySelector<HTMLInputElement>("#transfer-topup")?.value
	).toBe("1.25");
	const refused = await readActualWallet("A-personal");
	expect(refused.source?.topupMicroUsd).toBe(5_000_000);
	expect(refused.source?.grants).toHaveLength(1);
	refuseTransfer = false;
	await click("Move credits");
	await until(() => !container.querySelector("#grant-A-grant"));
	const accepted = await readActualWallet("A-personal");
	expect(accepted.source?.topupMicroUsd).toBe(3_750_000);
	expect(accepted.source?.grants).toEqual([]);
});

test("retry after a lost transfer response reuses its idempotency key and moves topup once", async () => {
	await mount();
	await visible("A");
	await prepareTransfer();
	loseNextTransferResponse = true;
	await click("Move credits");
	await until(
		() =>
			document.body.textContent?.includes("Gateway timeout after commit") ===
				true && pending === 0
	);
	// The committed move is read back before the retry, while the draft stays.
	await until(() => !container.querySelector("#grant-A-grant"));
	expect(
		container.querySelector<HTMLInputElement>("#transfer-topup")?.value
	).toBe("1.25");
	await click("Move credits");
	await until(
		() =>
			requests.filter((r) => r.method === "POST").length === 2 &&
			pending === 0 &&
			container.querySelector<HTMLInputElement>("#transfer-topup")?.value === ""
	);
	const [lost, retried] = requests.filter((r) => r.method === "POST");
	expect(lost?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
	expect(retried?.idempotencyKey).toBe(lost?.idempotencyKey ?? "");
	expect(retried?.body).toEqual(lost?.body);
	const source = await readActualWallet("A-personal");
	const destination = await readActualWallet("A-team");
	expect(source.source?.topupMicroUsd).toBe(3_750_000);
	expect(destination.source?.topupMicroUsd).toBe(1_250_000);

	// A new transfer after a confirmed success gets a fresh key.
	const input = container.querySelector<HTMLInputElement>("#transfer-topup")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)!.set!.call(input, "1.25");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await click("Move credits");
	await until(
		() =>
			requests.filter((r) => r.method === "POST").length === 3 &&
			pending === 0 &&
			container.querySelector<HTMLInputElement>("#transfer-topup")?.value === ""
	);
	const next = requests.filter((r) => r.method === "POST")[2];
	expect(next?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
	expect(next?.idempotencyKey).not.toBe(lost?.idempotencyKey ?? "");
	const drained = await readActualWallet("A-personal");
	expect(drained.source?.topupMicroUsd).toBe(2_500_000);
});

test("retired step-up status cannot submit an old transfer after a shared-storage account change", async () => {
	await mount();
	await visible("A");
	await prepareTransfer();
	holdStepUp = true;
	await click("Move credits");
	await until(() => releaseStepUp !== null);
	await unmountCard();
	await account("B");
	// Isolate the money-action race from the separately tested old read-cache bug.
	queryClient.removeQueries({ queryKey: ["credits", "transferable"] });
	await mount();
	await visible("B");
	await act(async () => releaseStepUp?.());
	await until(() => pending === 0);
	const currentReadback = await readActualWallet("B-personal");
	await until(() => pending === 0);
	expect(currentReadback).toEqual(views.get("B")!);
	expect(requests.filter((r) => r.method === "POST")).toEqual([]);
	expect(views.get("A")?.source).toEqual(initialView("A").source);
	expect(views.get("B")?.source).toEqual(initialView("B").source);
	expect(destinationWallets.get("A")?.topupMicroUsd).toBe(0);
	expect(destinationWallets.get("B")?.topupMicroUsd).toBe(0);
	expect(container.querySelector("#grant-B-grant")).not.toBeNull();
	expect(document.body.textContent).not.toContain("Moved ");
});

test("duplicate clicks during held step-up admit one action and move topup once", async () => {
	await mount();
	await visible("A");
	await prepareTransfer();
	holdStepUp = true;
	await click("Move credits");
	await until(() => releaseStepUp !== null);
	await click("Move credits");
	// An independent actual HTTP read advances transport without a blind delay.
	const before = await readActualWallet("A-personal");
	expect(before.source?.topupMicroUsd).toBe(5_000_000);
	expect(
		requests.filter((r) => r.path === "/api/step-up/status?scope=billing")
	).toHaveLength(1);
	expect(requests.filter((r) => r.method === "POST")).toEqual([]);
	await act(async () => releaseStepUp?.());
	await until(
		() => !container.querySelector("#grant-A-grant") && pending === 0
	);
	const posts = requests.filter((r) => r.method === "POST");
	expect(posts).toHaveLength(1);
	expect(posts[0]?.token).toBe(bearer("A"));
	expect(posts[0]?.idempotencyKey).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
	);
	expect(posts[0]?.body).toEqual({
		fromOrgId: "A-personal",
		toOrgId: "A-team",
		grantIds: ["A-grant"],
		topupMicroUsd: 1_250_000,
	});
	const source = await readActualWallet("A-personal");
	const destination = await readActualWallet("A-team");
	expect(source.source?.topupMicroUsd).toBe(3_750_000);
	expect(source.source?.grants).toEqual([]);
	expect(destination.source?.topupMicroUsd).toBe(1_250_000);
	expect(destination.source?.grants.map((g) => g.id)).toEqual(["A-grant"]);
});

for (const code of [403, 503]) {
	test(`current billing preflight ${code} is visibly refused before any transfer and retries the identical draft`, async () => {
		await mount();
		await visible("A");
		await prepareTransfer();
		refuseStepUpCode = code;
		await click("Move credits");
		await until(
			() =>
				document.body.textContent?.includes(
					`Billing preflight refused ${code}`
				) === true && pending === 0
		);
		expect(requests.filter((r) => r.method === "POST")).toEqual([]);
		expect(
			requests.filter((r) => r.path === "/api/step-up/status?scope=billing")
		).toHaveLength(1);
		expect(
			container.querySelector<HTMLInputElement>("#grant-A-grant")?.checked
		).toBe(true);
		expect(
			container.querySelector<HTMLInputElement>("#transfer-topup")?.value
		).toBe("1.25");
		const unchanged = await readActualWallet("A-personal");
		const emptyDestination = await readActualWallet("A-team");
		expect(unchanged.source?.topupMicroUsd).toBe(5_000_000);
		expect(unchanged.source?.grants.map((g) => g.id)).toEqual(["A-grant"]);
		expect(emptyDestination.source?.topupMicroUsd).toBe(0);
		expect(emptyDestination.source?.grants).toEqual([]);
		refuseStepUpCode = null;
		await click("Move credits");
		await until(
			() => !container.querySelector("#grant-A-grant") && pending === 0
		);
		const posts = requests.filter((r) => r.method === "POST");
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({
			token: bearer("A"),
			body: {
				fromOrgId: "A-personal",
				toOrgId: "A-team",
				grantIds: ["A-grant"],
				topupMicroUsd: 1_250_000,
			},
		});
		expect(
			requests.filter((r) => r.path === "/api/step-up/status?scope=billing")
		).toHaveLength(2);
		const source = await readActualWallet("A-personal");
		const destination = await readActualWallet("A-team");
		expect(source.source?.topupMicroUsd).toBe(3_750_000);
		expect(source.source?.grants).toEqual([]);
		expect(destination.source?.topupMicroUsd).toBe(1_250_000);
		expect(destination.source?.grants.map((g) => g.id)).toEqual(["A-grant"]);
	});
}

test("0.00 top-up: more than the workspace holds is refused before any request, an unreadable amount moves nothing, and a top-up alone moves exactly that amount and keeps the grant", async () => {
	await mount();
	await visible("A");
	await chooseTeamDestination();
	expect(
		container.querySelector<HTMLInputElement>("#transfer-topup")?.placeholder
	).toBe("0.00");

	await setTopup("5.01");
	expect(container.textContent).toContain(
		"That is more than this workspace holds."
	);
	expect(moveButton()?.disabled).toBe(true);

	await setTopup("abc");
	expect(container.textContent).not.toContain(
		"That is more than this workspace holds."
	);
	expect(container.textContent).toContain("Nothing selected");
	expect(moveButton()?.disabled).toBe(true);
	expect(requests.filter((r) => r.method === "POST")).toEqual([]);

	await setTopup("2.5");
	expect(moveButton()?.disabled).toBe(false);
	await click("Move credits");
	await until(() => requests.some((r) => r.method === "POST") && pending === 0);
	expect(
		requests.filter((r) => r.method === "POST").map((r) => r.body)
	).toEqual([
		{
			fromOrgId: "A-personal",
			toOrgId: "A-team",
			grantIds: [],
			topupMicroUsd: 2_500_000,
		},
	]);
	const source = await readActualWallet("A-personal");
	const destination = await readActualWallet("A-team");
	expect(source.source?.topupMicroUsd).toBe(2_500_000);
	expect(source.source?.grants.map((g) => g.id)).toEqual(["A-grant"]);
	expect(destination.source?.topupMicroUsd).toBe(2_500_000);
	expect(destination.source?.grants).toEqual([]);
	// Account B's wallets never moved.
	expect(views.get("B")?.source?.topupMicroUsd).toBe(5_000_000);
	expect(destinationWallets.get("B")?.topupMicroUsd).toBe(0);
});

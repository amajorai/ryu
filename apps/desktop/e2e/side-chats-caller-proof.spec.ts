declare const window: Window;

// Shipping Layout/ChatPage caller; only HTTP service responses are local fixtures.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Node, useNodeStore } from "../src/store/useNodeStore.ts";
import {
	type SideChatCodecs,
	type SideChatManifest,
	type SideChatRequest,
	sideChatManifestSchema,
} from "./side-chat-proof.contracts.ts";
import { sideChatCodecScript } from "./side-chat-proof-loader.ts";

type BrowserProofFetch = Window["fetch"] &
	Partial<Pick<typeof fetch, "preconnect">>;

const root = path.resolve(import.meta.dirname, "../../..");
const proof = path.join(
	root,
	"docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/side-chats"
);
const conversationId = "conversation-toolbar-share-fixture";
const question = "What should we review before launch?";
const answer = "Review the organization copy before launch.";
const manifest = sideChatManifestSchema.parse(
	JSON.parse(
		readFileSync(
			path.join(root, "plugins-store/plugins/side-chats/manifest.json"),
			"utf8"
		)
	)
);
const context = [
	{
		role: "user",
		content: "We need to share the launch plan with the organization.",
	},
	{ role: "assistant", content: "The organization copy is ready for review." },
];
interface Call {
	body: SideChatRequest | Record<string, never>;
	method: string;
	path: string;
}
interface Fixture {
	aborted: number;
	calls: Call[];
	mode: "allow" | "deny" | "error" | "pending" | "pending-abort";
	release: (() => void) | null;
}

interface SideChatWindow extends Window {
	__SIDE_CHAT_PROOF_CODECS__: SideChatCodecs;
	__sideChatCallerFixture: Fixture;
	__sideChatNodeFixture: typeof useNodeStore;
}
interface DialogFrame {
	closed: boolean;
	connected: boolean;
	height: number;
	opacity: number;
	slot: string | null;
	width: number;
	x: number;
	y: number;
}
interface DialogGeometry {
	after: DialogFrame[];
	before: DialogFrame[];
	ready: boolean;
}

test.describe.configure({ timeout: 120_000 });

function installSideChatCaller({
	manifest,
	conversationId,
	answer,
}: {
	manifest: SideChatManifest;
	conversationId: string;
	answer: string;
}) {
	// SAFETY: the bundled prefix in this same init script installs these concrete native JSON codecs in this same browser realm.
	const codecs = (window as SideChatWindow).__SIDE_CHAT_PROOF_CODECS__;
	const fixture: Fixture = {
		mode: "allow",
		aborted: 0,
		calls: [],
		release: null,
	};
	Object.defineProperty(window, "__sideChatCallerFixture", {
		value: fixture,
	});
	const key = "ryu-side-chat-caller-proof-entries";
	const wrap = (fallback: BrowserProofFetch): BrowserProofFetch =>
		Object.assign(
			async (
				input: Parameters<Window["fetch"]>[0],
				init?: Parameters<Window["fetch"]>[1]
			) => {
				const url = new URL(
					input instanceof Request ? input.url : String(input),
					location.href
				);
				if (url.pathname === "/api/plugins/contributions") {
					return Response.json(
						Object.fromEntries(
							Object.entries(manifest.contributes).map(([name, entries]) => [
								name,
								entries.map((entry) => ({ ...entry, plugin: manifest.id })),
							])
						)
					);
				}
				if (url.pathname === "/api/preferences/voice-mode-readback") {
					return Response.json({
						key: "voice-mode-readback",
						value: JSON.stringify({ enabled: false }),
					});
				}
				if (url.pathname === "/api/btw" && init?.method === "POST") {
					const body = codecs.sideChatRequestSchema.parse(
						JSON.parse(String(init.body))
					);
					fixture.calls.push({ body, path: url.pathname, method: "POST" });
					const mode = fixture.mode;
					if (mode === "deny") {
						return Response.json(
							{ error: "Side chat access denied" },
							{ status: 403 }
						);
					}
					if (mode === "error") {
						return Response.json(
							{ error: "Side chat service unavailable" },
							{ status: 503 }
						);
					}
					if (mode === "pending" || mode === "pending-abort") {
						await new Promise<void>((resolve, reject) => {
							fixture.release = resolve;
							init.signal?.addEventListener(
								"abort",
								() => {
									fixture.aborted += 1;
									if (mode === "pending-abort") {
										reject(new DOMException("Aborted", "AbortError"));
									}
								},
								{ once: true }
							);
						});
					}
					const entries = codecs.sideChatEntriesSchema.parse(
						JSON.parse(localStorage.getItem(key) ?? "[]")
					);
					const id = `side-chat-${entries.length + 1}`;
					entries.unshift({
						id,
						conversation_id: conversationId,
						question: body.question,
						answer,
						model: "fixture-side-model",
						created_at: 1_724_000_020_000 + entries.length,
					});
					localStorage.setItem(key, JSON.stringify(entries));
					return Response.json({ id, answer, model: "fixture-side-model" });
				}
				if (url.pathname === `/api/conversations/${conversationId}/btw`) {
					fixture.calls.push({ body: {}, path: url.pathname, method: "GET" });
					return Response.json(
						codecs.sideChatEntriesSchema.parse(
							JSON.parse(localStorage.getItem(key) ?? "[]")
						)
					);
				}
				return fallback(input, init);
			},
			{ preconnect: fallback.preconnect }
		);
	// The existing harness assigns its own fixture fetch. Wrap that assignment
	// too, preserving its native/static asset fallback and all other endpoints.
	const nativeFetch = globalThis.fetch;
	let current = wrap(
		Object.assign(nativeFetch.bind(globalThis), {
			preconnect: nativeFetch.preconnect,
		})
	);
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		get: () => current,
		set: (value: Window["fetch"]) => {
			current = wrap(value);
		},
	});
}

test.beforeEach(async ({ page }) => {
	mkdirSync(proof, { recursive: true });
	// One script makes native codec installation precede the fixture consumer;
	// separate Playwright init scripts do not guarantee their execution order.
	await page.addInitScript({
		content: `${await sideChatCodecScript()};\n(${installSideChatCaller.toString()})(${JSON.stringify({ manifest, conversationId, answer })});`,
	});
});

async function setMode(page: Page, mode: Fixture["mode"]) {
	await page.evaluate((mode) => {
		/* SAFETY: this spec installs its concrete caller fixture on the same page before these native observations. */ (
			window as SideChatWindow
		).__sideChatCallerFixture.mode = mode;
	}, mode);
}
async function posts(page: Page) {
	return page.evaluate(() =>
		/* SAFETY: this spec installs its concrete caller fixture on the same page before these native observations. */ (
			window as SideChatWindow
		).__sideChatCallerFixture.calls.filter((call) => call.method === "POST")
	);
}
async function sendCommand(page: Page, input: string) {
	await page.getByPlaceholder("Ask a follow up").first().fill(input);
	await page.getByRole("button", { name: "Send", exact: true }).first().click();
}
async function capture(page: Page, file: string) {
	await page.mouse.move(12, 12);
	// The real shell retires its restored-connection notice after three seconds.
	// Wait for that state transition rather than hiding a rendered notification.
	await expect(
		page.getByText("Connection restored", { exact: true })
	).toBeHidden({ timeout: 10_000 });
	await page.evaluate(async () => {
		const animations = [
			...document.querySelectorAll(
				'[data-slot="dialog-content"], [data-slot="dialog-overlay"]'
			),
		]
			.flatMap((element) => element.getAnimations({ subtree: true }))
			.filter((animation) =>
				Number.isFinite(animation.effect?.getComputedTiming().endTime)
			);
		await Promise.all(
			animations.map((animation) => animation.finished.catch(() => undefined))
		);
	});
	let geometry: DialogGeometry | undefined;
	await expect
		.poll(async () => {
			const result = await page.evaluate(async () => {
				const elements = [
					...document.querySelectorAll(
						'[data-slot="dialog-content"], [data-slot="dialog-overlay"]'
					),
				];
				const snapshot = () =>
					elements.map((element) => {
						const rect = element.getBoundingClientRect();
						return {
							slot: element.getAttribute("data-slot"),
							opacity: Number(getComputedStyle(element).opacity),
							closed: element.hasAttribute("data-closed"),
							x: rect.x,
							y: rect.y,
							width: rect.width,
							height: rect.height,
							connected: element.isConnected,
						};
					});
				const before = snapshot();
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				);
				const after = snapshot();
				return {
					before,
					after,
					ready: after.every(
						(entry, index) =>
							entry.connected &&
							!entry.closed &&
							entry.opacity >= 0.999 &&
							entry.width > 0 &&
							entry.height > 0 &&
							(["x", "y", "width", "height"] as const).every(
								(key) => Math.abs(entry[key] - before[index][key]) < 0.25
							)
					),
				};
			});
			geometry = result;
			return result.ready;
		})
		.toBe(true);
	writeFileSync(
		path.join(proof, file.replace(".png", "-geometry.json")),
		JSON.stringify(geometry, null, 2)
	);
	await page.screenshot({
		animations: "disabled",
		path: path.join(proof, file),
		fullPage: true,
	});
}
function assertBody(call: Call, expected: string) {
	expect(call.path).toBe("/api/btw");
	expect(call.body.question).toBe(expected);
	expect(call.body.conversation_id).toBe(conversationId);
	expect(call.body.messages).toEqual(context);
	expect(Object.keys(call.body).sort()).toEqual(
		[
			"conversation_id",
			"messages",
			...(call.body.model === undefined ? [] : ["model"]),
			"question",
		].sort()
	);
}

test("btw command validation, denied/service errors, composer retry and saved UI readback", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		"/share-conversation-toolbar-entry.html?scenario=side-chat-caller"
	);
	await expect(page.getByPlaceholder("Ask a follow up").first()).toBeVisible();
	await sendCommand(page, "/btw");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(await posts(page)).toHaveLength(0);
	await setMode(page, "deny");
	await sendCommand(page, `/btw ${question}`);
	const dialog = page.getByRole("dialog", { name: "Side question" });
	await expect(
		dialog.getByText("Side chat access denied", { exact: true })
	).toBeVisible();
	await capture(page, "side-chat-denied.png");
	await setMode(page, "error");
	await dialog.getByRole("textbox").fill(question);
	await dialog.getByRole("button", { name: "Send", exact: true }).click();
	await expect(
		dialog.getByText("Side chat service unavailable", { exact: true })
	).toBeVisible();
	await setMode(page, "allow");
	await dialog.getByRole("textbox").fill(question);
	await dialog.getByRole("button", { name: "Send", exact: true }).click();
	await expect(dialog.getByText(answer, { exact: true })).toBeVisible();
	await expect(dialog.locator('[data-slot="dialog-footer"]')).toContainText(
		"fixture-side-model · outside main transcript"
	);
	const calls = await posts(page);
	expect(calls).toHaveLength(3);
	for (const call of calls) {
		assertBody(call, question);
	}
	await capture(page, "side-chat-composer-retry-completed.png");
	await dialog.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(
		page
			.locator('[data-slot="message-scroller-viewport"]')
			.getByText(question, { exact: true })
	).toHaveCount(0);
	await page.reload();
	await expect(page.getByPlaceholder("Ask a follow up").first()).toBeVisible();
	// Open the production sidebar's existing conversation disclosure and saved list.
	const sideChats = page
		.getByRole("button", { name: "Side chats", exact: true })
		.first();
	if (!(await sideChats.isVisible())) {
		await page
			.getByRole("button", { name: "Expand chat details", exact: true })
			.first()
			.click();
	}
	await sideChats.click();
	await page
		.getByRole("button", { name: `Open side chat: ${question}`, exact: true })
		.click();
	await expect(dialog.getByText(answer, { exact: true })).toBeVisible();
	expect(await posts(page)).toHaveLength(0);
	await capture(page, "side-chat-persisted-readback-completed.png");
	writeFileSync(
		path.join(proof, "side-chat-command-requests.json"),
		JSON.stringify(calls, null, 2)
	);
	expect(errors).toEqual([]);
});

test("shipping selection toolbar asks and explains exact highlighted main-chat text", async ({
	page,
}) => {
	await page.goto(
		"/share-conversation-toolbar-entry.html?scenario=side-chat-caller"
	);
	const text = "The organization copy is ready for review.";
	for (const action of ["Ask in side chat", "Explain"] as const) {
		// Radix restores focus when dismissal completes; do not establish the
		// next selection while the preceding modal is still leaving the DOM.
		await expect(
			page.getByRole("dialog", { name: "Side question" })
		).toHaveCount(0);
		const selectedMessage = page
			.locator('[data-slot="message-scroller-viewport"]')
			.getByText(text, { exact: true })
			.first();
		await expect(selectedMessage).toBeVisible();
		await selectedMessage.scrollIntoViewIfNeeded();
		const selection = await selectedMessage.evaluate(async (element) => {
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve())
			);
			const selection = getSelection();
			const range = document.createRange();
			range.selectNodeContents(element);
			selection?.removeAllRanges();
			selection?.addRange(range);
			document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			const bounds = range.getBoundingClientRect();
			return {
				text: selection?.toString(),
				selectable: Boolean(element.closest("[data-message-selectable]")),
				width: bounds.width,
				height: bounds.height,
			};
		});
		expect(selection.text).toBe(text);
		expect(selection.selectable).toBe(true);
		expect(selection.width).toBeGreaterThan(0);
		expect(selection.height).toBeGreaterThan(0);
		const toolbar = page.locator('[data-slot="selection-toolbar"]');
		await expect(
			toolbar.getByRole("button", { name: action, exact: true })
		).toBeVisible();
		await toolbar.getByRole("button", { name: action, exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Side question" });
		await expect(dialog.getByText(answer, { exact: true })).toBeVisible();
		const call = (await posts(page)).at(-1);
		expect(call).toBeDefined();
		assertBody(
			call!,
			action === "Explain"
				? `Explain this highlighted text using the current main-chat context. Clarify any references or assumptions from the conversation, and do not invent facts outside it.\n\nHIGHLIGHTED TEXT:\n> ${text}`
				: `Answer this highlighted text as a side question using the current main-chat context.\n\nHIGHLIGHTED TEXT:\n> ${text}`
		);
		await capture(
			page,
			`side-chat-selection-${action === "Explain" ? "explain" : "ask"}-completed.png`
		);
		await dialog.getByRole("button", { name: "Dismiss", exact: true }).click();
		await expect(dialog).toHaveCount(0);
	}
	expect(await posts(page)).toHaveLength(2);
	writeFileSync(
		path.join(proof, "side-chat-selection-requests.json"),
		JSON.stringify(await posts(page), null, 2)
	);
});

test("dismissing a pending side question does not reopen it when a late result arrives", async ({
	page,
}) => {
	await page.goto(
		"/share-conversation-toolbar-entry.html?scenario=side-chat-caller"
	);
	await setMode(page, "pending");
	await sendCommand(page, `/btw ${question}`);
	const dialog = page.getByRole("dialog", { name: "Side question" });
	await expect(dialog).toBeVisible();
	await expect.poll(async () => (await posts(page)).length).toBe(1);
	await dialog.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	expect(
		await page.evaluate(
			() =>
				/* SAFETY: this spec installs its concrete caller fixture on the same page before these native observations. */ (
					window as SideChatWindow
				).__sideChatCallerFixture.aborted
		)
	).toBe(1);
	await page.evaluate(() =>
		/* SAFETY: this spec installs its concrete caller fixture on the same page before these native observations. */ (
			window as SideChatWindow
		).__sideChatCallerFixture.release?.()
	);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: the earlier bootstrap installs these actual entry codecs in this page realm. */ (
						window as SideChatWindow
					).__SIDE_CHAT_PROOF_CODECS__.sideChatEntriesSchema.parse(
						JSON.parse(
							localStorage.getItem("ryu-side-chat-caller-proof-entries") ?? "[]"
						)
					).length
			)
		)
		.toBe(1);
	await expect(dialog).toHaveCount(0);
	await capture(page, "side-chat-dismissed-late-result-completed.png");
});

test("Stop aborts the side request and the overlay composer can explicitly retry", async ({
	page,
}) => {
	await page.goto(
		"/share-conversation-toolbar-entry.html?scenario=side-chat-caller"
	);
	await setMode(page, "pending-abort");
	await sendCommand(page, `/btw ${question}`);
	const dialog = page.getByRole("dialog", { name: "Side question" });
	await dialog.getByRole("button", { name: "Stop", exact: true }).click();
	await expect(
		dialog.getByText("Side question stopped. Ask again to retry.", {
			exact: true,
		})
	).toBeVisible();
	expect(
		await page.evaluate(
			() =>
				/* SAFETY: this spec installs its concrete caller fixture on the same page before these native observations. */ (
					window as SideChatWindow
				).__sideChatCallerFixture.aborted
		)
	).toBe(1);
	expect(
		await page.evaluate(
			() =>
				/* SAFETY: the preceding bootstrap installs the actual entry codecs in this native page realm. */ (
					window as SideChatWindow
				).__SIDE_CHAT_PROOF_CODECS__.sideChatEntriesSchema.parse(
					JSON.parse(
						localStorage.getItem("ryu-side-chat-caller-proof-entries") ?? "[]"
					)
				).length
		)
	).toBe(0);
	await setMode(page, "allow");
	await dialog.getByRole("textbox").fill(question);
	await dialog.getByRole("button", { name: "Send", exact: true }).click();
	await expect(dialog.getByText(answer, { exact: true })).toBeVisible();
	expect(await posts(page)).toHaveLength(2);
	await capture(page, "side-chat-stop-retry-completed.png");
});

for (const change of ["url", "token", "userJwt"] as const) {
	test(`pending side chat is discarded when node ${change} changes`, async ({
		page,
	}) => {
		await page.goto(
			"/share-conversation-toolbar-entry.html?scenario=side-chat-caller"
		);
		await setMode(page, "pending");
		await sendCommand(page, `/btw ${question}`);
		const dialog = page.getByRole("dialog", { name: "Side question" });
		await expect(dialog).toBeVisible();
		await expect.poll(async () => (await posts(page)).length).toBe(1);
		await page.evaluate((change) => {
			// SAFETY: the shipping shared proof entry exposes this exact production Zustand store when scenario=side-chat-caller.
			const store = (window as SideChatWindow).__sideChatNodeFixture;
			const current = store.getState().getActiveNode();
			const value =
				change === "url"
					? "http://127.0.0.1:7999"
					: `side-chat-synthetic-${change}-rotation`;
			const rotate = (nodes: Node[]) =>
				nodes.map((node) =>
					node.name === current.name ? { ...node, [change]: value } : node
				);
			store.setState((state) => ({
				nodes: rotate(state.nodes),
				localNodes: rotate(state.localNodes),
			}));
			if (store.getState().getActiveNode()[change] !== value) {
				throw new Error(
					`Fixture did not rotate the effective active node ${change}`
				);
			}
		}, change);
		await expect(dialog).toHaveCount(0);
		expect(
			await page.evaluate(
				() =>
					/* SAFETY: this spec installs its concrete caller fixture on the same page before these native observations. */ (
						window as SideChatWindow
					).__sideChatCallerFixture.aborted
			)
		).toBe(1);
		await page.evaluate(() =>
			/* SAFETY: this spec installs its concrete caller fixture on the same page before these native observations. */ (
				window as SideChatWindow
			).__sideChatCallerFixture.release?.()
		);
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						/* SAFETY: the preceding bootstrap installs the actual entry codecs in this native page realm. */ (
							window as SideChatWindow
						).__SIDE_CHAT_PROOF_CODECS__.sideChatEntriesSchema.parse(
							JSON.parse(
								localStorage.getItem("ryu-side-chat-caller-proof-entries") ??
									"[]"
							)
						).length
				)
			)
			.toBe(1);
		await expect(dialog).toHaveCount(0);
		await capture(page, `side-chat-${change}-scope-completed.png`);
	});
}

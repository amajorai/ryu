import { expect, test } from "@playwright/test";
import type { DictationPrefs } from "../src/lib/api/preferences.ts";
import type { Node } from "../src/store/useNodeStore.ts";
import type {} from "./harness/keyboard-shortcuts-proof.types.ts";

declare global {
	interface Window {
		__registerShortcutAuthorityTransport: (input: {
			nodes: Node[];
			prefs: DictationPrefs;
		}) => Promise<void>;
		__shortcutAuthorityNativeCalls: Array<{ command: string; name: string }>;
		__shortcutAuthorityNodes: Node[];
		__shortcutAuthorityUnexpectedNative: string[];
	}
}

async function clickVisibleControlWithMouse(
	page: import("@playwright/test").Page,
	control: import("@playwright/test").Locator
) {
	await expect(control).toBeVisible();
	await control.scrollIntoViewIfNeeded();
	const box = await control.boundingBox();
	if (!box || box.width <= 0 || box.height <= 0) {
		throw new Error(
			"Expected visible control with nonempty mouse target bounds"
		);
	}
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function settleInputFrames(page: import("@playwright/test").Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			})
	);
}

test("returning A while its original preference PUT is held waits for the actual acknowledgement and rereads both fields before another write", async ({
	page,
}) => {
	const saved = new Map<string, DictationPrefs>();
	const calls: Array<{
		node: string;
		method: string;
		body: { value: string } | null;
		status: "accepted" | "pending";
	}> = [];
	const unexpected: string[] = [];
	const heldA: { release: (() => void) | null } = { release: null };
	let holdA = true;
	let authorityNodes: Node[] = [];
	const flights = new Set<Promise<void>>();
	const routeErrors: string[] = [];
	await page.exposeBinding(
		"__registerShortcutAuthorityTransport",
		(_, input: { nodes: Node[]; prefs: DictationPrefs }) => {
			if (authorityNodes.length) {
				expect(input.nodes).toEqual(authorityNodes);
			} else {
				authorityNodes = structuredClone(input.nodes);
			}
			for (const node of authorityNodes) {
				if (!saved.has(node.name)) {
					saved.set(node.name, {
						...input.prefs,
						shortcut: node.name === "Authority A" ? "F3" : "F6",
						ask: {
							...input.prefs.ask,
							shortcut: node.name === "Authority A" ? "F4" : "F7",
						},
					});
				}
			}
		}
	);
	const headers = {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET, PUT, OPTIONS",
		"access-control-allow-headers":
			"authorization, content-type, x-ryu-surface",
	};
	const handleRequest = async (route: import("@playwright/test").Route) => {
		const request = route.request();
		const nodes = authorityNodes;
		const node = nodes.find(
			(candidate) =>
				new URL(candidate.url).origin === new URL(request.url()).origin
		);
		if (
			!node ||
			(request.method() !== "OPTIONS" &&
				request.headers().authorization !== `Bearer ${node.token}`) ||
			!["GET", "PUT", "OPTIONS"].includes(request.method())
		) {
			unexpected.push(`${request.method()} ${request.url()}`);
			await route.fulfill({
				status: 503,
				headers,
				json: { error: "Unexpected authority request" },
			});
			return;
		}
		if (request.method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers });
			return;
		}

		const body = request.method() === "PUT" ? request.postDataJSON() : null;
		const call = {
			node: node.name,
			method: request.method(),
			body,
			status: "accepted" as "accepted" | "pending",
		};
		calls.push(call);
		if (body) {
			expect(Object.keys(body)).toEqual(["value"]);
			expect(body.value).toEqual(JSON.stringify(JSON.parse(body.value)));
			expect(request.headers()["content-type"]).toContain("application/json");
			if (node.name === "Authority A" && holdA) {
				holdA = false;
				call.status = "pending";
				await new Promise<void>((resolve) => {
					heldA.release = resolve;
				});
				heldA.release = null;
			}
			saved.set(node.name, JSON.parse(body.value));
			call.status = "accepted";
		}
		await route.fulfill({
			headers,
			json: { key: "dictation", value: JSON.stringify(saved.get(node.name)) },
		});
	};
	await page.route("**/api/preferences/dictation", (route) => {
		const task = handleRequest(route);
		flights.add(task);
		void task.then(
			() => flights.delete(task),
			(error: Error) => {
				routeErrors.push(error.message);
				flights.delete(task);
			}
		);
		return task;
	});
	try {
		await page.goto("/keyboard-shortcuts-authority-proof.html");
		await page
			.getByRole("textbox", { name: "Filter keyboard shortcuts" })
			.fill("Global");
		const dictation = page.getByTestId(
			"global-shortcut-recorder-system-wide-dictation"
		);
		const ask = page.getByTestId("global-shortcut-recorder-agent-ask");
		await expect(dictation).toContainText("F3");
		await expect(ask).toContainText("F4");
		const beforeA = structuredClone(saved.get("Authority A"));
		if (!beforeA) {
			throw new Error("A initial real SDK read did not finish");
		}
		await dictation.click();
		await page.keyboard.press("F8");
		await expect
			.poll(() => calls.filter((call) => call.method === "PUT"))
			.toHaveLength(1);
		expect(saved.get("Authority A")).toEqual(beforeA);
		await page
			.getByRole("button", { name: "Select Authority B", exact: true })
			.click();
		await expect(dictation).toContainText("F6");
		await expect(ask).toContainText("F7");
		await page
			.getByRole("button", { name: "Select Authority A", exact: true })
			.click();
		await expect(dictation).toBeDisabled();
		await expect(ask).toBeDisabled();
		await clickVisibleControlWithMouse(page, ask);
		await page.keyboard.press("F9");
		await settleInputFrames(page);
		await expect.poll(() => flights.size).toBe(1);
		expect(routeErrors).toEqual([]);
		expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
		const getterCountBeforeAck = calls.filter(
			(call) => call.node === "Authority A" && call.method === "GET"
		).length;
		if (!heldA.release) {
			throw new Error("Expected original A pre-persistence held HTTP PUT");
		}
		heldA.release();
		const acknowledgedA = { ...beforeA, shortcut: "F8" };
		await expect.poll(() => saved.get("Authority A")).toEqual(acknowledgedA);
		await expect
			.poll(
				() =>
					calls.filter(
						(call) => call.node === "Authority A" && call.method === "GET"
					).length
			)
			.toBeGreaterThan(getterCountBeforeAck);
		await expect(dictation).toContainText("F8");
		await expect(ask).toContainText("F4");
		await expect(ask).toBeEnabled();
		await ask.click();
		await page.keyboard.press("F9");
		const acknowledgedBoth = {
			...acknowledgedA,
			ask: { ...acknowledgedA.ask, shortcut: "F9" },
		};
		await expect.poll(() => saved.get("Authority A")).toEqual(acknowledgedBoth);
		// The route already enforces one canonical JSON `value` per PUT. Compare
		// the complete decoded preference: JSON object key order carries no
		// meaning, so the serializer's field order is not part of the contract.
		expect(
			calls
				.filter((call) => call.method === "PUT")
				.map((call) => {
					if (!call.body) {
						throw new Error("A recorded preference PUT had no JSON body");
					}
					return { ...call, body: { value: JSON.parse(call.body.value) } };
				})
		).toEqual([
			{
				node: "Authority A",
				method: "PUT",
				body: { value: acknowledgedA },
				status: "accepted",
			},
			{
				node: "Authority A",
				method: "PUT",
				body: { value: acknowledgedBoth },
				status: "accepted",
			},
		]);
		expect(
			await page.evaluate(() => window.__shortcutAuthorityNativeCalls)
		).toEqual([
			{ command: "set_default_node", name: "Authority B" },
			{ command: "set_default_node", name: "Authority A" },
		]);
		await page.reload();
		await page
			.getByRole("textbox", { name: "Filter keyboard shortcuts" })
			.fill("Global");
		await expect(dictation).toContainText("F8");
		await expect(ask).toContainText("F9");
		expect(unexpected).toEqual([]);
		expect(
			await page.evaluate(() => window.__shortcutAuthorityUnexpectedNative)
		).toEqual([]);
	} finally {
		heldA.release?.();
		await page.evaluate(() => window.__shortcutUnmount());
		await page.unrouteAll({ behavior: "wait" });
		await Promise.all([...flights]);
		expect(flights.size).toBe(0);
		expect(routeErrors).toEqual([]);
		expect(unexpected).toEqual([]);
	}
});

import { describe, expect, test } from "bun:test";
import {
	BOX_BROWSER_VERBS,
	type BoxBrowserVerb,
	createBoxDesktopClient,
	isBoxBrowserVerb,
} from "./box-desktop.ts";
import { RyuPathIdError } from "./path-id.ts";

interface Seen {
	authorization: string | null;
	body: string | null;
	method: string;
	url: string;
}

function client(respond: (seen: Seen) => Response) {
	const calls: Seen[] = [];
	const api = createBoxDesktopClient({
		apiKey: "box-key",
		baseUrl: "https://box.example/",
		fetch: (input, init) => {
			const seen: Seen = {
				authorization: new Headers(init?.headers).get("authorization"),
				body: typeof init?.body === "string" ? init.body : null,
				method: init?.method ?? "GET",
				url: String(input),
			};
			calls.push(seen);
			return Promise.resolve(respond(seen));
		},
	});
	return { api, calls };
}

describe("Box desktop and browser verbs", () => {
	test("a desktop action posts the canonical action with the tenant key", async () => {
		const { api, calls } = client(() =>
			Response.json({ action: "click", ok: true, type: "desktop.action" })
		);
		const result = await api.action("bx_1", {
			action: "click",
			button: "left",
			x: 10,
			y: 20,
		});
		expect(result).toEqual({
			action: "click",
			ok: true,
			type: "desktop.action",
		});
		expect(calls[0]).toEqual({
			authorization: "Bearer box-key",
			body: JSON.stringify({ action: "click", button: "left", x: 10, y: 20 }),
			method: "POST",
			url: "https://box.example/v1/boxes/bx_1/desktop/actions",
		});
	});

	test("screenshot returns the image and refuses another result", async () => {
		const shot = {
			action: "screenshot",
			encoding: "base64",
			height: 500,
			image: "iVBORw0KGgo=",
			mime: "image/png",
			ok: true,
			screenHeight: 1000,
			screenWidth: 1600,
			type: "desktop.action",
			width: 800,
		} as const;
		const { api, calls } = client(() => Response.json(shot));
		expect(await api.screenshot("bx_1", 800)).toEqual(shot);
		expect(calls[0]?.body).toBe(
			JSON.stringify({ action: "screenshot", maxWidth: 800 })
		);
		await api.screenshot("bx_1");
		expect(calls[1]?.body).toBe(JSON.stringify({ action: "screenshot" }));

		const wrong = client(() =>
			Response.json({ action: "click", ok: true, type: "desktop.action" })
		);
		await expect(wrong.api.screenshot("bx_1")).rejects.toThrow(
			"returned another result"
		);
	});

	test("a browser verb posts its arguments to /browser/:verb", async () => {
		const { api, calls } = client(() =>
			Response.json({ ok: true, tabs: [{ id: "t1" }] })
		);
		expect(
			await api.browser("bx_1", "navigate", { url: "https://a.example/" })
		).toEqual({ ok: true, tabs: [{ id: "t1" }] });
		expect(calls[0]).toMatchObject({
			body: JSON.stringify({ url: "https://a.example/" }),
			method: "POST",
			url: "https://box.example/v1/boxes/bx_1/browser/navigate",
		});
		await api.browser("bx_1", "tabs");
		expect(calls[1]?.body).toBe("{}");
	});

	test("an unknown browser verb is refused before any request", async () => {
		const { api, calls } = client(() => Response.json({}));
		await expect(api.browser("bx_1", "eval" as BoxBrowserVerb)).rejects.toThrow(
			"unknown browser verb"
		);
		expect(calls).toHaveLength(0);
		expect(isBoxBrowserVerb("clear_annotations")).toBe(true);
		expect(isBoxBrowserVerb("fill")).toBe(false);
		expect(BOX_BROWSER_VERBS).toContain("snapshot");
	});

	test("the fill flow prepares, commits, reads and cancels by fill id", async () => {
		const replies: Response[] = [
			Response.json(
				{
					fillId: "fill_1",
					ok: true,
					pageUrl: "https://login.example/",
					type: "browser.fill.prepared",
				},
				{ status: 201 }
			),
			Response.json({
				fillId: "fill_1",
				filled: true,
				ok: true,
				type: "browser.fill.committed",
			}),
			Response.json({
				fillId: "fill_1",
				ok: true,
				state: "consumed",
				type: "browser.fill",
			}),
			new Response(null, { status: 204 }),
		];
		const { api, calls } = client(() => replies.shift() ?? Response.json({}));
		const target = {
			bindHosts: ["login.example"],
			field: "password" as const,
			pageHosts: ["login.example"],
			ref: "@e3",
		};
		const prepared = await api.prepareFill("bx_1", target);
		expect(prepared.fillId).toBe("fill_1");
		expect(calls[0]).toMatchObject({
			body: JSON.stringify(target),
			method: "POST",
			url: "https://box.example/v1/boxes/bx_1/browser-fills",
		});
		const committed = await api.commitFill("bx_1", "fill_1", {
			mode: "placeholder",
			unbound: false,
			value: "hunter2",
		});
		expect(committed.filled).toBe(true);
		expect(calls[1]?.url).toBe(
			"https://box.example/v1/boxes/bx_1/browser-fills/fill_1"
		);
		expect((await api.fillStatus("bx_1", "fill_1")).state).toBe("consumed");
		expect(calls[2]?.method).toBe("GET");
		await api.cancelFill("bx_1", "fill_1");
		expect(calls[3]).toMatchObject({ body: null, method: "DELETE" });
	});

	test("a failed call names the route and status but not the request body", async () => {
		const { api } = client(
			() => new Response('{"error":{"code":"conflict"}}', { status: 409 })
		);
		const message = await api
			.commitFill("bx_1", "fill_1", { mode: "text", value: "secret-value" })
			.then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : "")
			);
		expect(message).toContain(
			"POST /v1/boxes/bx_1/browser-fills/fill_1 failed (409)"
		);
		expect(message).not.toContain("secret-value");
	});

	test("unsafe ids are refused before any request", async () => {
		const { api, calls } = client(() => Response.json({}));
		await expect(api.fillStatus("..", "fill_1")).rejects.toBeInstanceOf(
			RyuPathIdError
		);
		await expect(api.cancelFill("bx_1", ".")).rejects.toBeInstanceOf(
			RyuPathIdError
		);
		expect(calls).toHaveLength(0);
	});
});

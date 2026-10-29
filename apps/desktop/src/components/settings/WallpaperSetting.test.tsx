import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let target: ApiTarget = {
	url: "https://wallpaper.fixture",
	token: "wallpaper-token",
	userJwt: "user-a",
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
const { createRoot } = await import("react-dom/client");
const { WallpaperSetting } = await import("./WallpaperSetting.tsx");
const { WALLPAPER_STORAGE_KEY, readWallpaperPreference } = await import(
	"@/src/lib/wallpaper.ts"
);
const realFetch = globalThis.fetch;
const roots: Root[] = [];
const storageWrite = Storage.prototype.setItem;
let refuseStorage = false;
interface Call {
	url: URL;
	authorization: string | null;
	identity: string | null;
}
let calls: Call[];
let respond: (call: Call) => Response | Promise<Response>;
function image(title: string) {
	return {
		id: title,
		title,
		attribution: "Fixture photographer",
		url: "https://images.fixture/photo.jpg",
		preview_url: "https://images.fixture/preview.jpg",
		source_url: "https://source.fixture/credit",
		rights: "CC0",
		width: 1600,
		height: 900,
	};
}
beforeEach(() => {
	localStorage.clear();
	refuseStorage = false;
	calls = [];
	target = {
		url: "https://wallpaper.fixture",
		token: "wallpaper-token",
		userJwt: "user-a",
	};
	Storage.prototype.setItem = function (key, value) {
		if (key === WALLPAPER_STORAGE_KEY && refuseStorage)
			throw new DOMException("Storage refused", "QuotaExceededError");
		return storageWrite.call(this, key, value);
	};
	respond = (call) =>
		Response.json({
			configured: true,
			provider: call.url.searchParams.get("provider"),
			results: [image("Fixture image")],
			has_more: false,
		});
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const call = {
				url: new URL(String(input)),
				authorization: headers.get("authorization"),
				identity: headers.get("x-ryu-user-jwt"),
			};
			calls.push(call);
			return await respond(call);
		},
		{ preconnect: realFetch.preconnect }
	);
});
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount();
	});
	Storage.prototype.setItem = storageWrite;
	globalThis.fetch = realFetch;
	document.body.replaceChildren();
	localStorage.clear();
});
function view() {
	return (
		<>
			<WallpaperSetting />
			<Toaster />
		</>
	);
}
async function settle() {
	await act(async () => {
		await Bun.sleep(20);
	});
}
async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(view()));
	await settle();
	return root;
}
async function click(name: string) {
	const button = [...document.querySelectorAll("button")].find(
		(element) =>
			(element.getAttribute("aria-label") ?? element.textContent?.trim()) ===
			name
	);
	if (!button) throw new Error(`Missing ${name}`);
	await act(async () => button.click());
	await settle();
}
function link() {
	const input = document.querySelector<HTMLInputElement>(
		'[aria-label="Image link"]'
	);
	if (!input) throw new Error("Missing image link");
	return input;
}
async function fill(value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(link(), value);
		link().dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function remount(root: Root) {
	await act(async () => root.unmount());
	roots.splice(roots.indexOf(root), 1);
	return await mount();
}
test("gallery presets persist on this device and random mode replaces the selected preset after remount", async () => {
	let root = await mount();
	await click("Golden Gate dusk");
	expect(readWallpaperPreference()).toMatchObject({
		mode: "preset",
		presetId: "golden-gate-dusk",
		set: "Golden Gate",
	});
	root = await remount(root);
	expect(
		document
			.querySelector('[aria-label="Golden Gate dusk"]')
			?.getAttribute("aria-pressed")
	).toBe("true");
	await click("All wallpapers");
	expect(readWallpaperPreference()).toMatchObject({
		mode: "random",
		set: "all",
	});
	await remount(root);
	expect(document.body.textContent).toContain(
		"Shuffles each launch · All wallpapers"
	);
	expect(calls).toEqual([]);
});
test("link validation refuses non-HTTPS inputs and stores the normalized custom image with remount readback", async () => {
	let root = await mount();
	await click("Link");
	for (const url of [
		"javascript:alert(1)",
		"data:image/png;base64,AA",
		"http://images.fixture/photo.jpg",
		"not a URL",
	]) {
		await fill(url);
		await click("Use this image");
		expect(localStorage.getItem(WALLPAPER_STORAGE_KEY)).toBeNull();
	}
	await fill("  https://images.fixture/picture.jpg  ");
	await click("Use this image");
	expect(readWallpaperPreference()).toMatchObject({
		mode: "image",
		image: {
			url: "https://images.fixture/picture.jpg",
			label: "images.fixture",
			sourceUrl: "https://images.fixture/picture.jpg",
			attribution: null,
		},
	});
	root = await remount(root);
	expect(document.body.textContent).toContain("images.fixture");
	expect(calls).toEqual([]);
});
test("a refused custom-image write preserves both the previous wallpaper and the URL draft for retry", async () => {
	const root = await mount();
	await click("Golden Gate dusk");
	const saved = localStorage.getItem(WALLPAPER_STORAGE_KEY);
	await click("Link");
	await fill("https://images.fixture/retry.jpg");
	refuseStorage = true;
	await click("Use this image");
	expect(localStorage.getItem(WALLPAPER_STORAGE_KEY)).toBe(saved);
	expect(document.body.textContent).toContain("Couldn't save wallpaper");
	expect(link().value).toBe("https://images.fixture/retry.jpg");
	refuseStorage = false;
	await click("Use this image");
	expect(readWallpaperPreference().image?.url).toBe(
		"https://images.fixture/retry.jpg"
	);
	await remount(root);
	expect(document.body.textContent).toContain("images.fixture");
});
test("authenticated Unsplash search falls back to Openverse and saves image credit and source metadata", async () => {
	respond = (call) =>
		Response.json({
			configured: call.url.searchParams.get("provider") === "openverse",
			provider: call.url.searchParams.get("provider"),
			results:
				call.url.searchParams.get("provider") === "openverse"
					? [image("Licensed image")]
					: [],
			has_more: false,
		});
	const root = await mount();
	await click("Unsplash");
	expect(
		calls.map((call) => [
			call.url.pathname,
			call.url.searchParams.get("provider"),
			call.url.searchParams.get("q"),
			call.authorization,
			call.identity,
		])
	).toEqual([
		[
			"/api/assets/images/search",
			"unsplash",
			"Golden Gate",
			"Bearer wallpaper-token",
			"user-a",
		],
		[
			"/api/assets/images/search",
			"openverse",
			"Golden Gate",
			"Bearer wallpaper-token",
			"user-a",
		],
	]);
	await click("Licensed image · Fixture photographer");
	expect(readWallpaperPreference()).toMatchObject({
		mode: "image",
		image: {
			attribution: "Fixture photographer",
			sourceUrl: "https://source.fixture/credit",
			label: "Licensed image",
		},
	});
	await remount(root);
	expect(document.body.textContent).toContain("Fixture photographer");
});
test("a late former credential's search cannot replace current results or supply an old wallpaper", async () => {
	let finish!: (response: Response) => void;
	respond = (call) =>
		call.identity === "user-a"
			? new Promise<Response>((resolve) => {
					finish = resolve;
				})
			: Response.json({
					configured: true,
					provider: "unsplash",
					results: [image("Current image")],
					has_more: false,
				});
	const root = await mount();
	await click("Unsplash");
	target = { ...target, userJwt: "user-b" };
	await act(async () => root.render(view()));
	await settle();
	expect(
		document.querySelector(
			'[aria-label="Current image · Fixture photographer"]'
		)
	).not.toBeNull();
	await act(async () =>
		finish(
			Response.json({
				configured: true,
				provider: "unsplash",
				results: [image("Old image")],
				has_more: false,
			})
		)
	);
	await settle();
	expect(
		document.querySelector('[aria-label="Old image · Fixture photographer"]')
	).toBeNull();
	await click("Current image · Fixture photographer");
	expect(readWallpaperPreference().image?.label).toBe("Current image");
	expect(calls.map((call) => call.identity)).toEqual(["user-a", "user-b"]);
});

import { afterEach, describe, expect, it } from "bun:test";
import {
	isLinkableReleaseAsset,
	loadReleases,
	RELEASES_API,
	RELEASES_ROUTE,
	type Release,
	resetReleasesCache,
} from "./download-assets.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOCATION = Object.getOwnPropertyDescriptor(
	globalThis,
	"location"
);

function setPageProtocol(protocol: string | null) {
	if (protocol === null) {
		Reflect.deleteProperty(globalThis, "location");
		return;
	}
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: { protocol },
	});
}

function stubFetch(answer: (url: string) => Response | Promise<Response>) {
	const urls: string[] = [];
	globalThis.fetch = Object.assign(
		(input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			urls.push(url);
			return Promise.resolve(answer(url));
		},
		{ preconnect: ORIGINAL_FETCH.preconnect }
	);
	return urls;
}

function row(id: number, tag: string): Release {
	return {
		assets: [
			{
				browser_download_url: `https://downloads.ryu.test/Ryu_${tag}_x64.dmg`,
				name: `Ryu_${tag}_x64.dmg`,
			},
		],
		html_url: `https://github.com/amajorai/ryu/releases/tag/${tag}`,
		id,
		name: tag,
		published_at: "2026-10-01T00:00:00Z",
		tag_name: tag,
	};
}

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	if (ORIGINAL_LOCATION) {
		Object.defineProperty(globalThis, "location", ORIGINAL_LOCATION);
	} else {
		Reflect.deleteProperty(globalThis, "location");
	}
	resetReleasesCache();
});

describe("loadReleases source", () => {
	it("reads the site's same-origin route and never touches GitHub when it answers", async () => {
		setPageProtocol("https:");
		const urls = stubFetch(() => Response.json([row(1, "v1.0.0")]));
		const releases = await loadReleases();
		expect(urls).toEqual([RELEASES_ROUTE]);
		expect(releases.map((release) => release.tag_name)).toEqual(["v1.0.0"]);
	});

	it("falls back to GitHub when this origin has no route", async () => {
		setPageProtocol("http:");
		const urls = stubFetch((url) =>
			url === RELEASES_ROUTE
				? new Response("not found", { status: 404 })
				: Response.json([row(2, "v2.0.0")])
		);
		const releases = await loadReleases();
		expect(urls).toEqual([RELEASES_ROUTE, RELEASES_API]);
		expect(releases.map((release) => release.tag_name)).toEqual(["v2.0.0"]);
	});

	it("falls back to GitHub when the route answers with an HTML page", async () => {
		setPageProtocol("https:");
		const urls = stubFetch((url) =>
			url === RELEASES_ROUTE
				? new Response("<!doctype html><title>App</title>", {
						headers: { "content-type": "text/html" },
					})
				: Response.json([row(3, "v3.0.0")])
		);
		expect((await loadReleases()).map((release) => release.id)).toEqual([3]);
		expect(urls).toEqual([RELEASES_ROUTE, RELEASES_API]);
	});

	it("falls back to GitHub when the route reports an upstream failure", async () => {
		setPageProtocol("https:");
		const urls = stubFetch((url) =>
			url === RELEASES_ROUTE
				? Response.json({ status: 502 }, { status: 502 })
				: Response.json([])
		);
		expect(await loadReleases()).toEqual([]);
		expect(urls).toEqual([RELEASES_ROUTE, RELEASES_API]);
	});

	it("asks GitHub directly off the web (no location, or a non-http app origin)", async () => {
		setPageProtocol(null);
		const urls = stubFetch(() => Response.json([]));
		await loadReleases();
		resetReleasesCache();
		setPageProtocol("tauri:");
		await loadReleases();
		expect(urls).toEqual([RELEASES_API, RELEASES_API]);
	});

	it("shares one route request across every menu on the page", async () => {
		setPageProtocol("https:");
		const urls = stubFetch(() => Response.json([row(1, "v1.0.0")]));
		await Promise.all([loadReleases(), loadReleases(), loadReleases()]);
		expect(urls).toEqual([RELEASES_ROUTE]);
	});
});

describe("isLinkableReleaseAsset", () => {
	it("keeps desktop installers and Core binaries", () => {
		for (const name of [
			"Ryu_1.2.3_aarch64.dmg",
			"Ryu_1.2.3_x64.dmg",
			"Ryu_1.2.3_x64-setup.exe",
			"Ryu_1.2.3_x64_en-US.msi",
			"Ryu_1.2.3_amd64.AppImage",
			"Ryu_1.2.3_amd64.deb",
			"Ryu-1.2.3-1.x86_64.rpm",
			"ryu-core-macos-aarch64",
			"ryu-core-windows-x86_64.exe",
		]) {
			expect(isLinkableReleaseAsset(name)).toBe(true);
		}
	});

	it("drops signatures, updater manifests, companion apps and the Bot build", () => {
		for (const name of [
			"Ryu_1.2.3_aarch64.dmg.sig",
			"latest.json",
			"Ryu_aarch64.app.tar.gz",
			"ryu-island-win-x64-setup.exe",
			"ryu-island-linux-amd64.deb",
			"Ryu.Bot_1.2.3_x64.dmg",
			"ryu-gateway-linux-x86_64",
		]) {
			expect(isLinkableReleaseAsset(name)).toBe(false);
		}
	});
});

import { describe, expect, it } from "bun:test";
import {
	appStoreListingUrl,
	hasMobileStoreListing,
	otherRyuAppSurfaces,
	RYU_APP_SURFACES,
} from "./ryu-app-surfaces.ts";

const APP_STORE = "https://apps.apple.com/app/id0000000000";
const GOOGLE_PLAY = "https://play.google.com/store/apps/details?id=example";

function idsFrom(
	...args: Parameters<typeof otherRyuAppSurfaces>
): readonly string[] {
	return otherRyuAppSurfaces(...args).map(({ id }) => id);
}

describe("otherRyuAppSurfaces", () => {
	it("never promotes the surface the user is already on", () => {
		for (const surface of RYU_APP_SURFACES) {
			const ids = idsFrom(surface.id, { mobileListed: true });
			expect(ids).not.toContain(surface.id);
			expect(ids).toHaveLength(RYU_APP_SURFACES.length - 1);
		}
	});

	it("promotes every installable client from the web app once mobile is listed", () => {
		expect(idsFrom("web", { mobileListed: true })).toEqual([
			"desktop",
			"extension",
			"mobile",
		]);
	});

	it("leaves Mobile out by default, while it has no store listing", () => {
		expect(idsFrom("web")).toEqual(["desktop", "extension"]);
		expect(idsFrom("desktop")).toEqual(["extension"]);
		expect(idsFrom("extension")).toEqual(["desktop"]);
		expect(idsFrom("mobile")).toEqual(["desktop", "extension"]);
		expect(idsFrom("extension", { mobileListed: false })).toEqual(["desktop"]);
	});

	it("always leaves at least one app to promote", () => {
		for (const current of ["desktop", "extension", "mobile", "web"] as const) {
			expect(idsFrom(current).length).toBeGreaterThan(0);
		}
	});

	it("anchors each link into its download section", () => {
		for (const surface of RYU_APP_SURFACES) {
			expect(surface.path).toBe(`/download#${surface.id}`);
		}
	});
});

describe("appStoreListingUrl", () => {
	it("keeps an absolute https listing, trimmed", () => {
		expect(appStoreListingUrl(APP_STORE)).toBe(APP_STORE);
		expect(appStoreListingUrl(`  ${GOOGLE_PLAY}\n`)).toBe(GOOGLE_PLAY);
	});

	it("rejects unset, blank, relative, and non-https values", () => {
		for (const value of [
			undefined,
			null,
			"",
			"   ",
			"/docs/mobile",
			"apps.apple.com/app/id0",
			"http://apps.apple.com/app/id0",
			"javascript:alert(1)",
		]) {
			expect(appStoreListingUrl(value)).toBeNull();
		}
	});
});

describe("hasMobileStoreListing", () => {
	it("is false when no listing is configured", () => {
		expect(hasMobileStoreListing()).toBe(false);
		expect(hasMobileStoreListing(undefined, "")).toBe(false);
		expect(hasMobileStoreListing("not a url", null)).toBe(false);
	});

	it("is true when either store has a listing", () => {
		expect(hasMobileStoreListing(APP_STORE, undefined)).toBe(true);
		expect(hasMobileStoreListing("", GOOGLE_PLAY)).toBe(true);
	});
});

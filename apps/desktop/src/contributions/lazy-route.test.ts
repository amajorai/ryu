import { describe, expect, it } from "bun:test";
import { lazyRoute } from "./lazy-route.ts";
import { ContributionRegistry } from "./registry.ts";

const Page = () => null;

describe("route preload", () => {
	it("imports a lazy page once, however often it is preloaded", async () => {
		let imports = 0;
		const LazyPage = lazyRoute(() => {
			imports += 1;
			return Promise.resolve({ default: Page });
		});
		await Promise.all([LazyPage.preload(), LazyPage.preload()]);
		await LazyPage.preload();
		expect(imports).toBe(1);
	});

	it("retries an import that failed", async () => {
		let imports = 0;
		const LazyPage = lazyRoute(() => {
			imports += 1;
			return imports === 1
				? Promise.reject(new Error("offline"))
				: Promise.resolve({ default: Page });
		});
		await expect(LazyPage.preload()).rejects.toThrow("offline");
		await expect(LazyPage.preload()).resolves.toEqual({ default: Page });
		expect(imports).toBe(2);
	});

	it("preloads the entry that the path resolves to", () => {
		const reg = new ContributionRegistry();
		const warmed: string[] = [];
		reg.registerRoute({
			kind: "exact",
			path: "/settings",
			preload: () => {
				warmed.push("settings");
				return Promise.resolve();
			},
			render: () => "settings",
		});
		reg.registerRoute({
			kind: "pattern",
			preload: () => {
				warmed.push("space");
				return Promise.resolve();
			},
			render: () => "space",
			test: /^\/spaces\/[^/]+$/,
		});
		reg.preload("/settings");
		reg.preload("/spaces/abc");
		reg.preload("/unknown");
		expect(warmed).toEqual(["settings", "space"]);
	});

	it("swallows a failed preload so a hover never throws", async () => {
		const reg = new ContributionRegistry();
		reg.registerRoute({
			kind: "exact",
			path: "/broken",
			preload: () => Promise.reject<void>(new Error("chunk missing")),
			render: () => null,
		});
		expect(() => reg.preload("/broken")).not.toThrow();
		await Promise.resolve();
	});
});

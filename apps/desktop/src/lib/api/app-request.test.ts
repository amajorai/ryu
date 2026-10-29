import { describe, expect, test } from "bun:test";
import {
	type AppRequestMethod,
	type MountedAppPathInput,
	resolveMountedAppPath,
	resolveOwnAppPath,
	validateMountedAppRequest,
} from "./app-request.ts";
import { resolveBlueprintPath } from "./blueprint.ts";
import { resolveNewsPath } from "./news.ts";
import { resolveReasoningPath } from "./reasoning.ts";
import { resolveRlmPath } from "./rlm.ts";
import { resolveSocialPath } from "./social.ts";
import { resolveSubtitlesPath } from "./subtitles.ts";
import { resolveTuitionPath } from "./tuition.ts";

interface ResolverCase {
	label: string;
	mount: string;
	resolve: (path: MountedAppPathInput) => string | null;
}

const RESOLVERS: ResolverCase[] = [
	{
		label: "scoped app ext proxy",
		mount: "/api/ext/@ryu/pull-requests",
		resolve: (path) => resolveOwnAppPath("@ryu/pull-requests", path),
	},
	{ label: "news", mount: "/api/news", resolve: resolveNewsPath },
	{ label: "tuition", mount: "/api/tuition", resolve: resolveTuitionPath },
	{
		label: "reasoning",
		mount: "/api/reasoning",
		resolve: resolveReasoningPath,
	},
	{ label: "rlm", mount: "/api/rlm", resolve: resolveRlmPath },
	{ label: "social", mount: "/api/social", resolve: resolveSocialPath },
	{
		label: "subtitles",
		mount: "/api/subtitles",
		resolve: resolveSubtitlesPath,
	},
	{
		label: "blueprint",
		mount: "/api/blueprint",
		resolve: resolveBlueprintPath,
	},
];

const SHARED_REJECTED_PATHS = [
	"https://evil.test/x",
	"//evil.test/x",
	"items",
	"",
	42,
	null,
	undefined,
	"/\\..\\settings",
	"/../settings",
	"/%2e%2e/settings",
	"/%2E%2E/settings",
	"/.%2e/settings",
	"/%2e./settings",
	"/items/%2e%2e/%2e%2e/settings",
	"/%2e%2e/../settings",
];

describe("resolveOwnAppPath", () => {
	test("keeps a request inside the owning scoped plugin", () => {
		expect(resolveOwnAppPath("@ryu/pull-requests", "/pulls?state=open")).toBe(
			"/api/ext/@ryu/pull-requests/pulls?state=open"
		);
	});

	test("rejects absolute, protocol-relative, backslash and encoded traversal", () => {
		expect(
			resolveOwnAppPath("@ryu/pull-requests", "https://evil.test/x")
		).toBeNull();
		expect(resolveOwnAppPath("@ryu/pull-requests", "//evil.test/x")).toBeNull();
		expect(resolveOwnAppPath("@ryu/pull-requests", "/..\\settings")).toBeNull();
		expect(
			resolveOwnAppPath("@ryu/pull-requests", "/%2e%2e/settings")
		).toBeNull();
	});
});

describe("mounted app path containment", () => {
	test("rejects an invalid host-owned mount", () => {
		expect(resolveMountedAppPath("", "/items")).toBeNull();
		expect(resolveMountedAppPath("https://evil.test", "/items")).toBeNull();
		expect(resolveMountedAppPath("//evil.test", "/items")).toBeNull();
		expect(resolveMountedAppPath("/api\\evil", "/items")).toBeNull();
	});

	for (const resolverCase of RESOLVERS) {
		describe(resolverCase.label, () => {
			test("normalizes safe paths beneath its fixed mount", () => {
				expect(resolverCase.resolve("/items?limit=5")).toBe(
					`${resolverCase.mount}/items?limit=5`
				);
				expect(resolverCase.resolve("/a/../items")).toBe(
					`${resolverCase.mount}/items`
				);
				expect(resolverCase.resolve("/%2e%2e%2fsettings")).toBe(
					`${resolverCase.mount}/%2e%2e%2fsettings`
				);
			});

			test("rejects the shared traversal and host-escape corpus", () => {
				for (const path of SHARED_REJECTED_PATHS) {
					expect(resolverCase.resolve(path)).toBeNull();
				}

				const mountSegments = resolverCase.mount.split("/");
				const mountLeaf = mountSegments.at(-1);
				expect(
					resolverCase.resolve(`/%2e%2e/${mountLeaf}-sibling/secrets`)
				).toBeNull();
			});
		});
	}
});

describe("mounted app request validation", () => {
	const policy = {
		allowedMethods: new Set<AppRequestMethod>(["GET"]),
		invalidMethodMessage: (method: string) => `method:${method}`,
		invalidPathMessage: (path: MountedAppPathInput) => `path:${String(path)}`,
		mount: "/api/example",
	};

	test("returns one normalized request contract", () => {
		expect(
			validateMountedAppRequest(
				{ body: { ok: true }, path: "/a/../items?limit=1" },
				policy
			)
		).toEqual({
			body: { ok: true },
			method: "GET",
			path: "/api/example/items?limit=1",
			signal: undefined,
		});
	});

	test("applies the mount method policy before forwarding", () => {
		expect(() =>
			validateMountedAppRequest({ method: "POST", path: "/items" }, policy)
		).toThrow("method:POST");
		expect(() =>
			validateMountedAppRequest({ path: "/%2e%2e/settings" }, policy)
		).toThrow("path:/%2e%2e/settings");
	});
});

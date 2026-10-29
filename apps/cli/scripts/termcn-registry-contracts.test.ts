import { afterEach, expect, test } from "bun:test";
import { termcnRegistryItemSchema } from "./termcn-registry-contracts.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
	server?.stop(true);
	server = undefined;
});

test("registry HTTP admission preserves source text, targets and dependency order", async () => {
	const content =
		"/* @jsxImportSource @opentui/react */\nexport const Label = () => <text>Ready</text>;\n";
	server = Bun.serve({
		port: 0,
		fetch: () =>
			Response.json({
				name: "opentui-label",
				dependencies: ["react", "@opentui/react"],
				registryDependencies: ["opentui-theme-provider"],
				files: [
					{
						content,
						path: "registry/opentui/label.tsx",
						target: "components/ui/label.tsx",
					},
				],
				author: "future registry metadata",
			}),
	});
	const response = await fetch(server.url);
	const item = termcnRegistryItemSchema.parse(await response.json());
	expect(item.files?.[0]?.content).toBe(content);
	expect(item.files?.[0]?.target).toBe("components/ui/label.tsx");
	expect(item.dependencies).toEqual(["react", "@opentui/react"]);
	expect(item.registryDependencies).toEqual(["opentui-theme-provider"]);
});

test("registry item without optional files or dependencies remains valid", () => {
	expect(termcnRegistryItemSchema.parse({ name: "theme-provider" })).toEqual({
		name: "theme-provider",
	});
});

test("invalid file payloads and dependency lists fail before vendor writes", () => {
	const invalid = [
		{ name: "label", files: [{ path: "label.tsx", content: false }] },
		{ name: "label", files: [{ content: "source" }] },
		{
			name: "label",
			files: [{ path: "label.tsx", content: "source", target: 3 }],
		},
		{ name: "label", dependencies: [3] },
		{ name: "label", registryDependencies: "theme" },
		{ name: 3 },
	];
	for (const item of invalid) {
		expect(termcnRegistryItemSchema.safeParse(item).success).toBe(false);
	}
});

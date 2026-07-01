import { describe, expect, it } from "bun:test";
import { PluginManifestSchema } from "../manifest.ts";
import {
	definePlugin,
	defineTurnHook,
	type HookDirective,
} from "./turn-hook.ts";

describe("defineTurnHook", () => {
	it("serializes the run function into sandbox code and defaults `on`", () => {
		const hook = defineTurnHook({
			id: "x.review",
			run: (ctx) =>
				({ kind: "note", text: `t:${ctx.transcript.length}` }) as HookDirective,
		});
		expect(hook.id).toBe("x.review");
		expect(hook.on).toBe("post_assistant_turn");
		// The code calls the serialized function with the sandbox globals.
		expect(hook.code).toContain("(ctx, host)");
		expect(hook.code.startsWith("return await (")).toBe(true);
		expect(hook.code).toContain("kind");
	});

	it("honors an explicit `on`", () => {
		const hook = defineTurnHook({
			id: "x.pre",
			on: "pre_user_turn",
			run: () => ({ kind: "none" }),
		});
		expect(hook.on).toBe("pre_user_turn");
	});
});

describe("definePlugin", () => {
	it("produces a manifest that matches the Core PluginManifest shape", () => {
		const manifest = definePlugin({
			id: "com.example.double-check",
			name: "Example Double Check",
			version: "1.0.0",
			grants: ["hook:side-model"],
			turnHooks: [
				defineTurnHook({
					id: "dc.review",
					run: async (ctx, host) => {
						const last = ctx.transcript.at(-1);
						const review = await host.sideModel({
							prompt: last ? last.content : "",
							model_pref_key: "double-check-model",
						});
						return { kind: "note", text: review };
					},
				}),
			],
			composerControls: [
				{ id: "dc.toggle", type: "toggle", flag: "com.example.double-check" },
			],
		});

		// Validates against the SDK's zod schema (which mirrors Core's serde shape).
		const parsed = PluginManifestSchema.parse(manifest);
		expect(parsed.id).toBe("com.example.double-check");
		expect(parsed.runnables).toEqual([]);
		expect(parsed.activation_events).toEqual(["*"]);
		expect(parsed.contributes?.turn_hooks).toHaveLength(1);
		expect(parsed.contributes?.turn_hooks[0]?.id).toBe("dc.review");
		expect(parsed.contributes?.composer_controls).toHaveLength(1);
		expect(parsed.permission_grants).toContain("hook:side-model");
	});

	it("defaults empty contribution arrays and grants", () => {
		const manifest = definePlugin({
			id: "com.example.empty",
			name: "Empty",
			version: "0.1.0",
		});
		const parsed = PluginManifestSchema.parse(manifest);
		expect(parsed.permission_grants).toEqual([]);
		expect(parsed.contributes?.turn_hooks).toEqual([]);
		expect(parsed.contributes?.slash_commands).toEqual([]);
	});
});

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
	asToastDismissArg,
	asToastShowArg,
	asToastUpdateArg,
	CodedRpcError,
	capabilitiesFromGrants,
	dispatchRpc,
	type HostServices,
	TOAST_LIMITS,
} from "./rpc.ts";
import {
	htmlCompanionSrcdoc,
	thirdPartyPluginSrcdoc,
} from "./third-party-plugin.ts";

const TOAST = capabilitiesFromGrants(["ui:toast"]);
const BASE_SERVICES: HostServices = {
	listAgents: async () => [],
	registerRoute: async () => null,
};

describe("toast RPC contract", () => {
	it("maps the narrow grant and dispatches show/update/dismiss", async () => {
		expect([...TOAST]).toEqual(["ui.toast"]);
		const calls: unknown[] = [];
		const services: HostServices = {
			...BASE_SERVICES,
			uiToastShow: (input) => {
				calls.push(["show", input]);
				return "caller-toast-1";
			},
			uiToastUpdate: (input) => {
				calls.push(["update", input]);
			},
			uiToastDismiss: (input) => {
				calls.push(["dismiss", input]);
			},
		};

		const id = await dispatchRpc(
			"ui.toast.show",
			[
				{
					title: "Saved",
					description: "The workflow was saved.",
					variant: "success",
					duration: 4000,
				},
			],
			TOAST,
			services
		);
		await dispatchRpc(
			"ui.toast.update",
			[{ id, title: "Published", variant: "info" }],
			TOAST,
			services
		);
		await dispatchRpc("ui.toast.dismiss", [{ id }], TOAST, services);

		expect(id).toBe("caller-toast-1");
		expect(calls).toEqual([
			[
				"show",
				{
					title: "Saved",
					description: "The workflow was saved.",
					variant: "success",
					duration: 4000,
				},
			],
			["update", { id: "caller-toast-1", title: "Published", variant: "info" }],
			["dismiss", { id: "caller-toast-1" }],
		]);
	});

	it("returns structured denial before touching a service", async () => {
		let touched = false;
		const request = dispatchRpc(
			"ui.toast.show",
			[{ title: "No grant" }],
			new Set(),
			{
				...BASE_SERVICES,
				uiToastShow: () => {
					touched = true;
					return "never";
				},
			}
		);
		await expect(request).rejects.toMatchObject({
			code: "denied",
			name: "CodedRpcError",
		});
		expect(touched).toBe(false);
	});

	it("fails closed with a structured error when the host service is missing", async () => {
		await expect(
			dispatchRpc("ui.toast.show", [{ title: "Hello" }], TOAST, BASE_SERVICES)
		).rejects.toEqual(
			expect.objectContaining({
				code: "server_error",
				message: "ui.toast.show is not available",
			})
		);
	});

	it("rejects an invalid service id instead of leaking a renderer id shape", async () => {
		await expect(
			dispatchRpc("ui.toast.show", [{ title: "Hello" }], TOAST, {
				...BASE_SERVICES,
				uiToastShow: () => "",
			})
		).rejects.toBeInstanceOf(CodedRpcError);
	});
});

describe("toast payload validation", () => {
	it("accepts the finite public vocabulary and an empty description update", () => {
		expect(
			asToastShowArg({
				title: "Working",
				variant: "loading",
				duration: TOAST_LIMITS.durationMaxMs,
			})
		).toEqual({
			title: "Working",
			variant: "loading",
			duration: TOAST_LIMITS.durationMaxMs,
		});
		expect(asToastUpdateArg({ id: "opaque", description: "" })).toEqual({
			id: "opaque",
			description: "",
		});
		expect(asToastDismissArg({ id: "opaque" })).toEqual({ id: "opaque" });
	});

	it("rejects renderer escape hatches and out-of-bounds values", () => {
		for (const input of [
			{ title: "Action", action: { label: "Undo" } },
			{ title: "Styled", style: { color: "red" } },
			{ title: "Placed", position: "top-left" },
			{ title: "Unknown", variant: "promise" },
			{ title: "Too fast", duration: TOAST_LIMITS.durationMinMs - 1 },
			{ title: "x".repeat(TOAST_LIMITS.titleChars + 1) },
			{
				title: "Long description",
				description: "x".repeat(TOAST_LIMITS.descriptionChars + 1),
			},
		]) {
			expect(asToastShowArg(input)).toBeNull();
		}
		expect(asToastUpdateArg({ id: "opaque" })).toBeNull();
		expect(asToastDismissArg({ id: "opaque", clear: true })).toBeNull();
		expect(
			asToastDismissArg({ id: "x".repeat(TOAST_LIMITS.idChars + 1) })
		).toBeNull();
	});
});

describe("toast bootstrap parity", () => {
	it("installs ui.toast in the frontend-plugin and Path A companion bridge", () => {
		const srcdoc = thirdPartyPluginSrcdoc(
			"nonce",
			Buffer.from("export function activate() {}", "utf8").toString("base64"),
			"@example/plugin"
		);
		expect(srcdoc).toContain('call("ui.toast.show"');
		expect(srcdoc).toContain('call("ui.toast.update"');
		expect(srcdoc).toContain('call("ui.toast.dismiss"');
		expect(srcdoc).toContain('call("i18n.translate"');
		expect(srcdoc).toContain("error.code = msg.error.code");
		// One copy belongs to context.plugin.host.ui; the other to window.ryu.ui.
		expect(srcdoc.match(/ui\.toast\.show/g)?.length).toBeGreaterThanOrEqual(2);
	});

	it("installs the same surface in the Path B HTML companion bridge", () => {
		const srcdoc = htmlCompanionSrcdoc(
			"nonce",
			"<!doctype html><html><head></head><body></body></html>",
			"@example/app"
		);
		expect(srcdoc).toContain('call("ui.toast.show"');
		expect(srcdoc).toContain('call("ui.toast.update"');
		expect(srcdoc).toContain('call("ui.toast.dismiss"');
		expect(srcdoc).toContain('call("i18n.translate"');
		expect(srcdoc).toContain("error.code = msg.error.code");
	});

	it("installs the same surface in the widget bootstrap", async () => {
		const source = await Bun.file(
			join(import.meta.dir, "widget-bootstrap.ts")
		).text();
		expect(source).toContain('call("ui.toast.show"');
		expect(source).toContain('call("ui.toast.update"');
		expect(source).toContain('call("ui.toast.dismiss"');
		expect(source).toContain('call("i18n.translate"');
	});
});

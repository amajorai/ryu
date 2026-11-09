import { describe, expect, test } from "bun:test";
import {
	canonicalDeviceToolId,
	clientDeviceSchema,
	DEVICE_TOOL_CATALOG,
	deviceCanonicalString,
	deviceConfirmMessage,
	devicePermissionBlockSchema,
	deviceToolCapsSchema,
	deviceToolPermissionFrameSchema,
	deviceToolRequestFrameSchema,
	deviceToolResultSchema,
	deviceToolStatusFrameSchema,
} from "./device-tools.ts";

describe("device tool catalog", () => {
	test("aliases and canonical ids are a bijection", () => {
		const ids = new Set(DEVICE_TOOL_CATALOG.tools.map((tool) => tool.id));
		expect(ids.size).toBe(DEVICE_TOOL_CATALOG.tools.length);
		for (const tool of DEVICE_TOOL_CATALOG.tools) {
			expect(tool.alias).toBe(tool.id.replaceAll(".", "_"));
			expect(canonicalDeviceToolId(tool.alias)).toBe(tool.id);
		}
		expect(canonicalDeviceToolId("browser_click")).toBeNull();
	});

	test("every app, Reminders and Home included, is available", () => {
		const available = DEVICE_TOOL_CATALOG.tools
			.filter((tool) => tool.status === "available")
			.map((tool) => tool.app);
		expect(new Set(available)).toEqual(
			new Set([
				"calendar",
				"contacts",
				"location",
				"alarms",
				"reminders",
				"home",
			])
		);
		const securityCapable = DEVICE_TOOL_CATALOG.tools
			.filter((tool) => tool.security_class_possible)
			.map((tool) => tool.id);
		expect(securityCapable).toEqual(["device.home.set"]);
	});
});

describe("wire shapes", () => {
	test("client_device caps the declaration", () => {
		const base = {
			app: "ryu-bot",
			catalog_version: 1,
			device_id: "6f1c0d2e-7a41-4c33-9c0b-2d3e4f506172",
			foreground: true,
			platform: "ios",
			tools: [{ app: "calendar", permission: "granted" }],
		};
		expect(clientDeviceSchema.safeParse(base).success).toBe(true);
		expect(
			clientDeviceSchema.safeParse({ ...base, label: "x".repeat(41) }).success
		).toBe(false);
		expect(
			clientDeviceSchema.safeParse({ ...base, catalog_version: 2 }).success
		).toBe(false);
	});

	test("request frames and results parse", () => {
		expect(
			deviceToolRequestFrameSchema.safeParse({
				app: "calendar",
				conversationId: "c",
				deviceLabel: "Alex's iPhone",
				expiresAtMs: 1,
				resumableUntilMs: 2,
				summary: "Add event",
				targetDeviceId: "d",
				tool: "device.calendar.create",
				toolCallId: "t",
			}).success
		).toBe(true);
		expect(
			deviceToolResultSchema.safeParse({ code: "made_up", ok: false }).success
		).toBe(false);
	});

	test("the canonical string matches Core's", async () => {
		const text = await deviceCanonicalString({
			body: new TextEncoder().encode("{}"),
			deviceId: "dev-1",
			method: "post",
			principalId: "user:u1",
			route: "/api/device-tools/claim",
			timestampMs: 42,
		});
		// Same vector as apps/core/src/device_tools/identity_tests.rs.
		expect(text).toBe(
			"ryu-device-v1\nPOST\n/api/device-tools/claim\nuser:u1\ndev-1\n42\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
		);
	});
});

describe("routing, parking and caps shapes", () => {
	test("a parked status carries the Retry window", () => {
		const parked = deviceToolStatusFrameSchema.parse({
			app: "calendar",
			appName: "Calendar",
			deviceLabel: "Alex's iPhone",
			resumableUntilMs: 1_700_000_000_000,
			retry: true,
			state: "parked",
			toolCallId: "call-1",
		});
		expect(parked.retry).toBe(true);
		expect(parked.app).toBe("calendar");
		expect(parked.message).toBeUndefined();
		expect(
			deviceToolStatusFrameSchema.safeParse({
				app: "not-an-app",
				state: "waiting-device",
				toolCallId: "call-1",
			}).success
		).toBe(false);
		expect(
			deviceToolStatusFrameSchema.safeParse({
				state: "running-somewhere",
				toolCallId: "call-1",
			}).success
		).toBe(false);
	});

	test("caps are never or a known cap per known app", () => {
		expect(deviceToolCapsSchema.parse("never")).toBe("never");
		expect(
			deviceToolCapsSchema.parse({ calendar: "always", location: "never" })
		).toEqual({ calendar: "always", location: "never" });
		expect(deviceToolCapsSchema.safeParse({ calendar: "maybe" }).success).toBe(
			false
		);
		expect(deviceToolCapsSchema.safeParse({ teleport: "ask" }).success).toBe(
			false
		);
	});
});

describe("on-device confirmation shapes", () => {
	test("the confirmation string matches Core's", () => {
		expect(
			deviceConfirmMessage({
				confirmedAtMs: 1_800_000_000_000,
				inputSha256: "abc",
				optionId: "allow_once",
				requestId: "perm-dev-1",
			})
		).toBe("ryu-device-confirm-v1\nperm-dev-1\nabc\nallow_once\n1800000000000");
	});

	test("an on-device card carries the input hash and the permission frame names its call", () => {
		const block = devicePermissionBlockSchema.parse({
			app: "home",
			deviceId: "d1",
			inputSha256: "abc",
			label: "Alex's iPhone",
			requiresOnDeviceConfirmation: true,
			tool: "device.home.set",
		});
		expect(block.inputSha256).toBe("abc");
		const frame = deviceToolPermissionFrameSchema.parse({
			app: "calendar",
			appName: "Calendar",
			conversationId: "conv-1",
			deviceLabel: "Alex's iPhone",
			expiresAtMs: 1,
			resumableUntilMs: 2,
			state: "undetermined",
			targetDeviceId: "d1",
			tool: "device.calendar.create",
			toolCallId: "call-1",
		});
		expect(frame.conversationId).toBe("conv-1");
		expect(frame.tool).toBe("device.calendar.create");
	});
});

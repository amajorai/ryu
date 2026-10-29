import { afterEach, expect, test } from "bun:test";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import {
	fetchActiveAccountIdentity,
	inboxEnabled,
	notifyMentionedUsers,
	selectHumanNotificationTargets,
} from "../core/humanMentions.ts";

const TARGET = { url: "http://node:7980", token: "node-token" };
const realFetch = globalThis.fetch;
const servers: ReturnType<typeof Bun.serve>[] = [];
type ResponseProvider = (
	...args: Parameters<typeof realFetch>
) => Response | Promise<Response>;

function installResponse(provide: ResponseProvider): void {
	const pending = new Map<string, () => Response | Promise<Response>>();
	let nextRequestId = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const id = request.headers.get("x-ryu-fixture-request") ?? "";
			const respond = pending.get(id);
			pending.delete(id);
			if (!respond) {
				throw new Error("Unexpected conversation fixture request");
			}
			return respond();
		},
	});
	servers.push(server);
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof realFetch>[0],
			init?: Parameters<typeof realFetch>[1]
		) => {
			const request = new Request(input, init);
			const id = String(nextRequestId++);
			pending.set(id, () => provide(input, init));
			const destination = new URL(request.url);
			destination.host = server.url.host;
			destination.protocol = server.url.protocol;
			const forwarded = new Request(destination, request);
			forwarded.headers.set("x-ryu-fixture-request", id);
			return realFetch(forwarded).finally(() => pending.delete(id));
		},
		{ preconnect: realFetch.preconnect }
	);
}

afterEach(() => {
	globalThis.fetch = realFetch;
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

test("human notification selection excludes self, removed tokens, and duplicate targets", () => {
	const selected = [
		{ id: "ada-id", label: "Ada Lovelace" },
		{ id: "ada-id", label: "Ada Lovelace" },
		{ id: "me-id", label: "Current User" },
		{ id: "grace-id", label: "Grace Hopper" },
	];

	expect(
		selectHumanNotificationTargets({
			content: "Please review @Ada Lovelace, not @Grace",
			currentUserId: "me-id",
			selected,
		})
	).toEqual([{ id: "ada-id", label: "Ada Lovelace" }]);
	expect(
		selectHumanNotificationTargets({
			content: "Draft without selected tokens",
			currentUserId: null,
			selected,
		})
	).toEqual([]);
});

test("notification bridge sends exact recipient-scoped payloads and reports only failures", async () => {
	const requests: Array<{
		body: ReturnType<typeof appResponseValueSchema.parse>;
		path: string;
	}> = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		requests.push({
			body: appResponseValueSchema.parse(JSON.parse(String(init?.body))),
			path: url.pathname,
		});
		if (String(init?.body).includes("grace-id")) {
			return Response.json(
				{ error: { code: "denied", message: "recipient not permitted" } },
				{ status: 403 }
			);
		}
		return Response.json({
			result: { notification_id: "notif-ada", target_user_id: "ada-id" },
		});
	});

	const result = await notifyMentionedUsers({
		content: "Please review @Ada Lovelace and @Grace Hopper.",
		mentions: [
			{ id: "ada-id", label: "Ada Lovelace" },
			{ id: "grace-id", label: "Grace Hopper" },
		],
		senderName: "Ryu User",
		target: TARGET,
	});

	expect(result.failedNames).toEqual(["Grace Hopper"]);
	expect(requests).toHaveLength(2);
	expect(requests[0]).toEqual({
		path: "/api/plugins/%40ryu%2Fapprovals/host",
		body: {
			method: "notifications.send",
			args: {
				target_user_id: "ada-id",
				title: "Ryu User mentioned you",
				body: "Ryu User mentioned you in chat:\nPlease review @Ada Lovelace and @Grace Hopper.",
			},
		},
	});
	expect(requests[1]?.body).toEqual({
		method: "notifications.send",
		args: {
			target_user_id: "grace-id",
			title: "Ryu User mentioned you",
			body: "Ryu User mentioned you in chat:\nPlease review @Ada Lovelace and @Grace Hopper.",
		},
	});
});

test("active sender identity reads the current account and degrades safely", async () => {
	installResponse(async () =>
		Response.json({
			activeUserId: "sender-id",
			accounts: [
				{
					userId: "sender-id",
					name: "Ryu User",
					email: "ryu@example.test",
				},
			],
		})
	);
	expect(await fetchActiveAccountIdentity(TARGET)).toEqual({
		userId: "sender-id",
		name: "Ryu User",
		email: "ryu@example.test",
	});

	installResponse(async () => Response.json({}, { status: 503 }));
	expect(await fetchActiveAccountIdentity(TARGET)).toBeNull();
});

test("managed identity uses the verified-user token subject for self filtering", async () => {
	const payload = btoa(JSON.stringify({ id: "managed-user" }))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
	installResponse(async () =>
		Response.json({
			accounts: [],
			activeUserId: null,
		})
	);

	expect(
		await fetchActiveAccountIdentity({
			...TARGET,
			userJwt: `header.${payload}.signature`,
		})
	).toEqual({ userId: "managed-user", name: null, email: null });
});

test("Inbox lifecycle state distinguishes disabled from an unreadable catalog", async () => {
	const enabledApp = {
		built_in: true,
		companion: { label: "Inbox" },
		enabled: true,
		id: "@ryu/approvals",
		installed: true,
		installed_version: "1.0.0",
		local_only: false,
		name: "Approvals",
		permission_grants: [],
		runnables: [],
		sidecar_name: null,
		version: "1.0.0",
		windows_first: false,
	};
	installResponse(async () => Response.json({ apps: [enabledApp] }));
	expect(await inboxEnabled(TARGET)).toBe(true);

	installResponse(async () =>
		Response.json({
			apps: [{ ...enabledApp, enabled: false }],
		})
	);
	expect(await inboxEnabled(TARGET)).toBe(false);

	installResponse(async () =>
		Response.json({ error: "offline" }, { status: 503 })
	);
	await expect(inboxEnabled(TARGET)).rejects.toThrow(
		"/api/plugins failed: 503"
	);
});

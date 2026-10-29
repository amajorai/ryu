import { expect, it } from "bun:test";
import { agentLifecyclePreviewSchema } from "./agent-lifecycle-contracts.ts";
import {
	type AgentLifecyclePreview,
	previewAgentInstall,
	previewAgentUninstall,
} from "./agents.ts";

it("retains full Core lifecycle disclosures and validates optional fields", () => {
	const reply = {
		action: "install",
		dryRun: true,
		id: "acp:pi",
		success: true,
		ok: true,
		name: "Pi",
		alreadyInstalled: false,
		wouldInstall: true,
		writes: ["agent installed flag", "optional runtime files"],
		future: JSON.parse('{"__proto__":{"permissions":["future"]}}'),
	} satisfies AgentLifecyclePreview;
	const parsed = agentLifecyclePreviewSchema.parse(reply);
	expect(parsed).toBe(reply);
	expect(parsed.writes).toBe(reply.writes);
	expect(
		agentLifecyclePreviewSchema.safeParse({ ...reply, writes: [42] }).success
	).toBe(false);
	expect(
		agentLifecyclePreviewSchema.safeParse({ ...reply, alreadyInstalled: "no" })
			.success
	).toBe(false);
	expect(
		agentLifecyclePreviewSchema.safeParse({
			action: "uninstall",
			dryRun: true,
			id: "acp:pi",
			success: true,
		}).success
	).toBe(true);
});
it("sends genuine preview requests and retains complete install/removal replies", async () => {
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const body = agentLifecyclePreviewSchema.parse({
				action: request.url.endsWith("/uninstall") ? "uninstall" : "install",
				success: true,
				...(await request.json()),
			});
			requests.push(JSON.stringify({ id: body.id, dryRun: body.dryRun }));
			if (body.action === "install") {
				return Response.json({
					...body,
					ok: true,
					name: "Pi",
					alreadyInstalled: false,
					wouldInstall: true,
					writes: ["agent installed flag", "optional runtime files"],
				});
			}
			return Response.json({
				...body,
				ok: true,
				alreadyInstalled: true,
				wouldUninstall: true,
				writes: ["agent installed flag"],
			});
		},
	});
	try {
		const target = { url: server.url.origin, token: "fixture" };
		expect(await previewAgentInstall(target, "acp:pi")).toEqual({
			action: "install",
			success: true,
			dryRun: true,
			id: "acp:pi",
			ok: true,
			name: "Pi",
			alreadyInstalled: false,
			wouldInstall: true,
			writes: ["agent installed flag", "optional runtime files"],
		});
		expect(await previewAgentUninstall(target, "acp:pi")).toEqual({
			action: "uninstall",
			success: true,
			dryRun: true,
			id: "acp:pi",
			ok: true,
			alreadyInstalled: true,
			wouldUninstall: true,
			writes: ["agent installed flag"],
		});
		expect(requests).toEqual([
			'{"id":"acp:pi","dryRun":true}',
			'{"id":"acp:pi","dryRun":true}',
		]);
	} finally {
		server.stop(true);
	}
});

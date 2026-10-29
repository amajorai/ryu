/* @jsxImportSource @opentui/react */
import { afterEach, expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import {
	type ApiTarget,
	type RyuFetch,
	setSurfaceProvider,
	setUserJwtProvider,
} from "@ryuhq/core-client/client";
import { act } from "react";
import {
	ContributionsProvider,
	useContributions,
	useSurfaceView,
} from "../core/ContributionsContext.tsx";
import { CoreProvider, useCore } from "../core/CoreContext.tsx";
import { testRender } from "./cli-test-render.ts";

interface DelegatedContributionReadObservation {
	authorization: string | null;
	jwt: string | null;
	signal: RequestInit["signal"];
}

type Rendered = Awaited<ReturnType<typeof testRender>>;
let rendered: Rendered | undefined;
afterEach(async () => {
	await act(async () => {
		rendered?.renderer.destroy();
	});
	rendered = undefined;
	setSurfaceProvider(() => null);
	setUserJwtProvider(() => null);
});

function deferredResponse() {
	let resolve: (response: Response) => void = () => {
		throw new Error("Response gate not initialized");
	};
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function content(identity: string) {
	return Response.json({
		views: [
			{
				id: "surface:calendar",
				plugin: `com.example.${identity}`,
				title: `${identity} calendar`,
				view: "list-detail",
				spec: { view: "list-detail", items: [] },
			},
		],
		slash_commands: [
			{
				command: `${identity}-command`,
				plugin: `com.example.${identity}`,
				description: `${identity} action`,
			},
		],
	});
}

// A rendered consumer of the real shared provider, not a replacement fetch/state
// implementation. Keyboard actions use the real Core target setter and reload.
function Consumer({ member }: { member: ApiTarget }) {
	const { setTarget } = useCore();
	const { views, slashCommands, slashCommandState, loading, reload } =
		useContributions();
	const claimed = useSurfaceView("calendar");
	useKeyboard((key) => {
		if (key.name === "b") {
			setTarget(member);
		}
		if (key.name === "r") {
			reload();
		}
	});
	return (
		<box flexDirection="column">
			<text>{loading ? "Loading contributions" : "Settled contributions"}</text>
			<text>{`Commands ${slashCommandState}`}</text>
			<text>{`Views: ${views.map((view) => view.title).join(",")}`}</text>
			<text>{`Commands: ${slashCommands.map((command) => command.name).join(",")}`}</text>
			<text>{`Claim: ${claimed?.title ?? "Built-in calendar"}`}</text>
		</box>
	);
}
async function frameUntil(predicate: (frame: string) => boolean) {
	const current = rendered;
	if (!current) {
		throw new Error("Renderer missing");
	}
	await act(async () => {
		await current.renderOnce();
	});
	let frame = current.captureCharFrame();
	const deadline = performance.now() + 1500;
	while (!predicate(frame) && performance.now() < deadline) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await current.renderOnce();
		});
		frame = current.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(
			`Contribution frame did not reach the expected state:\n${frame}`
		);
	}
	return frame;
}
async function press(name: string) {
	if (!rendered) {
		throw new Error("Renderer missing");
	}
	const current = rendered;
	const keyInput = current.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name,
				ctrl: false,
				shift: false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: name,
				source: "raw",
			})
		);
		await current.renderOnce();
	});
}

test("same-node delegated identity removes old views/commands while pending, refuses stale completion, and retries with exact member credentials", async () => {
	setSurfaceProvider(() => "cli");
	setUserJwtProvider(() => "unrelated-account-token");
	const oldReload = deferredResponse();
	const memberRead = deferredResponse();
	const memberRetry = deferredResponse();
	const calls: DelegatedContributionReadObservation[] = [];
	const responses = [
		Promise.resolve(content("owner")),
		oldReload.promise,
		memberRead.promise,
		memberRetry.promise,
	];
	const transport: RyuFetch = (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		expect(url).toBe(
			"https://same-node.example.test/api/plugins/contributions"
		);
		expect(init?.method ?? "GET").toBe("GET");
		expect(init?.body).toBeUndefined();
		const headers = new Headers(init?.headers);
		expect(headers.get("X-Ryu-Surface")).toBe("cli");
		calls.push({
			authorization: headers.get("authorization"),
			jwt: headers.get("x-ryu-user-jwt"),
			signal: init?.signal,
		});
		const response = responses.shift();
		if (!response) {
			throw new Error("Unexpected extra contributions request");
		}
		// Deliberately ignore cancellation: late responses must be fenced by the
		// actual provider even when a remote transport cannot stop its request.
		return response;
	};
	const owner: ApiTarget = {
		url: "https://same-node.example.test",
		token: "node-admission",
		userJwt: "owner-delegation",
		fetch: transport,
	};
	const member: ApiTarget = { ...owner, userJwt: "member-delegation" };
	await act(async () => {
		rendered = await testRender(
			<CoreProvider initial={owner}>
				<ContributionsProvider>
					<Consumer member={member} />
				</ContributionsProvider>
			</CoreProvider>,
			{ width: 120, height: 20 }
		);
		await rendered.renderOnce();
	});
	await frameUntil(
		(frame) =>
			frame.includes("owner calendar") && frame.includes("owner-command")
	);
	await press("r");
	await frameUntil(() => calls.length === 2);
	await press("b");
	let frame = await frameUntil(() => calls.length === 3);
	expect(calls[1]?.signal?.aborted).toBe(true);
	expect(frame).toContain("Loading contributions");
	expect(frame).toContain("Commands loading");
	expect(frame).not.toContain("owner calendar");
	expect(frame).not.toContain("owner-command");
	await act(async () => {
		memberRead.resolve(
			Response.json({ error: "member access refused" }, { status: 403 })
		);
	});
	frame = await frameUntil((value) => value.includes("Commands error"));
	expect(frame).not.toContain("owner-command");
	expect(frame).not.toContain("owner calendar");
	await act(async () => {
		oldReload.resolve(content("stale-owner"));
	});
	frame = await frameUntil((value) => value.includes("Commands error"));
	expect(frame).not.toContain("stale-owner");
	await press("r");
	await frameUntil(() => calls.length === 4);
	await act(async () => {
		memberRetry.resolve(content("member"));
	});
	frame = await frameUntil(
		(value) =>
			value.includes("member calendar") &&
			value.includes("member-command") &&
			value.includes("Commands ready")
	);
	expect(frame).not.toContain("owner");
	expect(calls.map(({ authorization, jwt }) => [authorization, jwt])).toEqual([
		["Bearer node-admission", "owner-delegation"],
		["Bearer node-admission", "owner-delegation"],
		["Bearer node-admission", "member-delegation"],
		["Bearer node-admission", "member-delegation"],
	]);
	expect(responses).toHaveLength(0);
});

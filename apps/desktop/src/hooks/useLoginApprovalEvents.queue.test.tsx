// A second sign-in started while the first prompt is on screen must be shown
// once the first is handled, and a prompt the user closed must stay closed.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import type {
	LoginApprovalEvent,
	LoginApprovalRequest,
} from "@ryu/auth/lib/login-approval-client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

let snapshot: LoginApprovalRequest[] = [];
let emit: (event: LoginApprovalEvent) => void = () => undefined;
const resolved: string[] = [];

mock.module("@/lib/auth-client.ts", () => ({
	BACKEND_URL: "http://auth.test",
	getActiveToken: () => "token-1",
	getActiveUserId: () => "user-1",
	TOKEN_KEY: "ryu_session_token",
	useSession: () => ({ data: { user: { id: "user-1" } } }),
}));
mock.module("@ryu/auth/lib/login-approval-client", () => ({
	approveLoginApproval: (_base: string, id: string) => {
		resolved.push(id);
		return Promise.resolve();
	},
	denyLoginApproval: (_base: string, id: string) => {
		resolved.push(id);
		return Promise.resolve();
	},
	LOGIN_APPROVAL_STABLE_CONNECTION_MS: 30_000,
	listLoginApprovals: () => Promise.resolve(snapshot),
	loginApprovalRetryDelay: () => 1000,
	streamLoginApprovals: (
		_base: string,
		_auth: unknown,
		onEvent: (event: LoginApprovalEvent) => void,
		signal: AbortSignal
	) => {
		emit = onEvent;
		return new Promise<void>((resolve) => {
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
	},
}));
mock.module("@ryu/blocks/web/login-approval.tsx", () => ({
	LoginApprovalPrompt: (props: {
		onApprove: () => void;
		onOpenChange: (open: boolean) => void;
		request: LoginApprovalRequest;
	}) => (
		<div data-request={props.request.id}>
			<button onClick={props.onApprove} type="button">
				approve
			</button>
			<button onClick={() => props.onOpenChange(false)} type="button">
				close
			</button>
		</div>
	),
}));

const { LoginApprovalEvents } = await import("./useLoginApprovalEvents.tsx");

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let container: HTMLDivElement;
let root: Root;

function request(id: string): LoginApprovalRequest {
	return {
		clientId: "ryu-desktop",
		createdAt: new Date().toISOString(),
		deviceLabel: id,
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
		id,
		ipAddress: null,
		status: "pending",
		surface: "desktop",
		userAgent: null,
		userCode: "ABCD1234",
	};
}

function shown(): string | null {
	return (
		container.querySelector("[data-request]")?.getAttribute("data-request") ??
		null
	);
}

async function click(label: string): Promise<void> {
	const button = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === label
	);
	await act(async () => {
		button?.click();
		await Bun.sleep(1);
	});
}

beforeEach(async () => {
	snapshot = [request("a")];
	resolved.length = 0;
	container = document.createElement("div");
	root = createRoot(container);
	await act(async () => {
		root.render(<LoginApprovalEvents />);
		await Bun.sleep(1);
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
});

it("shows a request created while another is on screen once that one is handled", async () => {
	expect(shown()).toBe("a");
	await act(async () => emit({ request: request("b"), type: "created" }));
	expect(shown()).toBe("a");
	await click("approve");
	expect(resolved).toEqual(["a"]);
	expect(shown()).toBe("b");
});

it("keeps a closed prompt closed when its created event is replayed", async () => {
	await click("close");
	expect(shown()).toBeNull();
	await act(async () => emit({ request: request("a"), type: "created" }));
	expect(shown()).toBeNull();
});

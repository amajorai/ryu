import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import type { Alert } from "@/src/lib/api/monitors.ts";
import type { Quest } from "@/src/lib/api/quests.ts";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const nativeAbortController = globalThis.AbortController;
const nativeAbortSignal = globalThis.AbortSignal;
const nativeReadableStream = globalThis.ReadableStream;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(globalThis, "AbortController", nativeAbortController);
Reflect.set(globalThis, "AbortSignal", nativeAbortSignal);
Reflect.set(globalThis, "ReadableStream", nativeReadableStream);
let node = { url: "", token: "node-a", userJwt: "user-a" };
let availability: "online" | "away" = "online";
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/hooks/useUserAvailability.ts", () => ({
	useUserAvailability: () => ({ status: availability }),
}));
const { createRoot } = await import("react-dom/client");
const { Toaster, toast } = await import("@ryu/ui/components/sileo.tsx");
const { useApprovalEvents } = await import("@/src/hooks/useApprovalEvents.ts");
const { useQuestEvents } = await import("@/src/hooks/useQuestEvents.ts");
const { useDesktopNotificationsStream } = await import(
	"@/src/hooks/useDesktopNotificationsStream.ts"
);
const { useMonitorAlertsStream } = await import(
	"@/src/hooks/useMonitorAlertsStream.ts"
);
const { listApprovals } = await import("@/src/lib/api/approvals.ts");
const { listQuests } = await import("@/src/lib/api/quests.ts");
const { listAllAlerts } = await import("@/src/lib/api/monitors.ts");
type Channel = "approvals" | "quests" | "monitors";
interface Rows {
	approvals: ApprovalRequest[];
	monitors: Alert[];
	quests: Quest[];
}
interface Connection {
	closed: boolean;
	controller: ReadableStreamDefaultController<Uint8Array>;
	jwt: string | null;
	origin: string;
	token: string | null;
}
let connections: Connection[];
let signals: AbortSignal[];
let unexpected: string[];
let calls: {
	path: string;
	token: string | null;
	jwt: string | null;
	origin: string;
}[];
let rows: Map<string, Rows>;
let servers: ReturnType<typeof Bun.serve>[];
let root: Root;
let container: HTMLDivElement;
let qc: QueryClient;
let info: ReturnType<typeof spyOn<typeof toast, "info">>;
let success: ReturnType<typeof spyOn<typeof toast, "success">>;
let error: ReturnType<typeof spyOn<typeof toast, "error">>;
const originalNotification = globalThis.Notification;
let osCalls: number;
let permission: NotificationPermission;
let permissionRequests: number;
let osNotices: { title: string; body: string | null; tag: string | null }[];
class DeniedNotification {
	static get permission() {
		return permission;
	}
	static requestPermission() {
		permissionRequests++;
		// Never resolves: events must not prompt, so a request would hang visibly.
		return new Promise<NotificationPermission>(() => undefined);
	}
	constructor(title: string, options?: NotificationOptions) {
		osCalls++;
		osNotices.push({
			title,
			body: options?.body ?? null,
			tag: options?.tag ?? null,
		});
	}
}

function identity(token: string | null, jwt: string | null, origin: string) {
	return JSON.stringify([origin, token, jwt]);
}
function connectionAt(index = 0) {
	const value = connections[index];
	if (!value) {
		throw new Error("Missing actual HTTP connection");
	}
	return value;
}
function signalAt(index = 0) {
	const value = signals[index];
	if (!value) {
		throw new Error("Missing actual native fetch signal");
	}
	return value;
}
function serverOrigin(index = 0) {
	const value = servers[index];
	if (!value) {
		throw new Error("Missing owned server");
	}
	return value.url.origin;
}
function createHost() {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request): Response {
			const u = new URL(request.url);
			const token = request.headers.get("authorization");
			const jwt = request.headers.get("x-ryu-user-jwt");
			calls.push({ path: u.pathname + u.search, token, jwt, origin: u.origin });
			if (
				request.method !== "GET" ||
				!(
					(token === "Bearer node-a" &&
						(jwt === "user-a" || jwt === "user-b")) ||
					(token === "Bearer node-b" && jwt === "user-a")
				)
			) {
				unexpected.push(`${request.method} ${request.url} ${token}/${jwt}`);
				return NativeResponse.json(
					{ error: "Unknown transport contract" },
					{ status: 503 }
				);
			}
			const k = identity(token, jwt, u.origin);
			const data = rows.get(k) ?? { approvals: [], quests: [], monitors: [] };
			if (u.pathname === "/api/approvals" && u.search === "?include=app_jobs") {
				return NativeResponse.json({ approvals: data.approvals });
			}
			if (u.pathname === "/api/quests" && u.search === "") {
				return NativeResponse.json({ quests: data.quests });
			}
			if (u.pathname === "/api/monitors/alerts" && u.search === "?limit=100") {
				return NativeResponse.json({ alerts: data.monitors });
			}
			if (
				u.pathname !== "/api/events/all" ||
				u.search !== "" ||
				request.headers.get("accept") !== "text/event-stream"
			) {
				unexpected.push(request.url);
				return NativeResponse.json({ error: "Unknown route" }, { status: 503 });
			}
			let connection: Connection | undefined;
			let timer: ReturnType<typeof setInterval> | undefined;
			const close = () => {
				if (connection) {
					connection.closed = true;
				}
				if (timer) {
					clearInterval(timer);
				}
			};
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					connection = {
						controller,
						closed: false,
						token,
						jwt,
						origin: u.origin,
					};
					connections.push(connection);
					request.signal.addEventListener("abort", close, { once: true });
					controller.enqueue(new TextEncoder().encode(": connected\n\n"));
					timer = setInterval(() => {
						try {
							controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
						} catch {
							close();
						}
					}, 50);
				},
				cancel() {
					close();
				},
			});
			return new NativeResponse(body, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
}
function Consumer() {
	useApprovalEvents();
	useQuestEvents();
	useMonitorAlertsStream();
	const key = [node.url, node.token, node.userJwt];
	const a = useQuery({
		queryKey: ["approvals", ...key],
		queryFn: () => listApprovals(node),
	});
	const q = useQuery({
		queryKey: ["quests", ...key],
		queryFn: () => listQuests(node),
	});
	const m = useQuery({
		queryKey: ["monitors", ...key],
		queryFn: () => listAllAlerts(node),
	});
	return (
		<>
			<output data-ready={a.isSuccess && q.isSuccess && m.isSuccess}>
				{[...(a.data ?? []), ...(q.data ?? []), ...(m.data ?? [])]
					.map((r) => r.title)
					.join("|")}
			</output>
			<Toaster />
		</>
	);
}
async function settle(check: () => boolean) {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > end) {
			throw new Error(
				"Native consumer did not settle " +
					JSON.stringify({ calls, view: container.textContent })
			);
		}
		await act(async () => {
			await Bun.sleep(10);
		});
	}
}
async function render() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<Consumer />
			</QueryClientProvider>
		)
	);
	await settle(
		() =>
			connections.filter((c) => !c.closed).length === 1 &&
			calls.filter((c) => c.path !== "/api/events/all").length >= 3 &&
			container.querySelector("output")?.dataset.ready === "true"
	);
}
function approval(title: string): ApprovalRequest {
	return {
		id: title,
		title,
		summary: `Summary ${title}`,
		kind: "tool_call",
		status: "pending",
		risk_tags: [],
		created_at: "2030-01-01T00:00:00Z",
	};
}
function quest(title: string): Quest {
	return {
		id: title,
		title,
		completion_condition: "Proof task completed",
		status: "open",
		created_at: "2030-01-01T00:00:00Z",
		updated_at: "2030-01-01T00:00:00Z",
	};
}
function monitor(title: string): Alert {
	return {
		id: 1,
		title,
		message: `Message ${title}`,
		monitor_id: "proof-monitor",
		monitor_name: "Proof monitor",
		kind: "change",
		acknowledged: false,
		created_at: "2030-01-01T00:00:00Z",
	};
}
async function emit(
	connection: Connection,
	channel: Channel,
	label: string,
	variant = "normal"
) {
	if (connection.closed) {
		return false;
	}
	const key = identity(connection.token, connection.jwt, connection.origin);
	const data = rows.get(key) ?? { approvals: [], quests: [], monitors: [] };
	let event: unknown;
	if (channel === "approvals") {
		const r = approval(label);
		data.approvals = [r];
		event = { type: "created", request: r };
	} else if (channel === "quests") {
		const q = quest(label);
		data.quests = [q];
		event =
			variant === "manual"
				? { type: "completed", quest: q, auto: false }
				: {
						type: "suggested",
						quest: q,
						// The quests engine reports a whole percentage (u8).
						confidence: 90,
						reason: `Reason ${label}`,
					};
	} else {
		const a = monitor(label);
		data.monitors = [a];
		event = a;
	}
	rows.set(key, data);
	await act(async () =>
		connection.controller.enqueue(
			new TextEncoder().encode(
				`event: ${channel}\ndata: ${JSON.stringify(event)}\n\n`
			)
		)
	);
	await settle(
		() =>
			container.querySelector("output")?.textContent?.includes(label) === true
	);
	return true;
}
beforeEach(() => {
	connections = [];
	signals = [];
	unexpected = [];
	calls = [];
	rows = new Map();
	availability = "online";
	osCalls = 0;
	permission = "denied";
	permissionRequests = 0;
	osNotices = [];
	globalThis.fetch = Object.assign(
		async (...args: Parameters<typeof nativeFetch>): Promise<Response> => {
			const signal = args[1]?.signal;
			if (args[0].toString().endsWith("/api/events/all") && signal) {
				signals.push(signal);
			}
			return nativeFetch(...args);
		},
		{ preconnect: nativeFetch.preconnect.bind(nativeFetch) }
	);
	Reflect.set(globalThis, "Notification", DeniedNotification);
	info = spyOn(toast, "info");
	success = spyOn(toast, "success");
	error = spyOn(toast, "error");
	servers = [createHost(), createHost()];
	node = { url: serverOrigin(), token: "node-a", userJwt: "user-a" };
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => {
		for (const spy of [info, success, error]) {
			for (const r of spy.mock.results) {
				if (r.type === "return" && typeof r.value === "string") {
					toast.dismiss(r.value);
				}
			}
		}
		root.unmount();
		await Bun.sleep(10);
	});
	qc.clear();
	for (const server of servers) {
		server.stop(true);
	}
	container.remove();
	info.mockRestore();
	success.mockRestore();
	error.mockRestore();
	globalThis.fetch = nativeFetch;
	Reflect.set(globalThis, "Notification", originalNotification);
	// Teardown refuses any request outside the fixture contract for every test.
	if (unexpected.length > 0) {
		throw new Error(
			`Unexpected fixture requests: ${JSON.stringify(unexpected)}`
		);
	}
});
test("actual three channels share one authenticated stream and refresh real SDK lists while denied OS permission still delivers in-app outcomes", async () => {
	await render();
	expect(connections).toHaveLength(1);
	expect(connections[0]).toMatchObject({
		token: "Bearer node-a",
		jwt: "user-a",
	});
	const c = connectionAt();
	await emit(c, "approvals", "Approval wire title");
	await settle(
		() => container.textContent?.includes("Approval needed") === true
	);
	expect(info).toHaveBeenCalledWith({
		title: "Approval needed",
		description: "Approval wire title",
	});
	await emit(c, "quests", "Quest wire title");
	await settle(
		() =>
			container.textContent?.includes("Looks done: Quest wire title") === true
	);
	expect(info).toHaveBeenCalledWith({
		title: "Looks done: Quest wire title",
		description: "Reason Quest wire title",
	});
	await emit(c, "monitors", "Monitor wire title");
	await settle(
		() => container.textContent?.includes("Message Monitor wire title") === true
	);
	expect(error).toHaveBeenCalledWith({
		title: "Monitor wire title",
		description: "Message Monitor wire title",
	});
	for (const path of [
		"/api/approvals?include=app_jobs",
		"/api/quests",
		"/api/monitors/alerts?limit=100",
	]) {
		expect(calls.filter((c) => c.path === path)).toHaveLength(2);
	}
	expect(osCalls).toBe(0);
	expect(signals).toHaveLength(1);
});
for (const field of ["url", "token", "userJwt"] as const) {
	test(`${field} rotation physically cancels shared old authority and only current channel messages refresh the current SDK lists`, async () => {
		await render();
		const old = connectionAt();
		const signal = signalAt();
		const priorCalls = calls.length;
		node = {
			...node,
			[field]:
				field === "url"
					? serverOrigin(1)
					: field === "token"
						? "node-b"
						: "user-b",
		};
		await render();
		await settle(() => old.closed && connections.length === 2);
		expect(signal.aborted).toBe(true);
		const fresh = connectionAt(1);
		expect(fresh).toMatchObject({
			origin: node.url,
			token: `Bearer ${node.token}`,
			jwt: node.userJwt,
		});
		expect(signals[1]?.aborted).toBe(false);
		expect(await emit(old, "approvals", "Old private approval")).toBe(false);
		await emit(fresh, "approvals", `Current ${field} approval`);
		await emit(fresh, "quests", `Current ${field} quest`);
		await emit(fresh, "monitors", `Current ${field} monitor`);
		expect(container.textContent).not.toContain("Old private approval");
		expect(info.mock.calls.map((c) => c[0])).toEqual([
			{ title: "Approval needed", description: `Current ${field} approval` },
			{
				title: `Looks done: Current ${field} quest`,
				description: `Reason Current ${field} quest`,
			},
		]);
		expect(error.mock.calls.map((c) => c[0])).toEqual([
			{
				title: `Current ${field} monitor`,
				description: `Message Current ${field} monitor`,
			},
		]);
		expect(
			calls
				.slice(priorCalls)
				.every(
					(c) =>
						c.token === `Bearer ${node.token}` &&
						c.jwt === node.userJwt &&
						c.origin === node.url
				)
		).toBe(true);
		expect(connections.filter((c) => !c.closed)).toHaveLength(1);
		expect(osCalls).toBe(0);
	});
}
test("Away approvals and manually completed quests refresh real list queries without interruption or a fake success toast", async () => {
	availability = "away";
	await render();
	const c = connectionAt();
	await emit(c, "approvals", "Quiet approval");
	await emit(c, "quests", "Manual task", "manual");
	expect(container.querySelector("output")?.textContent).toBe(
		"Quiet approval|Manual task"
	);
	expect(info).not.toHaveBeenCalled();
	expect(success).not.toHaveBeenCalled();
	expect(osCalls).toBe(0);
	expect(connections).toHaveLength(1);
});

afterAll(() => mock.restore());

function AllNotificationConsumers() {
	useDesktopNotificationsStream();
	return <Consumer />;
}
async function renderAll() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<AllNotificationConsumers />
			</QueryClientProvider>
		)
	);
	await settle(
		() =>
			connections.filter((c) => !c.closed).length === 1 &&
			container.querySelector("output")?.dataset.ready === "true"
	);
}
async function emitDesktop(connection: Connection, title: string) {
	if (connection.closed) {
		throw new Error("Cannot emit on physically closed connection");
	}
	await act(async () =>
		connection.controller.enqueue(
			new TextEncoder().encode(
				`event: notifications\ndata: ${JSON.stringify({ title, body: `Body ${title}`, level: "success" })}\n\n`
			)
		)
	);
	await settle(() => container.textContent?.includes(title) === true);
}
async function fourEvents(connection: Connection, prefix: string) {
	await emit(connection, "approvals", `${prefix} approval`);
	await emit(connection, "quests", `${prefix} quest`);
	await emit(connection, "monitors", `${prefix} monitor`);
	await emitDesktop(connection, `${prefix} desktop`);
}
function expectedNotices(prefix: string) {
	return [
		{
			title: "Approval needed",
			body: `Summary ${prefix} approval`,
			tag: `approval-${prefix} approval`,
		},
		{
			title: `Finished "${prefix} quest"?`,
			body: `Reason ${prefix} quest`,
			tag: `quest-${prefix} quest`,
		},
		{
			title: `Proof monitor: ${prefix} monitor`,
			body: `Message ${prefix} monitor`,
			tag: "monitor-proof-monitor",
		},
		{ title: `${prefix} desktop`, body: `Body ${prefix} desktop`, tag: null },
	];
}
function byTitle(notices: typeof osNotices) {
	return [...notices].sort((a, b) => a.title.localeCompare(b.title));
}
for (const field of ["url", "token", "userJwt"] as const) {
	test(`events never prompt for OS permission, and after a ${field} handoff only current payloads reach the OS`, async () => {
		permission = "default";
		await renderAll();
		const old = connectionAt();
		await fourEvents(old, `Unprompted ${field}`);
		// Permission is asked once from onboarding or Settings, never mid-session.
		expect(permissionRequests).toBe(0);
		expect(osNotices).toEqual([]);
		permission = "granted";
		await fourEvents(old, `Old ${field}`);
		await settle(() => osNotices.length === 4);
		expect(byTitle(osNotices)).toEqual(
			byTitle(expectedNotices(`Old ${field}`))
		);
		node = {
			...node,
			[field]:
				field === "url"
					? serverOrigin(1)
					: field === "token"
						? "node-b"
						: "user-b",
		};
		await renderAll();
		await settle(() => old.closed && connections.length === 2);
		expect(container.textContent).toContain(`Old ${field} desktop`);
		await fourEvents(connectionAt(1), `Current ${field}`);
		await settle(() => osNotices.length === 8);
		expect(byTitle(osNotices.slice(4))).toEqual(
			byTitle(expectedNotices(`Current ${field}`))
		);
		expect(osCalls).toBe(8);
		expect(permissionRequests).toBe(0);
		expect(success.mock.calls.map((c) => c[0])).toEqual([
			{
				title: `Unprompted ${field} desktop`,
				description: `Body Unprompted ${field} desktop`,
			},
			{
				title: `Old ${field} desktop`,
				description: `Body Old ${field} desktop`,
			},
			{
				title: `Current ${field} desktop`,
				description: `Body Current ${field} desktop`,
			},
		]);
	});
}
test("unmounting the consumers stops OS notifications with their streams", async () => {
	permission = "granted";
	await renderAll();
	await fourEvents(connectionAt(), "Mounted");
	await settle(() => osNotices.length === 4);
	await act(async () => root.unmount());
	await settle(() => connections.every((c) => c.closed));
	await act(async () => {
		await Promise.resolve();
	});
	expect(osCalls).toBe(4);
	expect(permissionRequests).toBe(0);
});

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Listener = (event: CustomEvent<Record<string, unknown>>) => void;

/** A stand-in RFB client that records how it was dialed and can emit events. */
class FakeRfb {
	static instances: FakeRfb[] = [];
	readonly listeners = new Map<string, Listener[]>();
	readonly options: { wsProtocols?: string[] } | undefined;
	readonly target: HTMLElement;
	readonly url: string;
	disconnected = false;
	resizeSession = true;
	scaleViewport = false;
	viewOnly = false;

	constructor(
		target: HTMLElement,
		url: string,
		options?: { wsProtocols?: string[] }
	) {
		this.target = target;
		this.url = url;
		this.options = options;
		FakeRfb.instances.push(this);
	}

	addEventListener(type: string, listener: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	removeEventListener(type: string, listener: Listener) {
		this.listeners.set(
			type,
			(this.listeners.get(type) ?? []).filter((entry) => entry !== listener)
		);
	}

	disconnect() {
		this.disconnected = true;
	}

	emit(type: string, detail: Record<string, unknown> = {}) {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(new CustomEvent(type, { detail }));
		}
	}
}

mock.module("@novnc/novnc", () => ({ default: FakeRfb }));

/** The `index`th client the viewer constructed; fails the test when missing. */
function rfbAt(index: number): FakeRfb {
	const rfb = FakeRfb.instances[index];
	if (!rfb) {
		throw new Error(`No RFB client #${index} was constructed`);
	}
	return rfb;
}
const { createRoot } = await import("react-dom/client");
const { VncCanvas } = await import("./vnc-canvas.tsx");

const STREAM_URL = "wss://box.example.test/v1/boxes/box-1/desktop/ws";
const PROTOCOLS = ["ryu.box.v1", "ryu.token.single-use-token"];
const roots: Root[] = [];

beforeEach(() => {
	FakeRfb.instances = [];
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
});

async function settle() {
	await act(async () => {
		await Bun.sleep(10);
	});
}

async function mount(element: React.ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(element));
	await settle();
	return { container, root };
}

test("dials the minted URL verbatim with its subprotocols and no token in the URL", async () => {
	const connect = mock(() =>
		Promise.resolve({ url: STREAM_URL, protocols: PROTOCOLS })
	);
	await mount(
		<VncCanvas connect={connect} mediaSourceId="box:conv-1" title="Box" />
	);
	expect(connect).toHaveBeenCalledTimes(1);
	expect(FakeRfb.instances).toHaveLength(1);
	const rfb = rfbAt(0);
	expect(rfb.url).toBe(STREAM_URL);
	expect(new URL(rfb.url).search).toBe("");
	expect(rfb.url).not.toContain("single-use-token");
	expect(rfb.options?.wsProtocols).toEqual(PROTOCOLS);
	expect(rfb.viewOnly).toBe(false);
	expect(rfb.scaleViewport).toBe(true);
	expect(rfb.resizeSession).toBe(false);
	// noVNC renders into a container element, never a canvas.
	expect(rfb.target.tagName).toBe("DIV");
});

test("viewOnly sets the client's viewOnly", async () => {
	await mount(
		<VncCanvas
			connect={() => Promise.resolve({ url: STREAM_URL, protocols: PROTOCOLS })}
			mediaSourceId="box:conv-1"
			title="Box"
			viewOnly
		/>
	);
	expect(rfbAt(0).viewOnly).toBe(true);
});

test("an unclean drop re-mints through connect() before dialing again", async () => {
	let minted = 0;
	const connect = mock(() => {
		minted += 1;
		return Promise.resolve({
			url: STREAM_URL,
			protocols: ["ryu.box.v1", `ryu.token.t${minted}`],
		});
	});
	const statuses: string[] = [];
	await mount(
		<VncCanvas
			connect={connect}
			mediaSourceId="box:conv-1"
			onStatusChange={(status) => statuses.push(status)}
			reconnectDelaysMs={[0]}
			title="Box"
		/>
	);
	const first = rfbAt(0);
	await act(async () => first.emit("connect"));
	expect(statuses).toContain("connected");
	await act(async () => first.emit("disconnect", { clean: false }));
	await settle();
	expect(connect).toHaveBeenCalledTimes(2);
	expect(FakeRfb.instances).toHaveLength(2);
	expect(rfbAt(1).options?.wsProtocols).toEqual(["ryu.box.v1", "ryu.token.t2"]);
	expect(statuses).toContain("reconnecting");
});

test("a clean close stops without retrying and says so", async () => {
	const connect = mock(() =>
		Promise.resolve({ url: STREAM_URL, protocols: PROTOCOLS })
	);
	const { container } = await mount(
		<VncCanvas
			connect={connect}
			mediaSourceId="box:conv-1"
			reconnectDelaysMs={[0]}
			title="Box"
		/>
	);
	await act(async () => rfbAt(0).emit("connect"));
	await act(async () => rfbAt(0).emit("disconnect", { clean: true }));
	await settle();
	expect(connect).toHaveBeenCalledTimes(1);
	expect(container.textContent).toContain("The screen disconnected.");
});

test("refuses a relative or non-WebSocket URL without dialing", async () => {
	const { container } = await mount(
		<VncCanvas
			connect={() =>
				Promise.resolve({ url: "/v1/boxes/box-1/desktop/ws", protocols: [] })
			}
			mediaSourceId="box:conv-1"
			reconnectDelaysMs={[]}
			title="Box"
		/>
	);
	expect(FakeRfb.instances).toHaveLength(0);
	expect(container.textContent).toContain("not an absolute URL");
});

test("a failed mint shows the error once retries run out", async () => {
	const connect = mock(() =>
		Promise.reject(new Error("This session's Box is parked."))
	);
	const { container } = await mount(
		<VncCanvas
			connect={connect}
			mediaSourceId="box:conv-1"
			reconnectDelaysMs={[0]}
			title="Box"
		/>
	);
	await settle();
	expect(connect).toHaveBeenCalledTimes(2);
	expect(container.textContent).toContain("This session's Box is parked.");
	expect(
		container
			.querySelector("[data-vnc-status]")
			?.getAttribute("data-vnc-status")
	).toBe("error");
});

test("credentials prompts are refused and the client disconnected", async () => {
	await mount(
		<VncCanvas
			connect={() => Promise.resolve({ url: STREAM_URL, protocols: PROTOCOLS })}
			mediaSourceId="box:conv-1"
			title="Box"
		/>
	);
	const rfb = rfbAt(0);
	await act(async () => rfb.emit("credentialsrequired"));
	expect(rfb.disconnected).toBe(true);
});

test("unmount disconnects the client and clears the preview", async () => {
	const cleared: string[] = [];
	const frames: string[] = [];
	const { root } = await mount(
		<VncCanvas
			connect={() => Promise.resolve({ url: STREAM_URL, protocols: PROTOCOLS })}
			mediaSourceId="box:conv-1"
			onPreviewClear={(id) => cleared.push(id)}
			onPreviewFrame={(frame) => frames.push(frame.id)}
			title="Box"
		/>
	);
	const rfb = rfbAt(0);
	await act(async () => rfb.emit("connect"));
	await act(async () => root.unmount());
	roots.splice(roots.indexOf(root), 1);
	expect(rfb.disconnected).toBe(true);
	expect(cleared).toEqual(["box:conv-1"]);
});

test("an inactive viewer does not connect", async () => {
	const connect = mock(() =>
		Promise.resolve({ url: STREAM_URL, protocols: PROTOCOLS })
	);
	await mount(
		<VncCanvas
			active={false}
			connect={connect}
			mediaSourceId="box:conv-1"
			title="Box"
		/>
	);
	expect(connect).not.toHaveBeenCalled();
});

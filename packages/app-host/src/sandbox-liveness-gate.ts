// Window-message gate for `ExtensionHost`'s sandbox-page transport (the MV3
// extension dashboard).
//
// WHY: a companion can navigate its own frame (`location.href = …`), and CSP
// `connect-src 'none'` does not govern navigation. The new document lives in the
// same iframe, so `event.source === iframe.contentWindow` still holds and its
// window-level messages (MCP Apps JSON-RPC, `onMessage` frames) look exactly
// like the companion's. The frame's `load` event is no gate: an attacker server
// can hold the response open, so `load` never fires while its scripts run.
//
// The one thing a navigated document cannot inherit is the channel port: port2
// lives in the companion's realm and dies with it (a port cannot ride in a URL).
// So each window-level message is delivered only after a fresh, unguessable probe
// sent over the live port is acknowledged by the realm that holds port2. A
// navigated document never sees the probe and its messages are never delivered.
// Messages that arrive before the port lands are held (bounded) until it does.

/** Host → frame over the port: "prove you still hold the port". */
export const LIVENESS_PROBE_KIND = "ryu-plugin-liveness";
/** Frame → host over the port: echoes the probe id. */
export const LIVENESS_ACK_KIND = "ryu-plugin-liveness-ack";

/** Upper bound on held or unacknowledged window messages per frame. */
export const MAX_GATED_MESSAGES = 64;

/** The bootstrap's port-side responder, interpolated into `onPortMessage`. */
export function livenessResponderScript(): string {
	return `if (msg.kind === ${JSON.stringify(LIVENESS_PROBE_KIND)}) { port.postMessage({ kind: ${JSON.stringify(LIVENESS_ACK_KIND)}, id: msg.id }); return; }`;
}

interface ProbePort {
	postMessage(message: unknown): void;
}

export interface LivenessGate {
	/** Deliver once the realm holding the port acknowledges a probe. */
	admit(deliver: () => void): void;
	/** The port was transferred: probe every held message. */
	attach(port: ProbePort): void;
	/** Drop everything held; nothing is delivered afterwards. */
	dispose(): void;
	/** Consume a port message; true when it was a liveness ack. */
	handlePortMessage(data: unknown): boolean;
}

function isAck(data: unknown): data is { kind: string; id?: unknown } {
	return (
		typeof data === "object" &&
		data !== null &&
		(data as { kind?: unknown }).kind === LIVENESS_ACK_KIND
	);
}

export function createLivenessGate(
	newId: () => string = () => crypto.randomUUID()
): LivenessGate {
	let port: ProbePort | null = null;
	let disposed = false;
	let held: Array<() => void> = [];
	const pending = new Map<string, () => void>();

	const probe = (target: ProbePort, deliver: () => void) => {
		if (pending.size >= MAX_GATED_MESSAGES) {
			return;
		}
		const id = newId();
		pending.set(id, deliver);
		target.postMessage({ kind: LIVENESS_PROBE_KIND, id });
	};

	return {
		admit(deliver) {
			if (disposed) {
				return;
			}
			if (port) {
				probe(port, deliver);
			} else if (held.length < MAX_GATED_MESSAGES) {
				held.push(deliver);
			}
		},
		attach(target) {
			if (disposed || port) {
				return;
			}
			port = target;
			const queued = held;
			held = [];
			for (const deliver of queued) {
				probe(target, deliver);
			}
		},
		dispose() {
			disposed = true;
			port = null;
			held = [];
			pending.clear();
		},
		handlePortMessage(data) {
			if (!isAck(data)) {
				return false;
			}
			const id = typeof data.id === "string" ? data.id : null;
			const deliver = id === null ? undefined : pending.get(id);
			if (id !== null && deliver && !disposed) {
				pending.delete(id);
				deliver();
			}
			return true;
		},
	};
}

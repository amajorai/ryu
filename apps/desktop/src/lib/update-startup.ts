import { invokeWhenReady } from "./tauri-ready.ts";

export interface UpdateStartupBridge {
	acknowledge: () => Promise<boolean>;
	health: () => Promise<boolean | null>;
}

const nativeBridge: UpdateStartupBridge = {
	acknowledge: () => invokeWhenReady<boolean>("acknowledge_update_startup"),
	health: () => invokeWhenReady<boolean | null>("get_update_startup_health"),
};

export function waitForStartupPaint(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		let first = 0;
		let second = 0;
		const finish = () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(second);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		signal.addEventListener("abort", finish, { once: true });
		first = requestAnimationFrame(() => {
			second = requestAnimationFrame(finish);
		});
	});
}

function waitForRuntime(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, 500);
		signal.addEventListener("abort", finish, { once: true });
	});
}

// Native readiness is queried first, but the renderer publishes health only
// after it stays mounted through two animation frames. Unmounting or a crash
// boundary cancels the handshake before the acknowledgement command is sent.
export async function reportUpdateStartup({
	bridge = nativeBridge,
	paint = waitForStartupPaint,
	signal,
	timeoutMilliseconds = 120_000,
}: {
	bridge?: UpdateStartupBridge;
	paint?: (signal: AbortSignal) => Promise<void>;
	signal: AbortSignal;
	timeoutMilliseconds?: number;
}): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (!signal.aborted && Date.now() < deadline) {
		const health = await bridge.health();
		if (signal.aborted || health === null) {
			return;
		}
		if (health) {
			await paint(signal);
			if (signal.aborted) {
				return;
			}
			if (await bridge.acknowledge()) {
				// Acknowledgement requests commit; the guard can still roll back.
				while (!signal.aborted && Date.now() < deadline) {
					if ((await bridge.health()) === null) {
						return;
					}
					await waitForRuntime(signal);
				}
				break;
			}
		}
		await waitForRuntime(signal);
	}
	if (!signal.aborted) {
		throw new Error(
			"Update startup did not become healthy before its deadline"
		);
	}
}

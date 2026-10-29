import type { RealtimeConnection as NativeRealtimeConnection } from "@ryuhq/core-client/realtime.ts";

declare global {
	interface Window {
		__homeDashboardProof?: { notifyResourceChanged: () => void };
	}
}

export class RealtimeConnection {
	constructor(
		_target: ConstructorParameters<typeof NativeRealtimeConnection>[0],
		options: ConstructorParameters<typeof NativeRealtimeConnection>[1]
	) {
		const handlers = options.handlers;
		window.__homeDashboardProof = {
			notifyResourceChanged: () =>
				handlers?.onNamedEvent?.({ data: null, name: "resource.changed" }),
		};
	}

	connect() {}

	close() {}

	sendEvent(
		_name: Parameters<NativeRealtimeConnection["sendEvent"]>[0],
		_payload: Parameters<NativeRealtimeConnection["sendEvent"]>[1]
	) {}
}

import type {
	NotificationAction,
	NotificationEvent,
	NotificationLevel,
} from "../../apps/notify/src/contracts.ts";

export interface NotifyEventInput {
	actions?: NotificationAction[];
	body?: string;
	data?: Record<string, unknown>;
	externalId?: string;
	fingerprint?: string;
	level?: NotificationLevel;
	recipient?: string;
	source?: string;
	title: string;
	type?: string;
}

export interface NotifyClientOptions {
	apiKey: string;
	baseUrl: string;
	fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventFrom(value: unknown): NotificationEvent {
	if (!(isRecord(value) && typeof value.id === "string")) {
		throw new Error("Ryu Notify returned an invalid event response.");
	}
	return value as NotificationEvent;
}

/** Small fetch client used by the Box and Agent Mail examples. */
export function createNotifyClient(options: NotifyClientOptions) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = options.baseUrl.replace(/\/$/u, "");

	return {
		async publish(
			input: NotifyEventInput,
			idempotencyKey: string
		): Promise<NotificationEvent> {
			const response = await fetchImpl(`${baseUrl}/v1/events`, {
				body: JSON.stringify(input),
				headers: {
					Authorization: `Bearer ${options.apiKey}`,
					"Content-Type": "application/json",
					"Idempotency-Key": idempotencyKey,
				},
				method: "POST",
			});
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new Error(`Ryu Notify returned HTTP ${response.status}.`);
			}
			if (!response.ok) {
				const message =
					isRecord(payload) && typeof payload.message === "string"
						? payload.message
						: `HTTP ${response.status}`;
				throw new Error(`Ryu Notify publish failed: ${message}`);
			}
			if (!(isRecord(payload) && "event" in payload)) {
				throw new Error("Ryu Notify returned no event.");
			}
			return eventFrom(payload.event);
		},
	};
}

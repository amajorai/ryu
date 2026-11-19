// A companion's `app.request` reaches its sidecar through Desktop's `request`,
// which rejects a non-2xx response with an `ApiError` whose message is transport
// text (`"<path> failed: <status>"`). That text alone never carries a backend's
// refusal sentence ("This trip changed since you opened it."), so the relay adds
// the server's own reason, under three limits:
//
// - only for a request to the companion's OWN app: a companion holding
//   `app:http:<other>` still sees only the status of the other app's failure;
// - only for a 4xx, whose body is client-facing by HTTP convention (a 5xx body is
//   treated as internal text and never crosses);
// - sanitized and length-capped in `AppRequestRpcError` / `toRpcError`.
//
// When there is no reason to relay, the original `ApiError` is re-thrown, so its
// wire form is exactly what it was before (a plain string for a code-less
// error, `{ code, message }` for a coded one).

import {
	AppRequestRpcError,
	isClientErrorStatus,
	sanitizeRpcReason,
	type WidgetRpcErrorCode,
	widgetRpcErrorCodeSchema,
} from "@ryu/app-host/rpc-errors";
import { ApiError } from "@/src/lib/api/client.ts";

/** Whether the failed request targeted the calling companion's own app. */
export interface RelayScope {
	sameApp: boolean;
}

function relayedCode(code: string | undefined): WidgetRpcErrorCode | undefined {
	if (code === undefined) {
		return;
	}
	const parsed = widgetRpcErrorCodeSchema.safeParse(code);
	// A non-public server code keeps its historical mapping.
	return parsed.success ? parsed.data : "server_error";
}

/** The error to relay to the companion for a failed `app.request`. */
export function relayAppRequestFailure(
	error: unknown,
	scope: RelayScope
): unknown {
	if (!(error instanceof ApiError)) {
		return error;
	}
	const reason =
		scope.sameApp && isClientErrorStatus(error.status)
			? sanitizeRpcReason(error.serverMessage)
			: undefined;
	if (reason === undefined) {
		return error;
	}
	return new AppRequestRpcError({
		code: relayedCode(error.code),
		message: error.message,
		reason,
		status: error.status,
	});
}

/** `promise`, rejecting with {@link relayAppRequestFailure}'s relayed error. */
export function withRelayedFailure<T>(
	promise: Promise<T>,
	scope: RelayScope
): Promise<T> {
	return promise.catch((error: unknown) => {
		throw relayAppRequestFailure(error, scope);
	});
}

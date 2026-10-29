import {
	asAgentRunArg,
	asFinetuneIdArg,
	asRealtimeConnectionArg,
	CodedRpcError,
	type HostServices,
} from "./rpc.ts";
import { shellStreamInputSchema } from "./shell-stream-input.ts";

type ShellStreamService = NonNullable<HostServices["shellThemeSubscribe"]>;

export type RpcStream = (
	emit: (delta: string) => void,
	signal: AbortSignal
) => Promise<void>;

/** Resolve a validated streaming method. Hosts still enforce grants before calling. */
export function resolveRpcStream(
	method: string,
	args: readonly unknown[],
	services: Partial<HostServices>
): RpcStream {
	let start:
		| ((emit: (delta: string) => void, signal: AbortSignal) => Promise<void>)
		| undefined;
	let streamError: CodedRpcError | undefined;
	const shellArg = shellStreamInputSchema.parse(args[0]);
	const bindShellStream = (svc: ShellStreamService | undefined) => {
		if (svc) {
			start = (emit, signal) => svc(shellArg, emit, signal);
		} else {
			streamError = new CodedRpcError(
				"server_error",
				`${method} is not available`
			);
		}
	};
	if (method === "shell.themeSubscribe") {
		bindShellStream(services.shellThemeSubscribe);
	} else if (method === "shell.prefsSubscribe") {
		bindShellStream(services.shellPrefsSubscribe);
	} else if (method === "shell.registerCommand") {
		bindShellStream(services.shellRegisterCommand);
	} else if (method === "shell.registerTabIcon") {
		bindShellStream(services.shellRegisterTabIcon);
	} else if (method === "shell.eventsSubscribe") {
		bindShellStream(services.shellEventsSubscribe);
	} else if (method === "i18n.subscribe") {
		bindShellStream(services.i18nSubscribe);
	} else if (method === "finetune.stream") {
		const arg = asFinetuneIdArg(args[0]);
		const svc = services.finetuneStream;
		if (!arg) {
			streamError = new CodedRpcError(
				"invalid_args",
				"finetune.stream requires a { id: string }"
			);
		} else if (svc) {
			start = (emit, signal) => svc(arg, emit, signal);
		} else {
			streamError = new CodedRpcError(
				"server_error",
				"finetune.stream is not available"
			);
		}
	} else if (method === "realtime.subscribe") {
		const arg = asRealtimeConnectionArg(args[0]);
		const svc = services.realtimeSubscribe;
		if (!arg) {
			streamError = new CodedRpcError(
				"invalid_args",
				"realtime.subscribe requires a { connection_id: string }"
			);
		} else if (svc) {
			start = (emit, signal) => svc(arg, emit, signal);
		} else {
			streamError = new CodedRpcError(
				"server_error",
				"realtime.subscribe is not available"
			);
		}
	} else if (method === "agent.run.stream") {
		const arg = asAgentRunArg(args[0]);
		const svc = services.runAgentStream;
		if (!arg) {
			streamError = new CodedRpcError(
				"invalid_args",
				"agent.run.stream requires a { task: string }"
			);
		} else if (svc) {
			start = (emit, signal) => svc(arg, emit, signal);
		} else {
			streamError = new CodedRpcError(
				"server_error",
				"agent.run.stream is not available"
			);
		}
	}
	if (!start) {
		throw (
			streamError ??
			new CodedRpcError("server_error", `${method} is not available`)
		);
	}
	return start;
}

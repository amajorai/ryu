export interface AutopilotProofCall {
	args?: unknown;
	method: "agent.run" | "catalog.snapshot" | "storage.get" | "storage.set";
	result?: unknown;
}

export interface AutopilotProofApi {
	calls: () => AutopilotProofCall[];
	clearCalls: () => void;
	connected: () => boolean;
	failNextAgent: (message: string) => void;
	failNextStorageSet: (message: string) => void;
	mount: (input: { appHtml: string; section?: string }) => void;
	reset: () => void;
	setAgentReply: (reply: string) => void;
	storedState: () => string | null;
}

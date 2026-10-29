export interface SitesCall {
	body?: unknown;
	method: string;
	path: string;
	result?: unknown;
	status: number;
}

export interface ModelCall {
	prompt: string;
	system?: string;
}

export interface SitesProofApi {
	calls: () => SitesCall[];
	clearCalls: () => void;
	connected: () => boolean;
	failNext: (method: string, path: string, message: string) => void;
	failNextModel: (message: string) => void;
	modelCalls: () => ModelCall[];
	mount: (input: { appHtml: string }) => void;
	openedExternal: () => string[];
	setModelResponse: (response: string) => void;
}

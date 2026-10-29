import * as core from "@actions/core";
import type { JsonValue } from "./json.ts";

export interface ActionRuntime {
	exportVariable: (name: string, value: string) => void;
	/** GitHub OIDC ID token (needs `permissions: id-token: write`). */
	getIDToken?: (audience?: string) => Promise<string>;
	getInput: (name: string) => string;
	info: (message: string) => void;
	setOutput: (name: string, value: JsonValue | undefined) => void;
	setSecret: (value: string) => void;
	warning: (message: string) => void;
}

export const githubRuntime: ActionRuntime = {
	exportVariable: (name, value) => core.exportVariable(name, value),
	getIDToken: (audience) => core.getIDToken(audience),
	getInput: (name) => core.getInput(name),
	info: (message) => core.info(message),
	setOutput: (name, value) => core.setOutput(name, value),
	setSecret: (value) => core.setSecret(value),
	warning: (message) => core.warning(message),
};

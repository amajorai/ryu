import {
	emptyEnvironmentScripts,
	type ProjectEnvironment,
} from "@/src/store/useWorkspaceStore.ts";

export const newId = (): string => crypto.randomUUID();

export const newEnvironment = (name = "Local"): ProjectEnvironment => ({
	id: newId(),
	name,
	setup: emptyEnvironmentScripts(),
	cleanup: emptyEnvironmentScripts(),
	variables: [],
	actions: [],
});

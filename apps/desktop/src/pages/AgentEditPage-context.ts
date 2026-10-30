import type { AgentEditBase } from "./AgentEditPage-base.ts";
import type { AgentEditComposio } from "./AgentEditPage-composio.ts";
import type { AgentEditFormState } from "./AgentEditPage-form-state.ts";
import type { AgentEditHealth } from "./AgentEditPage-health.ts";
import type { AgentEditHydrate } from "./AgentEditPage-hydrate.ts";
import type { AgentEditLoaders } from "./AgentEditPage-loaders.ts";
import type { AgentEditPostureActions } from "./AgentEditPage-posture-actions.ts";
import type { AgentEditSave } from "./AgentEditPage-save.ts";
import type { AgentEditVersions } from "./AgentEditPage-versions.tsx";

export type AgentEditContext = AgentEditBase &
	AgentEditFormState &
	AgentEditComposio &
	AgentEditLoaders &
	AgentEditHydrate &
	AgentEditSave &
	AgentEditPostureActions &
	AgentEditVersions &
	AgentEditHealth;

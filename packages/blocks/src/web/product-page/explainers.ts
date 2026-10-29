import type { ProductExplainer } from "./explainer-types.ts";
import { AGENT_API_EXPLAINERS } from "./explainers-agent-apis.ts";
import { BUILD_EXPLAINERS } from "./explainers-build.ts";
import { PLATFORM_EXPLAINERS } from "./explainers-platform.ts";
import { WORKSPACE_EXPLAINERS } from "./explainers-workspaces.ts";

/** Every product page's explainer sections, by product slug. */
export const PRODUCT_EXPLAINERS: Readonly<Record<string, ProductExplainer>> = {
	...PLATFORM_EXPLAINERS,
	...AGENT_API_EXPLAINERS,
	...BUILD_EXPLAINERS,
	...WORKSPACE_EXPLAINERS,
};

const NO_EXPLAINER: ProductExplainer = {};

export function getProductExplainer(slug: string): ProductExplainer {
	return PRODUCT_EXPLAINERS[slug] ?? NO_EXPLAINER;
}

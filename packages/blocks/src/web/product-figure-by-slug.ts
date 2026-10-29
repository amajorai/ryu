import type { StageProductSlug } from "./backgrounds/stage-routes.ts";
import type { ProductFigureId } from "./product-figure.tsx";

/**
 * The Anatomy figure each product page shows under its stage hero. Kept beside
 * the product data rather than in it, so the catalogue stays plain data. Every
 * stage product has one, which the type enforces.
 */
export const PRODUCT_FIGURE_BY_SLUG: Record<StageProductSlug, ProductFigureId> =
	{
		core: "core-engines",
		gateway: "gateway-pipeline",
		passport: "passport-cabinet",
		workflows: "workflow-run",
		box: "sandbox-glovebox",
		desktop: "desktop-dock",
		bot: "bot-transfer",
		extensions: "extensions-rack",
		cli: "cli-terminal",
		mail: "mail-pigeonholes",
		cloud: "cloud-cabinet",
		marketplace: "marketplace-vending",
		messaging: "messaging-phone",
		notify: "notify-tower",
		sdk: "sdk-typecase",
		"red-team": "red-team-rig",
		compute: "compute-meter",
		share: "share-belt",
		skills: "skills-cartridges",
		mcp: "mcp-strip",
		connect: "connect-switchboard",
		sites: "sites-plotter",
		"agents-as-a-service": "aaas-drafting",
		hire: "hire-toolbox",
		agents: "agents-kit",
		connections: "connections-cards",
		agent: "agent-console",
		os: "os-windows",
		island: "island-companion",
		mobile: "mobile-charger",
		"chrome-extension": "chrome-dock",
		devices: "devices-tray",
	};

// packages/services/src/service-titles.ts
//
// Each service's display name. It lives in its own module so the errors,
// transport and webhooks modules can name a service the way hints do
// ("Ryu Notify", not "Ryu notify") without importing config.ts.

import type { RyuService } from "./errors.ts";

/** Each service's display name, as messages and the CLI service list print it. */
export const SERVICE_TITLES: Readonly<Record<RyuService, string>> = {
	box: "Ryu Box",
	connect: "Ryu Connect",
	gateway: "Ryu Gateway",
	mail: "Ryu Mail",
	managedAgents: "Ryu Managed Agents",
	messaging: "Ryu Messaging",
	notify: "Ryu Notify",
	passport: "Ryu Passport",
	sites: "Ryu Sites",
};

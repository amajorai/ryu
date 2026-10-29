/** Only the operations exercised by each isolated UI proof may use its owner relay. */
export const usageHistoryProofRoutes = [
	{ methods: ["GET"], path: /^\/api\/usage\/history$/u },
	{ methods: ["GET", "PUT"], path: /^\/api\/usage\/history\/tracking$/u },
	{
		methods: ["POST"],
		path: /^\/api\/usage\/history\/(?:import|account-sync)$/u,
	},
	{
		methods: ["GET"],
		path: /^\/api\/usage\/history\/import\/operations\/[a-zA-Z0-9-]+$/u,
	},
] as const;

export const voiceProofRoutes = [
	{ methods: ["GET"], path: /^\/api\/voice\/(?:tts-engines|tts-models)$/u },
	{ methods: ["POST"], path: /^\/api\/voice\/(?:speak|tts-models\/install)$/u },
] as const;

export const qoderProofRoutes = [
	{ methods: ["GET"], path: /^\/api\/pi-config(?:\/catalog)?$/u },
	{ methods: ["PUT"], path: /^\/api\/pi-config$/u },
	{
		methods: ["POST"],
		path: /^\/api\/pi-config\/(?:providers|discover-models)$/u,
	},
	{ methods: ["GET"], path: /^\/api\/models\/(?:active|installed)$/u },
] as const;

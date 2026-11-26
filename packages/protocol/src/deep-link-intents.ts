// @ryuhq/protocol - the intent shapes and page keys of a `ryu://` deep link.
// Split out of `deep-link.ts`, which re-exports every name here, so import
// them from `@ryuhq/protocol/deep-link` as before.
// test-exempt: types and one constant moved verbatim out of deep-link.ts; deep-link.test.ts covers them.

export type DeepLinkIntent =
	| { kind: "plugin-app"; pluginId: string; toolName: string; appPath: string }
	| { kind: "model"; source: string; id: string; node: string | null }
	| { kind: "skill"; source: string; id: string; node: string | null }
	| { kind: "app"; id: string; node: string | null }
	| { kind: "bundle"; id: string; node: string | null }
	| { kind: "node"; name: string; url: string; token: string | null }
	| {
			kind: "handoff";
			version: 0;
			conversationId: string;
			sourceNodeUrl: string;
	  }
	| { kind: "page"; page: string }
	| {
			kind: "chat";
			conversationId: string | null;
			prompt: string | null;
			agent: string | null;
			project: string | null;
	  };

/**
 * Permissive input accepted by {@link buildRyuDeepLink}. The chat/node fields are
 * optional here (a caller often omits the ones it doesn't set) while the parser
 * always returns the strict {@link DeepLinkIntent} with every field present.
 */
export type DeepLinkBuildInput =
	| { kind: "plugin-app"; pluginId: string; toolName: string; appPath?: string }
	| { kind: "model"; source: string; id: string; node?: string | null }
	| { kind: "skill"; source: string; id: string; node?: string | null }
	| { kind: "app"; id: string; node?: string | null }
	| { kind: "bundle"; id: string; node?: string | null }
	| { kind: "node"; name: string; url: string; token?: string | null }
	| {
			kind: "handoff";
			version: 0;
			conversationId: string;
			sourceNodeUrl: string;
	  }
	| { kind: "page"; page: string }
	| {
			kind: "chat";
			conversationId?: string | null;
			prompt?: string | null;
			agent?: string | null;
			project?: string | null;
	  };

/**
 * The canonical, surface-agnostic page keys a `ryu://open/<page>` link may target.
 * Each surface maps these to its own route (desktop tabs, mobile Expo routes); an
 * unknown key is ignored rather than erroring.
 */
export const DEEP_LINK_PAGES = [
	"chat",
	"agents",
	"models",
	"skills",
	"tools",
	"spaces",
	"workflows",
	"automations",
	"monitors",
	"marketplace",
	"settings",
	"channels",
	"timeline",
	"delegation",
	"credits",
	"fleet",
	"extensions",
	"apps",
	"engines",
	"store",
	"calendar",
	"services",
] as const;

export type DeepLinkPage = (typeof DEEP_LINK_PAGES)[number];

declare const window: Window;

import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { EntitySettings } from "../../src/components/settings/EntitySettings.tsx";
import type { ScopedNavEntity } from "../../src/hooks/useScopedSettingsNav.ts";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJsonRecord } from "../fixture-json.ts";
import "../../src/index.css";

const API_BASE = "http://127.0.0.1:7973";
const FAILURES_KEY = "learning-settings-proof-failures";
const PREFERENCES_KEY = "learning-settings-proof-preferences";
const NODE = {
	managed: true,
	name: "learning-settings-proof",
	orgId: "learning-settings-proof-org",
	token: "learning-settings-proof-node-token",
	url: API_BASE,
	userJwt: "learning-settings-proof-user-jwt",
};
const ENTITY: ScopedNavEntity = {
	enabled: true,
	id: "@ryu/learning",
	label: "Learning",
	tabs: [
		{
			enabled: true,
			fields: [],
			id: "learning.settings",
			plugin: "@ryu/learning",
			scope: "node",
			title: "Learning",
			view: "learning",
		},
	],
};
const TARGET: ApiTarget = {
	token: NODE.token,
	url: NODE.url,
	userJwt: NODE.userJwt,
};

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number | null;
	token: string | null;
	userJwt: string | null;
}

interface LearningSettingsProof {
	armFailure: (method: string, path: string, status?: number) => void;
	snapshot: () => {
		preferences: Record<string, string>;
		requests: CapturedRequest[];
	};
}

declare global {
	interface Window {
		__learningSettingsProof: LearningSettingsProof;
	}
}

const requests: CapturedRequest[] = [];
const failures = new Map<string, number>(
	Object.entries(
		z
			.record(z.string(), z.number())
			.parse(JSON.parse(localStorage.getItem(FAILURES_KEY) ?? "{}"))
	)
);

function readPreferences(): Record<string, string> {
	try {
		const stored = localStorage.getItem(PREFERENCES_KEY);
		return stored === null ? {} : JSON.parse(stored);
	} catch {
		return {};
	}
}

function writePreferences(preferences: Record<string, string>): void {
	localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function installFixture(): void {
	if (
		new URLSearchParams(window.location.search).get("failLearningReads") ===
		"true"
	) {
		failures.set("GET /api/preferences/learning.enabled", 503);
		failures.set("GET /api/preferences/learning.skills-enabled", 503);
	}
	window.__learningSettingsProof = {
		armFailure: (method, requestPath, status = 503) => {
			const key = `${method} ${requestPath}`;
			failures.set(key, status);
			localStorage.setItem(
				FAILURES_KEY,
				JSON.stringify(Object.fromEntries(failures))
			);
		},
		snapshot: () => ({
			preferences: readPreferences(),
			requests: requests.map((request) => ({ ...request })),
		}),
	};

	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = (init?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body)
			? parseProofJsonRecord(init.body)
			: null;
		const headers = new Headers(init?.headers);
		const record: CapturedRequest = {
			body,
			method,
			path: url.pathname,
			status: null,
			token: headers.get("authorization"),
			userJwt: headers.get("x-ryu-user-jwt"),
		};
		requests.push(record);

		const failureKey = `${method} ${url.pathname}`;
		const failureStatus = failures.get(failureKey);
		if (failureStatus !== undefined) {
			failures.delete(failureKey);
			localStorage.setItem(
				FAILURES_KEY,
				JSON.stringify(Object.fromEntries(failures))
			);
			record.status = failureStatus;
			return json(
				{ error: "learning_settings_fixture_failure" },
				failureStatus
			);
		}
		if (url.pathname === "/api/plugins/contributions" && method === "GET") {
			record.status = 200;
			return json({ companions: [], settings_tabs: [] });
		}
		if (url.pathname === "/api/plugins" && method === "GET") {
			record.status = 200;
			return json({ apps: [] });
		}

		const match = /^\/api\/preferences\/(.+)$/.exec(url.pathname);
		if (!match) {
			record.status = 404;
			return json({ error: "unhandled_learning_settings_fixture_path" }, 404);
		}
		const key = decodeURIComponent(match[1] ?? "");
		const preferences = readPreferences();
		if (method === "GET") {
			const value = preferences[key];
			if (value === undefined) {
				record.status = 404;
				return json({ error: "preference_not_found" }, 404);
			}
			record.status = 200;
			return json({ key, value });
		}

		if (method === "PUT") {
			const value = body && "value" in body ? body.value : null;
			if (!(isNativeText(value) && ["true", "false"].includes(value))) {
				record.status = 400;
				return json({ error: "invalid_learning_preference" }, 400);
			}
			preferences[key] = value;
			writePreferences(preferences);
			record.status = 200;
			return json({ key, ok: true, value });
		}

		record.status = 405;
		return json({ error: "method_not_allowed" }, 405);
	};
}

useNodeStore.setState({
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
installFixture();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<main className="mx-auto w-full max-w-3xl p-8">
				<EntitySettings
					entity={{
						...ENTITY,
						enabled:
							new URLSearchParams(window.location.search).get("appEnabled") !==
							"false",
					}}
					target={TARGET}
				/>
				<Toaster position="bottom-right" theme="dark" />
			</main>
		</QueryClientProvider>
	);
}

// packages/services/src/notify/namespace.ts
//
// `ryu.notify`: `@ryuhq/client`'s Notify client grouped into resource
// namespaces, plus `events.iterate()` and `requestApproval()`. Errors are
// raised by the fetch shim (`throw` mode), so the client's plain-Error paths
// never run and callers branch on typed RyuError codes. Replays are reported
// in `meta.replayed` from the body's `idempotent: true` (Notify sends no
// `Idempotent-Replayed` header).
//
// Naming rule. The canonical spelling is `notify.<resource>.<verb>`:
//
//   events        list, get, iterate, acknowledge, archive, unarchive,
//                 respond, cancelResponse, stream
//   topics        list, publish
//   activities    list, get, create, update, end
//   destinations  list, create, update, delete, test
//   deliveries    list, retry
//   preferences   get, update
//   silences      list, create, delete
//   groups        list
//
// A verb stays at the top level only when it is the service's primary action
// or has no resource to belong to: `publish`, `requestApproval`, `analytics`
// and `usage`. Every flat `@ryuhq/client` name (`listEvents`, `getEvent`,
// `createActivity`, ...) still works as a `@deprecated` alias of its
// canonical method: both spellings call the same client method, so they send
// the same request and behave the same in throw mode, object mode,
// `ryu.safe` and `.with()`. `NOTIFY_CANONICAL_METHODS` lists the pairs and
// `NOTIFY_TOP_LEVEL_METHODS` the client methods kept at the top level.

import {
	createNotifyClient,
	type NotificationEvent,
	type NotifyAPI,
	type NotifyEventList,
	type RyuFetch,
} from "@ryuhq/client";
import type { ResolvedServiceConfig } from "../config.ts";
import type { Paginated } from "../pagination.ts";
import { type CallOptions, linkSignals } from "../transport/fetch-shim.ts";
import type { NamespaceDefinition } from "../wrap.ts";
import {
	type NotifyApprovalInput,
	type NotifyApprovalOptions,
	type NotifyApprovalResult,
	requestApproval,
} from "./helpers.ts";
import { iterateEvents, type NotifyEventIterateQuery } from "./iterate.ts";
import { NOTIFY_ROUTES } from "./routes.ts";

/** `ryu.notify.events`: the event history and its interactions. */
export interface NotifyEventsNamespace {
	/** `POST /v1/events/:id/ack`. */
	acknowledge: NotifyAPI["acknowledge"];
	/** `POST /v1/events/:id/archive`. */
	archive: NotifyAPI["archive"];
	/** `POST /v1/events/:id/cancel`: cancels a pending interactive response. */
	cancelResponse: NotifyAPI["cancelResponse"];
	/** `GET /v1/events/:id`. */
	get: NotifyAPI["getEvent"];
	/**
	 * Every matching event, newest first, across pages (`before` → `nextCursor`).
	 * Throws RyuError, also in object mode.
	 */
	iterate(
		query?: NotifyEventIterateQuery
	): Paginated<NotificationEvent, NotifyEventList>;
	/** `GET /v1/events`: one page. */
	list: NotifyAPI["listEvents"];
	/** `POST /v1/events/:id/respond`: answers an interactive event. */
	respond: NotifyAPI["respond"];
	/** `GET /v1/events/stream` (SSE): new events and activity updates. */
	stream: NotifyAPI["stream"];
	/** `POST /v1/events/:id/unarchive`. */
	unarchive: NotifyAPI["unarchive"];
}

/** `ryu.notify.topics`: topic counts and plain-text topic publishes. */
export interface NotifyTopicsNamespace {
	/** `GET /v1/topics`: topics with their event counts. */
	list: NotifyAPI["listTopics"];
	/** `POST /v1/topics/:topic`: a plain-text publish (ntfy style). Gets an Idempotency-Key. */
	publish: NotifyAPI["publishTopic"];
}

/** `ryu.notify.activities`: live activities (progress that updates in place). */
export interface NotifyActivitiesNamespace {
	/** `POST /v1/activities`. The Idempotency-Key is required (second argument). */
	create: NotifyAPI["createActivity"];
	/** `POST /v1/activities/:id/end`. */
	end: NotifyAPI["endActivity"];
	/** `GET /v1/activities/:id`. */
	get: NotifyAPI["getActivity"];
	/** `GET /v1/activities`. */
	list: NotifyAPI["listActivities"];
	/** `PATCH /v1/activities/:id`. */
	update: NotifyAPI["updateActivity"];
}

/** `ryu.notify.destinations`: webhook, ntfy and Buzzkit fan-out targets. */
export interface NotifyDestinationsNamespace {
	/** `POST /v1/destinations`. */
	create: NotifyAPI["createDestination"];
	/** `DELETE /v1/destinations/:id`. */
	delete: NotifyAPI["deleteDestination"];
	/** `GET /v1/destinations`. */
	list: NotifyAPI["listDestinations"];
	/** `POST /v1/destinations/:id/test`: sends a test delivery. */
	test: NotifyAPI["testDestination"];
	/** `PATCH /v1/destinations/:id`. */
	update: NotifyAPI["updateDestination"];
}

/** `ryu.notify.deliveries`: delivery attempts to destinations. */
export interface NotifyDeliveriesNamespace {
	/** `GET /v1/deliveries`. */
	list: NotifyAPI["listDeliveries"];
	/** `POST /v1/deliveries/:id/retry`. */
	retry: NotifyAPI["retryDelivery"];
}

/** `ryu.notify.preferences`: mute and quiet hours, per recipient. */
export interface NotifyPreferencesNamespace {
	/** `GET /v1/preferences`. */
	get: NotifyAPI["getPreferences"];
	/** `PATCH /v1/preferences`. */
	update: NotifyAPI["updatePreferences"];
}

/** `ryu.notify.silences`: temporary suppression rules. */
export interface NotifySilencesNamespace {
	/** `POST /v1/silences`. */
	create: NotifyAPI["createSilence"];
	/** `DELETE /v1/silences/:id`. */
	delete: NotifyAPI["deleteSilence"];
	/** `GET /v1/silences`. */
	list: NotifyAPI["listSilences"];
}

/** `ryu.notify.groups`: events grouped by fingerprint. */
export interface NotifyGroupsNamespace {
	/** `GET /v1/groups`. */
	list: NotifyAPI["listGroups"];
}

/**
 * Each canonical `ryu.notify` path mapped to the `@ryuhq/client` method it
 * calls. The method's flat name is also its deprecated alias on `ryu.notify`.
 */
export const NOTIFY_CANONICAL_METHODS = {
	"events.list": "listEvents",
	"events.get": "getEvent",
	"events.acknowledge": "acknowledge",
	"events.archive": "archive",
	"events.unarchive": "unarchive",
	"events.respond": "respond",
	"events.cancelResponse": "cancelResponse",
	"events.stream": "stream",
	"topics.list": "listTopics",
	"topics.publish": "publishTopic",
	"activities.list": "listActivities",
	"activities.get": "getActivity",
	"activities.create": "createActivity",
	"activities.update": "updateActivity",
	"activities.end": "endActivity",
	"destinations.list": "listDestinations",
	"destinations.create": "createDestination",
	"destinations.update": "updateDestination",
	"destinations.delete": "deleteDestination",
	"destinations.test": "testDestination",
	"deliveries.list": "listDeliveries",
	"deliveries.retry": "retryDelivery",
	"preferences.get": "getPreferences",
	"preferences.update": "updatePreferences",
	"silences.list": "listSilences",
	"silences.create": "createSilence",
	"silences.delete": "deleteSilence",
	"groups.list": "listGroups",
} as const satisfies Readonly<Record<string, keyof NotifyAPI>>;

/**
 * Client methods that stay at the top level of `ryu.notify` under their own
 * name (`requestApproval` is a facade helper, not a client method).
 */
export const NOTIFY_TOP_LEVEL_METHODS = [
	"publish",
	"analytics",
	"usage",
] as const satisfies readonly (keyof NotifyAPI)[];

/** A flat client name kept as a deprecated alias. */
export type NotifyDeprecatedAlias =
	(typeof NOTIFY_CANONICAL_METHODS)[keyof typeof NOTIFY_CANONICAL_METHODS];

/**
 * The reverse of {@link NOTIFY_CANONICAL_METHODS}: each deprecated flat name
 * mapped to its canonical dotted path under `ryu.notify`.
 */
export const NOTIFY_DEPRECATED_ALIASES: Readonly<
	Record<NotifyDeprecatedAlias, keyof typeof NOTIFY_CANONICAL_METHODS>
> = Object.fromEntries(
	Object.entries(NOTIFY_CANONICAL_METHODS).map(([path, method]) => [
		method,
		path,
	])
) as Record<NotifyDeprecatedAlias, keyof typeof NOTIFY_CANONICAL_METHODS>;

/**
 * The flat `@ryuhq/client` names, kept as deprecated aliases of the canonical
 * resource methods. Each one makes the same request as its canonical form.
 */
export interface NotifyFlatAliases {
	/** @deprecated Use `ryu.notify.events.acknowledge(id)`. */
	acknowledge: NotifyAPI["acknowledge"];
	/** @deprecated Use `ryu.notify.events.archive(id)`. */
	archive: NotifyAPI["archive"];
	/** @deprecated Use `ryu.notify.events.cancelResponse(id)`. */
	cancelResponse: NotifyAPI["cancelResponse"];
	/** @deprecated Use `ryu.notify.activities.create(input, idempotencyKey)`. */
	createActivity: NotifyAPI["createActivity"];
	/** @deprecated Use `ryu.notify.destinations.create(input)`. */
	createDestination: NotifyAPI["createDestination"];
	/** @deprecated Use `ryu.notify.silences.create(input)`. */
	createSilence: NotifyAPI["createSilence"];
	/** @deprecated Use `ryu.notify.destinations.delete(id)`. */
	deleteDestination: NotifyAPI["deleteDestination"];
	/** @deprecated Use `ryu.notify.silences.delete(id)`. */
	deleteSilence: NotifyAPI["deleteSilence"];
	/** @deprecated Use `ryu.notify.activities.end(id, sequence)`. */
	endActivity: NotifyAPI["endActivity"];
	/** @deprecated Use `ryu.notify.activities.get(id)`. */
	getActivity: NotifyAPI["getActivity"];
	/** @deprecated Use `ryu.notify.events.get(id)`. */
	getEvent: NotifyAPI["getEvent"];
	/** @deprecated Use `ryu.notify.preferences.get(recipient)`. */
	getPreferences: NotifyAPI["getPreferences"];
	/** @deprecated Use `ryu.notify.activities.list(options)`. */
	listActivities: NotifyAPI["listActivities"];
	/** @deprecated Use `ryu.notify.deliveries.list(options)`. */
	listDeliveries: NotifyAPI["listDeliveries"];
	/** @deprecated Use `ryu.notify.destinations.list()`. */
	listDestinations: NotifyAPI["listDestinations"];
	/** @deprecated Use `ryu.notify.events.list(options)`. */
	listEvents: NotifyAPI["listEvents"];
	/** @deprecated Use `ryu.notify.groups.list(limit)`. */
	listGroups: NotifyAPI["listGroups"];
	/** @deprecated Use `ryu.notify.silences.list()`. */
	listSilences: NotifyAPI["listSilences"];
	/** @deprecated Use `ryu.notify.topics.list(limit)`. */
	listTopics: NotifyAPI["listTopics"];
	/** @deprecated Use `ryu.notify.topics.publish(topic, message, options)`. */
	publishTopic: NotifyAPI["publishTopic"];
	/** @deprecated Use `ryu.notify.events.respond(id, answer)`. */
	respond: NotifyAPI["respond"];
	/** @deprecated Use `ryu.notify.deliveries.retry(id)`. */
	retryDelivery: NotifyAPI["retryDelivery"];
	/** @deprecated Use `ryu.notify.events.stream(options)`. */
	stream: NotifyAPI["stream"];
	/** @deprecated Use `ryu.notify.destinations.test(id)`. */
	testDestination: NotifyAPI["testDestination"];
	/** @deprecated Use `ryu.notify.events.unarchive(id)`. */
	unarchive: NotifyAPI["unarchive"];
	/** @deprecated Use `ryu.notify.activities.update(id, input, sequence)`. */
	updateActivity: NotifyAPI["updateActivity"];
	/** @deprecated Use `ryu.notify.destinations.update(id, input)`. */
	updateDestination: NotifyAPI["updateDestination"];
	/** @deprecated Use `ryu.notify.preferences.update(input)`. */
	updatePreferences: NotifyAPI["updatePreferences"];
}

/**
 * `ryu.notify`: resource namespaces (`events`, `topics`, `activities`,
 * `destinations`, `deliveries`, `preferences`, `silences`, `groups`), the
 * top-level verbs `publish`, `requestApproval`, `analytics` and `usage`, and
 * the flat client names as deprecated aliases. Extending the client type
 * keeps a method added to `@ryuhq/client` later typed under its flat name
 * until it gets a canonical home (a test fails until it does).
 */
export interface NotifyNamespace
	extends Omit<NotifyAPI, keyof NotifyFlatAliases>,
		NotifyFlatAliases {
	readonly activities: NotifyActivitiesNamespace;
	/** `GET /v1/analytics`: event totals by level, source and topic. */
	analytics: NotifyAPI["analytics"];
	readonly deliveries: NotifyDeliveriesNamespace;
	readonly destinations: NotifyDestinationsNamespace;
	readonly events: NotifyEventsNamespace;
	readonly groups: NotifyGroupsNamespace;
	readonly preferences: NotifyPreferencesNamespace;
	/** `POST /v1/events`: publishes an event. Gets an Idempotency-Key. */
	publish: NotifyAPI["publish"];
	/**
	 * Publishes an interactive approval (or yes/no) event that expires after
	 * `timeoutMs` (default 10 minutes), then polls the event until it is
	 * answered, canceled, or expired.
	 */
	requestApproval(
		input: NotifyApprovalInput,
		options?: NotifyApprovalOptions
	): Promise<NotifyApprovalResult>;
	readonly silences: NotifySilencesNamespace;
	readonly topics: NotifyTopicsNamespace;
	/** `GET /v1/usage`: accepted events in a window of whole UTC hours. */
	usage: NotifyAPI["usage"];
}

function defineMethod(target: object, name: string, value: unknown): void {
	Object.defineProperty(target, name, {
		configurable: true,
		value,
		writable: true,
	});
}

/**
 * `fetch` with `signal` linked into every request, so `requestApproval(input,
 * { signal })` cancels an in-flight publish or poll, not only the waits.
 */
function fetchWithSignal(fetch: RyuFetch, signal: AbortSignal): RyuFetch {
	return async (input, init) => {
		const own = init?.signal ?? undefined;
		const linked = linkSignals(own ? [own, signal] : [signal]);
		try {
			return await fetch(input, { ...init, signal: linked.signal });
		} finally {
			linked.dispose();
		}
	};
}

/** The resource namespaces, each method delegating to the client's flat method. */
function resourceNamespaces(client: NotifyAPI) {
	const events: NotifyEventsNamespace = {
		acknowledge: (id) => client.acknowledge(id),
		archive: (id) => client.archive(id),
		cancelResponse: (id) => client.cancelResponse(id),
		get: (id) => client.getEvent(id),
		iterate: (query) => iterateEvents(client, query),
		list: (listOptions) => client.listEvents(listOptions),
		respond: (id, answer) => client.respond(id, answer),
		stream: (streamOptions) => client.stream(streamOptions),
		unarchive: (id) => client.unarchive(id),
	};
	const topics: NotifyTopicsNamespace = {
		list: (limit) => client.listTopics(limit),
		publish: (topic, message, publishOptions, idempotencyKey) =>
			client.publishTopic(topic, message, publishOptions, idempotencyKey),
	};
	const activities: NotifyActivitiesNamespace = {
		create: (input, idempotencyKey) =>
			client.createActivity(input, idempotencyKey),
		end: (id, sequence) => client.endActivity(id, sequence),
		get: (id) => client.getActivity(id),
		list: (listOptions) => client.listActivities(listOptions),
		update: (id, input, sequence) => client.updateActivity(id, input, sequence),
	};
	const destinations: NotifyDestinationsNamespace = {
		create: (input) => client.createDestination(input),
		delete: (id) => client.deleteDestination(id),
		list: () => client.listDestinations(),
		test: (id) => client.testDestination(id),
		update: (id, input) => client.updateDestination(id, input),
	};
	const deliveries: NotifyDeliveriesNamespace = {
		list: (listOptions) => client.listDeliveries(listOptions),
		retry: (id) => client.retryDelivery(id),
	};
	const preferences: NotifyPreferencesNamespace = {
		get: (recipient) => client.getPreferences(recipient),
		update: (input) => client.updatePreferences(input),
	};
	const silences: NotifySilencesNamespace = {
		create: (input) => client.createSilence(input),
		delete: (id) => client.deleteSilence(id),
		list: () => client.listSilences(),
	};
	const groups: NotifyGroupsNamespace = {
		list: (limit) => client.listGroups(limit),
	};
	return {
		activities,
		deliveries,
		destinations,
		events,
		groups,
		preferences,
		silences,
		topics,
	};
}

/** Builds the Notify client for one call. Does no I/O. */
export function createNotifyNamespace(
	config: ResolvedServiceConfig,
	fetch: RyuFetch,
	options: CallOptions = {}
): NotifyNamespace {
	const build = (clientFetch: RyuFetch) =>
		createNotifyClient({
			apiKey: config.apiKey ?? "",
			baseUrl: config.baseUrl,
			fetch: clientFetch,
		});
	const client = build(fetch);
	for (const [name, namespace] of Object.entries(resourceNamespaces(client))) {
		defineMethod(client, name, namespace);
	}
	defineMethod(
		client,
		"requestApproval",
		(input: NotifyApprovalInput, approvalOptions?: NotifyApprovalOptions) => {
			const signal = approvalOptions?.signal;
			const approvalClient =
				signal === undefined ? client : build(fetchWithSignal(fetch, signal));
			return requestApproval(approvalClient, input, approvalOptions, {
				callSignal: options.signal,
			});
		}
	);
	// The client's own methods are the deprecated flat aliases; the resource
	// namespaces and `requestApproval` were just defined on it.
	return client as unknown as NotifyNamespace;
}

/** How the facade wraps Notify. */
export const NOTIFY_NAMESPACE: NamespaceDefinition<NotifyNamespace> = {
	create: createNotifyNamespace,
	errors: "throw",
	routes: NOTIFY_ROUTES,
	service: "notify",
};

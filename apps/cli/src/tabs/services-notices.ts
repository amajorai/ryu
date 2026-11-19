// The toast a Services action leaves behind, as one whole sentence per action
// and outcome ("Started ryu-core", "Couldn't restart ryu-core"), so each
// language words the action and its subject together.

import { tf, tr } from "../i18n/translate.ts";

/** A Services row or bulk action the tab posts to Core. */
export type ServiceAction =
	| "restart"
	| "start"
	| "startAll"
	| "stop"
	| "stopAll"
	| "uninstall";

function succeeded(action: ServiceAction, name: string): string {
	switch (action) {
		case "restart":
			return tf("Restarted {name}", { name });
		case "start":
			return tf("Started {name}", { name });
		case "startAll":
			return tr("Started all services");
		case "stop":
			return tf("Stopped {name}", { name });
		case "stopAll":
			return tr("Stopped all services");
		default:
			return tf("Uninstalled {name}", { name });
	}
}

function failed(action: ServiceAction, name: string): string {
	switch (action) {
		case "restart":
			return tf("Couldn't restart {name}", { name });
		case "start":
			return tf("Couldn't start {name}", { name });
		case "startAll":
			return tr("Couldn't start all services");
		case "stop":
			return tf("Couldn't stop {name}", { name });
		case "stopAll":
			return tr("Couldn't stop all services");
		default:
			return tf("Couldn't uninstall {name}", { name });
	}
}

/** The notice for an action on sidecar `name` (ignored by the bulk actions). */
export function serviceActionNotice(
	action: ServiceAction,
	ok: boolean,
	name: string
): string {
	return ok ? succeeded(action, name) : failed(action, name);
}

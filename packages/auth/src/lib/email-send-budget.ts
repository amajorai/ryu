import { AsyncLocalStorage } from "node:async_hooks";
import { type EmailBudget, emailCooldownKey } from "./email-cooldown.ts";

// Which cooldown budget a send spends (lib/email-cooldown.ts), and the one
// send a request already paid for. Both are scoped to the work that request
// started, never to the address: a claim made while answering one request
// pays for that request's send and for nothing another request sends later.

export interface PrepaidSend {
	budget: EmailBudget;
	key: string;
	used: boolean;
}

const prepaidSends = new AsyncLocalStorage<PrepaidSend | null>();
/** Prepaid sends of requests whose endpoint runs in the request itself. */
const prepaidByRequest = new WeakMap<Request, PrepaidSend>();
const budgets = new AsyncLocalStorage<EmailBudget>();

/** The prepaid send for a claim this request just made. */
export function prepaidSend(
	budget: EmailBudget,
	email: string
): PrepaidSend | null {
	const key = emailCooldownKey(budget, email);
	return key ? { budget, key, used: false } : null;
}

/** Remember the send `request` paid for, for its endpoint's own sender. */
export function rememberPrepaidSend(
	request: Request | undefined,
	prepaid: PrepaidSend | null
): void {
	if (request && prepaid) {
		prepaidByRequest.set(request, prepaid);
	}
}

/**
 * The send this request (or, without one, the work in scope) paid for: what
 * a sender passes to `runDetached` so its delivery does not claim again.
 */
export function prepaidSendFor(
	request: Request | undefined
): PrepaidSend | null {
	return (
		(request ? prepaidByRequest.get(request) : undefined) ??
		currentPrepaidSend()
	);
}

/** The prepaid send in scope, to carry into work started later. */
export function currentPrepaidSend(): PrepaidSend | null {
	return prepaidSends.getStore() ?? null;
}

/** Run `task` with `prepaid` (or none) in scope. */
export function withPrepaidSend<T>(
	prepaid: PrepaidSend | null,
	task: () => T
): T {
	return prepaidSends.run(prepaid, task);
}

/**
 * Whether this send to `email` is the one the request in scope paid for. It
 * is used up by the first matching send, so it never pays for a second.
 */
export function takePrepaidSend(email: string): boolean {
	const prepaid = prepaidSends.getStore();
	if (!prepaid || prepaid.used) {
		return false;
	}
	if (emailCooldownKey(prepaid.budget, email) !== prepaid.key) {
		return false;
	}
	prepaid.used = true;
	return true;
}

/** Run `task` so that its sends claim from `budget`. */
export function withEmailBudget<T>(budget: EmailBudget, task: () => T): T {
	return budgets.run(budget, task);
}

/**
 * The budget a send that nothing paid for claims from: "request" unless the
 * work in scope says "account". Unknown work fails toward the budget a
 * stranger can spend, so only mail a signed-in or password-verified owner
 * caused, and that says so, can draw on the account's own budget.
 */
export function currentEmailBudget(): EmailBudget {
	return budgets.getStore() ?? "request";
}

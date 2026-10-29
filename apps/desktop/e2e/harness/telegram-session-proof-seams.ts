export const BACKEND_URL = window.location.origin;
export const WEB_URL = window.location.origin;
let activeAccount = "current-account";
export const getActiveUserId = () => activeAccount;
export const listAccounts = () => [{ userId: activeAccount }];
export const addAccount = async (_token: string) => {
	activeAccount = "telegram-account";
	document.documentElement.dataset.activeAccount = activeAccount;
};

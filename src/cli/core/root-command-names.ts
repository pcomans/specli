export const ROOT_COMMAND_NAMES = {
	login: "login",
	logout: "logout",
	whoami: "whoami",
	schema: "__schema",
	help: "help",
} as const;

const RESERVED_ROOT_COMMAND_NAMES = new Set<string>(
	Object.values(ROOT_COMMAND_NAMES),
);

export function isReservedRootCommandName(name: string): boolean {
	return RESERVED_ROOT_COMMAND_NAMES.has(name);
}

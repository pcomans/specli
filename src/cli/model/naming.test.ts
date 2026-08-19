import { describe, expect, test } from "bun:test";
import { Command } from "commander";

import type { NormalizedOperation } from "../core/types.js";
import { buildRuntimeContext } from "../runtime/context.js";
import { addGeneratedCommands } from "../runtime/generated.js";
import { planOperations } from "./naming.js";

type OperationInput = Partial<Omit<NormalizedOperation, "path">> & {
	path: string;
};

function operation(input: OperationInput): NormalizedOperation {
	const method = input.method ?? "GET";
	return {
		...input,
		key: input.key ?? `${method.toUpperCase()} ${input.path}`,
		method,
		path: input.path,
		tags: input.tags ?? [],
		parameters: input.parameters ?? [],
	};
}

function commandFor(input: OperationInput): string {
	const planned = planOperations([operation(input)])[0];
	if (!planned) throw new Error("Expected one planned operation");
	return `${planned.resource} ${planned.action}`;
}

function mappingByKey(ops: NormalizedOperation[]): Record<string, string> {
	return Object.fromEntries(
		planOperations(ops).map((op) => [op.key, `${op.resource} ${op.action}`]),
	);
}

function assertUniqueCommands(ops: NormalizedOperation[]): void {
	const planned = planOperations(ops);
	const commands = planned.map((op) => `${op.resource} ${op.action}`);
	expect(planned).toHaveLength(ops.length);
	expect(new Set(commands).size).toBe(ops.length);
	for (const op of planned) {
		expect(op.resource).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		expect(op.action).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
	}
}

function jiraPrioritiesSpec(directArray: boolean): string {
	const getResponse = directArray
		? {
				description: "Returned if the request is successful.",
				content: {
					"application/json": {
						schema: { type: "array", items: { type: "object" } },
					},
				},
			}
		: { description: "Returned if the request is successful." };

	return JSON.stringify({
		openapi: "3.0.3",
		info: { title: "Jira priorities", version: "1" },
		paths: {
			"/rest/api/3/priority": {
				get: {
					operationId: "getPriorities",
					tags: ["Issue priorities"],
					responses: { "200": getResponse },
				},
			},
			"/rest/api/3/priority/search": {
				get: {
					operationId: "searchPriorities",
					tags: ["Issue priorities"],
					responses: {
						"200": { description: "Returned if the request is successful." },
					},
				},
			},
		},
	});
}

async function jiraPriorityCommands(directArray: boolean): Promise<string[]> {
	const context = await buildRuntimeContext({
		embeddedSpecText: jiraPrioritiesSpec(directArray),
	});
	const program = new Command();
	expect(() =>
		addGeneratedCommands(program, {
			servers: context.servers,
			authSchemes: context.authSchemes,
			commands: context.commands,
			specId: context.loaded.id,
		}),
	).not.toThrow();

	const resource = program.commands.find(
		(command) => command.name() === "issue-priorities",
	);
	expect(resource).toBeDefined();
	return resource?.commands.map((command) => command.name()).sort() ?? [];
}

describe("Jira issue #7", () => {
	test("schema-free issue fixture keeps get and search distinct", async () => {
		expect(await jiraPriorityCommands(false)).toEqual(["get", "search"]);
	});

	test("Atlassian direct-array evidence refines get to list", async () => {
		expect(await jiraPriorityCommands(true)).toEqual(["list", "search"]);
	});
});

describe("source-evidenced operation intent", () => {
	test("uses only exact resource edges for clean decompositions", () => {
		const fixtures: Array<[OperationInput, string]> = [
			[
				{
					path: "/priority",
					operationId: "getPriorities",
					tags: ["Issue priorities"],
					successResponseCardinality: "collection",
				},
				"issue-priorities list",
			],
			[
				{
					path: "/priority/search",
					operationId: "searchPriorities",
					tags: ["Issue priorities"],
				},
				"issue-priorities search",
			],
			[
				{
					path: "/user/{id}",
					operationId: "retrieveUser",
					tags: ["Users"],
				},
				"users retrieve",
			],
			[
				{
					method: "DELETE",
					path: "/rules",
					operationId: "deleteAllRules",
					tags: ["Rules"],
				},
				"rules delete-all",
			],
			[
				{
					method: "POST",
					path: "/secret/{id}",
					operationId: "rotateSecret",
					tags: ["Secrets"],
				},
				"secrets rotate",
			],
			[
				{
					method: "POST",
					path: "/rules/{id}",
					operationId: "RulesDeleteAsync",
					tags: ["Rules"],
				},
				"rules delete-async",
			],
			[
				{
					method: "POST",
					path: "/widget/{id}",
					operationId: "frobnicateWidget",
					tags: ["Widget"],
				},
				"widget frobnicate",
			],
			[
				{
					path: "/issue/{issue}/worklog",
					operationId: "getIssueWorklog",
					tags: ["Issue worklogs"],
				},
				"issue-worklogs list",
			],
			[
				{
					path: "/issue/{issue}/worklog/{id}",
					operationId: "getWorklog",
					tags: ["Issue worklogs"],
				},
				"issue-worklogs get",
			],
		];

		for (const [input, expected] of fixtures) {
			expect(commandFor(input)).toBe(expected);
		}
	});

	test("preserves the full ID when an exact edge does not prove deletion", () => {
		const fixtures: Array<[OperationInput, string]> = [
			[
				{
					method: "POST",
					path: "/rules/{id}",
					operationId: "deleteRulesAsync",
					tags: ["Rules"],
				},
				"rules delete-rules-async",
			],
			[
				{
					method: "POST",
					path: "/widget/{id}",
					operationId: "frobnicateWidgetPartial",
					tags: ["Widget"],
				},
				"widget frobnicate-widget-partial",
			],
			[
				{
					method: "POST",
					path: "/secrets/{id}",
					operationId: "rotateAsync",
					tags: ["Secrets"],
				},
				"secrets rotate-async",
			],
			[
				{
					method: "POST",
					path: "/rules",
					operationId: "archiveAll",
					tags: ["Rules"],
				},
				"rules archive-all",
			],
			[
				{
					method: "POST",
					path: "/messages/{id}",
					operationId: "markAsRead",
					tags: ["Messages"],
				},
				"messages mark-as-read",
			],
			[
				{
					method: "POST",
					path: "/devices/{id}",
					operationId: "turnOff",
					tags: ["Devices"],
				},
				"devices turn-off",
			],
			[
				{
					path: "/users/{id}",
					operationId: "retrieveUser",
					tags: ["Users"],
				},
				"users retrieve-user",
			],
			[
				{
					method: "POST",
					path: "/secrets/{id}",
					operationId: "rotateSecret",
					tags: ["Secrets"],
				},
				"secrets rotate-secret",
			],
			[
				{
					method: "POST",
					path: "/devices/{id}/async",
					operationId: "getAsync",
					tags: ["Devices"],
				},
				"devices get-async",
			],
			[
				{
					method: "POST",
					path: "/rules",
					operationId: "RulesDeleteRules",
					tags: ["Rules"],
				},
				"rules rules-delete-rules",
			],
		];

		for (const [input, expected] of fixtures) {
			expect(commandFor(input)).toBe(expected);
		}
	});

	test("recognizes structured syntax without treating separators as vocabulary", () => {
		const fixtures: Array<[OperationInput, string]> = [
			[
				{
					path: "/registries",
					operationId: "registries_list",
					tags: ["Registries"],
				},
				"registries list",
			],
			[
				{
					method: "POST",
					path: "/repos/{owner}/{repo}/git/blobs",
					operationId: "git/create-blob",
				},
				"git create-blob",
			],
			[
				{
					path: "/Contacts.List",
					operationId: "Contacts.List",
				},
				"contacts list",
			],
			[
				{
					method: "DELETE",
					path: "/rules",
					operationId: "delete-all-rules",
					tags: ["Rules"],
				},
				"rules delete-all",
			],
		];

		for (const [input, expected] of fixtures) {
			expect(commandFor(input)).toBe(expected);
		}
	});

	test("orients structured IDs only from corroborated resource evidence", () => {
		const fixtures: Array<[OperationInput, string]> = [
			[
				{
					path: "/widgets/{id}",
					operationId: "Widgets.List",
				},
				"widgets list",
			],
			[
				{
					method: "POST",
					path: "/widgets/{id}",
					operationId: "delete/widgets",
				},
				"widgets delete",
			],
			[
				{
					method: "POST",
					path: "/widgets/{id}",
					operationId: "delete.widgets",
				},
				"widgets delete",
			],
			[
				{
					method: "POST",
					path: "/repos/{owner}/{repo}/git/blobs",
					operationId: "git/create-git",
				},
				"git create-git",
			],
			[
				{
					method: "POST",
					path: "/repos/{owner}/{repo}/git/blobs",
					operationId: "create-blob/git",
				},
				"git create-blob",
			],
			[
				{
					method: "POST",
					path: "/repos/{owner}/{repo}/git/blobs",
					operationId: "git/blobs",
				},
				"blobs git-blobs",
			],
			[
				{
					path: "/issue/{issue}/worklog/{id}",
					operationId: "issue-worklog/get",
				},
				"issue-worklog get",
			],
			[
				{
					method: "POST",
					path: "/foo/{id}",
					operationId: "Foo.Bar.Foo",
				},
				"foo bar-foo",
			],
			[
				{
					method: "POST",
					path: "/unrelated/{id}",
					operationId: "Foo.Bar",
				},
				"unrelated foo-bar",
			],
			[
				{
					method: "POST",
					path: "/foo/{parent}/bar/{id}",
					operationId: "foo/bar",
				},
				"bar foo-bar",
			],
			[
				{
					method: "POST",
					path: "/widgets/{id}",
					operationId: "delete.widgets",
					tags: ["Admin"],
				},
				"admin delete-widgets",
			],
		];

		for (const [input, expected] of fixtures) {
			expect(commandFor(input)).toBe(expected);
		}
	});
});

describe("method-relative transport fallbacks", () => {
	test("only treats the operation's own HTTP method as generic", () => {
		const fixtures: Array<[OperationInput, string]> = [
			[
				{
					method: "POST",
					path: "/rules",
					operationId: "Rules.Delete",
				},
				"rules delete",
			],
			[
				{
					method: "POST",
					path: "/contacts",
					operationId: "Contacts.Get",
					successResponseCardinality: "collection",
				},
				"contacts get",
			],
			[
				{
					method: "POST",
					path: "/widgets",
					operationId: "post",
					tags: ["Widgets"],
				},
				"widgets create",
			],
			[
				{
					method: "PATCH",
					path: "/widgets/{id}",
					operationId: "patch",
					tags: ["Widgets"],
				},
				"widgets update",
			],
			[
				{
					method: "PUT",
					path: "/widgets/{id}",
					operationId: "put",
					tags: ["Widgets"],
				},
				"widgets replace",
			],
		];

		for (const [input, expected] of fixtures) {
			expect(commandFor(input)).toBe(expected);
		}
	});

	test("keeps authored GET conservative and no-ID GET conventional", () => {
		const fixtures: Array<[OperationInput, string]> = [
			[
				{
					path: "/status",
					operationId: "getSystemStatus",
					tags: ["System status"],
				},
				"system-status get",
			],
			[
				{
					path: "/status",
					operationId: "getSystemStatus",
					tags: ["System status"],
					successResponseCardinality: "collection",
				},
				"system-status list",
			],
			[
				{
					path: "/issues/{issue}/worklogs",
					operationId: "getWorklogs",
					tags: ["Worklogs"],
				},
				"worklogs list",
			],
			[
				{
					path: "/issues/{issue}/worklogs/{id}",
					operationId: "getWorklogs",
					tags: ["Worklogs"],
				},
				"worklogs get",
			],
			[{ path: "/widgets", tags: ["Widgets"] }, "widgets list"],
			[{ path: "/widgets/{id}", tags: ["Widgets"] }, "widgets get"],
			[{ path: "/", tags: ["Root"] }, "root get"],
		];

		for (const [input, expected] of fixtures) {
			expect(commandFor(input)).toBe(expected);
		}
	});

	test("uses the bounded protocol table only when authored intent is absent", () => {
		const fixtures: Array<[OperationInput, string]> = [
			[{ method: "POST", path: "/widgets", tags: ["Widgets"] }, "create"],
			[{ method: "PATCH", path: "/widgets/{id}", tags: ["Widgets"] }, "update"],
			[{ method: "PUT", path: "/widgets/{id}", tags: ["Widgets"] }, "replace"],
			[
				{ method: "DELETE", path: "/widgets/{id}", tags: ["Widgets"] },
				"delete",
			],
			[{ method: "HEAD", path: "/widgets", tags: ["Widgets"] }, "head"],
			[{ method: "OPTIONS", path: "/widgets", tags: ["Widgets"] }, "options"],
			[{ method: "TRACE", path: "/widgets", tags: ["Widgets"] }, "trace"],
		];

		for (const [input, expectedAction] of fixtures) {
			expect(commandFor(input)).toBe(`widgets ${expectedAction}`);
		}
	});
});

describe("resource and path syntax", () => {
	test("preserves authored resource terminology without inflection", () => {
		const tags = [
			"Myself",
			"Monitoring",
			"Copilot",
			"Dependabot",
			"Code scanning",
			"Default",
		];
		for (const tag of tags) {
			const resource = planOperations([
				operation({ path: "/resource", tags: [tag] }),
			])[0]?.resource;
			expect(resource).toBe(tag.toLowerCase().replaceAll(" ", "-"));
		}

		expect(
			commandFor({ path: "/contact/{id}", tags: [], operationId: "get" }),
		).toBe("contact get");
		expect(commandFor({ path: "/resource", tags: ["", "Myself"] })).toBe(
			"myself list",
		);
	});

	test("uses a dotted static path only for its resource noun", () => {
		expect(commandFor({ path: "/Calls.json" })).toBe("calls list");
	});

	test("treats any template-bearing terminal segment as a member", () => {
		const fixtures: Array<[OperationInput, string]> = [
			[{ path: "/Calls/{Sid}.json", tags: ["Calls"] }, "calls get"],
			[
				{
					path: "/Calls/{Sid}.json",
					operationId: "get",
					tags: ["Calls"],
				},
				"calls get",
			],
			[
				{
					path: "/Accounts/{AccountSid}/Calls/{Sid}.json",
					tags: ["Calls"],
				},
				"calls get",
			],
			[
				{
					path: "/Accounts/{AccountSid}/Calls/{Sid}.json",
					operationId: "get",
					tags: ["Calls"],
				},
				"calls get",
			],
			[{ path: "/users/{id}:status" }, "users get"],
			[
				{ path: "/widgets/prefix-{left}-{right}", tags: ["Widgets"] },
				"widgets get",
			],
		];

		for (const [input, expected] of fixtures) {
			expect(commandFor(input)).toBe(expected);
		}

		const planned = planOperations([
			operation({ path: "/widgets/prefix-{left}-{right}" }),
		])[0];
		expect(planned?.resource).toBe("widgets");
		expect(planned?.rawPathArgs).toEqual(["left", "right"]);
	});

	test("qualifies root built-ins with a shared readable prefix", () => {
		const roots = ["Login", "Logout", "Whoami", "Help"];
		for (const tag of roots) {
			const resource = planOperations([
				operation({ path: "/resource", tags: [tag] }),
			])[0]?.resource;
			expect(resource).toBe(
				`openapi-${tag.toLowerCase().replaceAll("_", "-")}`,
			);
		}
		expect(
			planOperations([operation({ path: "/resource", tags: ["__schema"] })])[0]
				?.resource,
		).toBe("schema");
	});

	test("lets a rewritten root share a native openapi resource", () => {
		const ops = [
			operation({
				path: "/sessions",
				operationId: "listLogin",
				tags: ["Login"],
			}),
			operation({
				path: "/openapi-sessions",
				operationId: "listOpenapiLogin",
				tags: ["Openapi Login"],
			}),
		];

		assertUniqueCommands(ops);
		expect(
			planOperations(ops).every((op) => op.resource === "openapi-login"),
		).toBe(true);
	});
});

describe("global collision allocation", () => {
	test("handles missing and duplicate useful operation IDs", () => {
		const ops = [
			operation({ path: "/widgets/active", tags: ["Widgets"] }),
			operation({ path: "/widgets/archived", tags: ["Widgets"] }),
			operation({
				path: "/widgets/search/one",
				operationId: "search",
				tags: ["Widgets"],
			}),
			operation({
				path: "/widgets/search/two",
				operationId: "search",
				tags: ["Widgets"],
			}),
			operation({
				path: "/widgets/search/three",
				operationId: "search_widgets",
				tags: ["Widgets"],
			}),
			operation({
				path: "/widgets/search/four",
				operationId: "search-widgets",
				tags: ["Widgets"],
			}),
		];

		assertUniqueCommands(ops);
		expect(mappingByKey(ops)).toEqual(mappingByKey([...ops].reverse()));
	});

	test("globally regroups repaired-versus-native collisions", () => {
		const ops = [
			operation({
				path: "/widget/{id}",
				operationId: "getWidget",
				tags: ["Widget"],
			}),
			operation({
				path: "/owners/{owner}/widget/{id}",
				operationId: "getWidget",
				tags: ["Widget"],
			}),
			operation({
				path: "/widget/duplicate",
				operationId: "getWidgetWidget",
				tags: ["Widget"],
			}),
		];

		assertUniqueCommands(ops);
		expect(mappingByKey(ops)).toEqual(mappingByKey([...ops].reverse()));
	});

	test("globally regroups repaired-versus-repaired collisions", () => {
		const ops = [
			operation({
				path: "/owners/{owner}/widget/{id}",
				operationId: "getWidget",
				tags: ["Widget"],
			}),
			operation({
				path: "/teams/{team}/widget/{id}",
				operationId: "getWidget",
				tags: ["Widget"],
			}),
			operation({
				path: "/owners/{owner}/widget",
				operationId: "getWidget",
				tags: ["Widget"],
			}),
			operation({
				path: "/teams/{team}/widget",
				operationId: "getWidget",
				tags: ["Widget"],
			}),
		];

		assertUniqueCommands(ops);
		expect(mappingByKey(ops)).toEqual(mappingByKey([...ops].reverse()));
		expect(planOperations(ops).every((op) => op.action.includes("-op-"))).toBe(
			true,
		);
	});

	test("moves a semantic action that collides with a terminal identity", () => {
		const ops = [
			operation({ path: "/a", tags: ["Widget"] }),
			operation({ path: "/b", tags: ["Widget"] }),
			operation({
				path: "/c",
				operationId: "list-op-474554002f61",
				tags: ["Widget"],
			}),
		];

		assertUniqueCommands(ops);
		expect(mappingByKey(ops)).toEqual(mappingByKey([...ops].reverse()));
	});

	test("keeps the deployment second-order family complete and stable", () => {
		const ops = [
			operation({
				path: "/deployment/{id}",
				operationId: "getDeployment",
				tags: ["Deployment"],
			}),
			operation({
				path: "/deployment/{id}/events",
				operationId: "getDeploymentEvents",
				tags: ["Deployment"],
			}),
			operation({
				path: "/deployment/{id}/events/{eventId}",
				operationId: "getEvents",
				tags: ["Deployment"],
			}),
		];

		assertUniqueCommands(ops);
		expect(mappingByKey(ops)).toEqual(mappingByKey([...ops].reverse()));
	});
});

import { describe, expect, test } from "bun:test";
import { Command } from "commander";

import { buildCommandModel } from "../model/command-model.js";
import { planOperations } from "../model/naming.js";
import { buildRuntimeContext } from "./context.js";
import { addGeneratedCommands } from "./generated.js";

describe("addGeneratedCommands collision handling", () => {
	test("registers both commands from the Jira issue-priority fixture", async () => {
		const fixture = new URL(
			"../../../fixtures/openapi-jira-priorities.json",
			import.meta.url,
		);
		const context = await buildRuntimeContext({
			embeddedSpecText: await Bun.file(fixture).text(),
		});
		const program = new Command();

		expect(() =>
			addGeneratedCommands(program, {
				...context,
				specId: context.loaded.id,
			}),
		).not.toThrow();

		const priorities = program.commands.find(
			(command) => command.name() === "issue-priorities",
		);
		expect(priorities?.commands.map((command) => command.name())).toEqual([
			"get-priorities",
			"search-priorities",
		]);
	});

	test("registers exact-route actions with Commander", () => {
		const specId = "terminal-routes";
		const operations = [
			"/records/{id}/versions",
			"/archives/{id}/versions",
		].map((path) => ({
			key: `GET ${path}`,
			method: "GET",
			path,
			operationId: "getRecord",
			tags: ["records"],
			parameters: [],
		}));
		const commands = buildCommandModel(planOperations(operations), { specId });

		expect(() =>
			addGeneratedCommands(new Command(), {
				servers: [],
				authSchemes: [],
				commands,
				specId,
			}),
		).not.toThrow();
	});
});

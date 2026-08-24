import { describe, expect, test } from "bun:test";
import { Command } from "commander";

import type { NormalizedOperation } from "../core/types.js";
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

	test("registers a reclaimed video get command", () => {
		const specId = "videos";
		const operations = [
			{ path: "/videos/{video_id}", operationId: "GetVideo" },
			{
				path: "/videos/{video_id}/content",
				operationId: "RetrieveVideoContent",
			},
			{
				path: "/videos/characters/{character_id}",
				operationId: "GetVideoCharacter",
			},
		].map(
			({ path, operationId }): NormalizedOperation => ({
				key: `GET ${path}`,
				method: "GET",
				path,
				operationId,
				tags: ["Videos"],
				parameters: [],
			}),
		);
		const commands = buildCommandModel(planOperations(operations), { specId });
		const program = new Command();

		expect(() =>
			addGeneratedCommands(program, {
				servers: [],
				authSchemes: [],
				commands,
				specId,
			}),
		).not.toThrow();

		expect(
			commands.resources
				.find(({ resource }) => resource === "videos")
				?.actions.find(({ action }) => action === "get"),
		).toMatchObject({ method: "GET", path: "/videos/{video_id}" });

		const videosCommand = program.commands.find(
			(command) => command.name() === "videos",
		);
		expect(videosCommand?.commands.map((command) => command.name())).toEqual([
			"get",
			"get-character",
			"get-content",
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

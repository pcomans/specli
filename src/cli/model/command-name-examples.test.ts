import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { buildRuntimeContext } from "../runtime/context.js";
import { addGeneratedCommands } from "../runtime/generated.js";

const CSV_HEADER =
	"scenario,method,path,tag,operation_id,success_schema,expected_resource,expected_action,reason";
const HTTP_METHODS = new Set([
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
	"HEAD",
	"TRACE",
]);
const SUCCESS_SCHEMAS = new Set(["array", "object", "none"]);
const COMMAND_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type ExampleRow = {
	scenario: string;
	method: string;
	path: string;
	tag: string;
	operationId: string;
	successSchema: "array" | "object" | "none";
	resource: string;
	action: string;
	reason: string;
};

function readExamples(): ExampleRow[] {
	const file = fileURLToPath(
		new URL("../../../docs/command-name-examples.csv", import.meta.url),
	);
	const lines = readFileSync(file, "utf8").trimEnd().split("\n");
	expect(lines.shift()).toBe(CSV_HEADER);

	return lines.map((line, index) => {
		const rowNumber = index + 2;
		expect(line, `row ${rowNumber} must not use CSV quoting`).not.toContain(
			'"',
		);
		const cells = line.split(",");
		expect(cells, `row ${rowNumber} must have nine cells`).toHaveLength(9);

		const [
			scenario,
			method,
			path,
			tag,
			operationId,
			successSchema,
			resource,
			action,
			reason,
		] = cells as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];

		expect(scenario, `row ${rowNumber} scenario`).toMatch(COMMAND_SEGMENT);
		expect(HTTP_METHODS.has(method), `row ${rowNumber} method`).toBe(true);
		expect(path, `row ${rowNumber} path`).toMatch(
			/^\/(?:[A-Za-z0-9._{}-]+\/?)+$/,
		);
		expect(tag, `row ${rowNumber} tag`).toMatch(
			/^(?:[A-Za-z][A-Za-z0-9 -]*)?$/,
		);
		expect(operationId, `row ${rowNumber} operation_id`).toMatch(
			/^(?:[A-Za-z0-9][A-Za-z0-9./_-]*)?$/,
		);
		expect(
			SUCCESS_SCHEMAS.has(successSchema),
			`row ${rowNumber} success_schema`,
		).toBe(true);
		expect(resource, `row ${rowNumber} expected_resource`).toMatch(
			COMMAND_SEGMENT,
		);
		expect(action, `row ${rowNumber} expected_action`).toMatch(COMMAND_SEGMENT);
		expect(reason, `row ${rowNumber} reason`).toMatch(/^[A-Z][^.]+\.$/);

		return {
			scenario,
			method,
			path,
			tag,
			operationId,
			successSchema: successSchema as ExampleRow["successSchema"],
			resource,
			action,
			reason,
		};
	});
}

function responseFor(successSchema: ExampleRow["successSchema"]) {
	const response: Record<string, unknown> = {
		description: "The request succeeded.",
	};
	if (successSchema !== "none") {
		response.content = {
			"application/json": {
				schema:
					successSchema === "array"
						? { type: "array", items: { type: "object" } }
						: { type: "object" },
			},
		};
	}
	return response;
}

function documentFor(scenario: string, rows: ExampleRow[]) {
	const paths: Record<string, Record<string, unknown>> = {};

	for (const row of rows) {
		const pathItem = paths[row.path] ?? {};
		expect(pathItem[row.method.toLowerCase()]).toBeUndefined();
		const parameters = [...row.path.matchAll(/\{([^}]+)\}/g)].map(
			([, name]) => ({
				in: "path",
				name,
				required: true,
				schema: { type: "string" },
			}),
		);
		pathItem[row.method.toLowerCase()] = {
			...(row.tag ? { tags: [row.tag] } : {}),
			...(row.operationId ? { operationId: row.operationId } : {}),
			...(parameters.length > 0 ? { parameters } : {}),
			responses: { "200": responseFor(row.successSchema) },
		};
		paths[row.path] = pathItem;
	}

	return {
		openapi: "3.0.3",
		info: { title: `Command name example: ${scenario}`, version: "1.0.0" },
		paths,
	};
}

describe("executable command-name examples", () => {
	test("match the documented names and register as complete command groups", async () => {
		const rows = readExamples();
		const scenarios = Map.groupBy(rows, (row) => row.scenario);

		for (const [scenario, scenarioRows] of scenarios) {
			const context = await buildRuntimeContext({
				embeddedSpecText: JSON.stringify(documentFor(scenario, scenarioRows)),
			});
			expect(context.planned).toHaveLength(scenarioRows.length);

			for (const row of scenarioRows) {
				const planned = context.planned.find(
					(operation) =>
						operation.method === row.method &&
						operation.path === row.path &&
						(operation.operationId ?? "") === row.operationId,
				);
				expect(planned, `${row.method} ${row.path}`).toBeDefined();
				expect(planned?.resource, `${row.method} ${row.path} resource`).toBe(
					row.resource,
				);
				expect(planned?.action, `${row.method} ${row.path} action`).toBe(
					row.action,
				);
			}

			const program = new Command();
			expect(() =>
				addGeneratedCommands(program, {
					servers: context.servers,
					authSchemes: context.authSchemes,
					commands: context.commands,
					specId: context.loaded.id,
				}),
			).not.toThrow();
			const registeredActions = program.commands.reduce(
				(total, resource) => total + resource.commands.length,
				0,
			);
			expect(registeredActions).toBe(scenarioRows.length);
		}
	});

	test("uses array response evidence to refine the singleton-shaped stock read", async () => {
		const stockRead = readExamples().find(
			(row) =>
				row.scenario === "stock-actions" && row.operationId === "getStock",
		);
		expect(stockRead).toBeDefined();
		if (!stockRead) throw new Error("Expected the documented stock read");

		for (const [successSchema, expectedAction] of [
			["array", "list"],
			["object", "get"],
			["none", "get"],
		] as const) {
			const row = {
				...stockRead,
				successSchema,
			};
			const context = await buildRuntimeContext({
				embeddedSpecText: JSON.stringify(
					documentFor("stock-response-evidence", [row]),
				),
			});
			expect(context.planned).toHaveLength(1);
			expect(context.planned[0]?.resource).toBe("shop-stock");
			expect(context.planned[0]?.action).toBe(expectedAction);
		}
	});
});

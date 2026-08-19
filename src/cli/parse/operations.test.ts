import { describe, expect, test } from "bun:test";

import type { OpenApiDoc } from "../core/types.js";
import { loadSpec } from "../spec/loader.js";
import { indexOperations } from "./operations.js";

describe("indexOperations", () => {
	test("indexes basic operations", () => {
		const doc: OpenApiDoc = {
			openapi: "3.0.3",
			paths: {
				"/contacts": {
					get: {
						operationId: "Contacts.List",
						tags: ["Contacts"],
						parameters: [
							{
								in: "query",
								name: "limit",
								schema: { type: "integer" },
							},
						],
					},
				},
				"/contacts/{id}": {
					get: {
						operationId: "Contacts.Get",
						tags: ["Contacts"],
						parameters: [
							{
								in: "path",
								name: "id",
								required: true,
								schema: { type: "string" },
							},
						],
					},
				},
			},
		};

		const ops = indexOperations(doc);
		expect(ops).toHaveLength(2);

		expect(ops[0]?.key).toBe("GET /contacts");
		expect(ops[0]?.path).toBe("/contacts");
		expect(ops[0]?.method).toBe("GET");
		expect(ops[0]?.parameters).toHaveLength(1);
		expect(ops[0]?.parameters[0]?.in).toBe("query");

		expect(ops[1]?.key).toBe("GET /contacts/{id}");
		expect(ops[1]?.path).toBe("/contacts/{id}");
		expect(ops[1]?.method).toBe("GET");
		expect(ops[1]?.parameters).toHaveLength(1);
		expect(ops[1]?.parameters[0]?.in).toBe("path");
		expect(ops[1]?.parameters[0]?.required).toBe(true);
	});
});

function cardinalityFor(responses: unknown, openapi = "3.0.3") {
	const doc: OpenApiDoc = {
		openapi,
		paths: {
			"/items": {
				get: {
					responses,
				},
			},
		},
	};
	return indexOperations(doc)[0]?.successResponseCardinality;
}

function responseWithSchema(schema: unknown) {
	return {
		"200": {
			description: "OK",
			content: { "application/json": { schema } },
		},
	};
}

describe("success response cardinality", () => {
	test("accepts only shallow, unambiguous direct arrays", () => {
		const accepted: Array<[string, unknown, string?]> = [
			["direct array", responseWithSchema({ type: "array" })],
			[
				"OAS 3.1 singleton type array",
				responseWithSchema({ type: ["array"] }),
				"3.1.0",
			],
			[
				"uppercase success range",
				{
					"2XX": {
						description: "Success",
						content: {
							"application/json": { schema: { type: "array" } },
						},
					},
				},
			],
			[
				"empty success response alongside an array",
				{
					"200": {
						description: "OK",
						content: {
							"application/json": { schema: { type: "array" } },
						},
					},
					"204": { description: "No content" },
				},
			],
		];

		for (const [, responses, version] of accepted) {
			expect(cardinalityFor(responses, version)).toBe("collection");
		}
	});

	test("accepts a direct array after normal loader dereferencing", async () => {
		const loaded = await loadSpec({
			embeddedSpecText: JSON.stringify({
				openapi: "3.0.3",
				info: { title: "Dereference", version: "1" },
				paths: {
					"/items": {
						get: {
							responses: {
								"200": {
									description: "OK",
									content: {
										"application/json": {
											schema: {
												$ref: "#/components/schemas/Items",
											},
										},
									},
								},
							},
						},
					},
				},
				components: {
					schemas: {
						Items: { type: "array", items: { type: "object" } },
					},
				},
			}),
		});

		expect(indexOperations(loaded.doc)[0]?.successResponseCardinality).toBe(
			"collection",
		);
	});

	test("declines collection inference for every ambiguous shape", () => {
		const rejected: Array<[string, unknown]> = [
			["object", responseWithSchema({ type: "object" })],
			[
				"wrapped array",
				responseWithSchema({
					type: "object",
					properties: { items: { type: "array" } },
				}),
			],
			[
				"mixed success schemas",
				{
					"200": {
						description: "OK",
						content: {
							"application/json": { schema: { type: "array" } },
							"application/xml": { schema: { type: "object" } },
						},
					},
				},
			],
			[
				"only schema-less media type",
				{
					"200": {
						description: "OK",
						content: { "application/json": {} },
					},
				},
			],
			[
				"array plus schema-less media type",
				{
					"200": {
						description: "OK",
						content: {
							"application/json": { schema: { type: "array" } },
							"application/octet-stream": {},
						},
					},
				},
			],
			["missing responses", undefined],
			[
				"lowercase range and default are ignored",
				{
					"2xx": {
						description: "Malformed range",
						content: {
							"application/json": { schema: { type: "array" } },
						},
					},
					default: {
						description: "Default",
						content: {
							"application/json": { schema: { type: "array" } },
						},
					},
				},
			],
			["Boolean true schema", responseWithSchema(true)],
			["Boolean false schema", responseWithSchema(false)],
			["multi-type array", responseWithSchema({ type: ["array", "null"] })],
			["missing direct type", responseWithSchema({ items: {} })],
			["nullable array", responseWithSchema({ type: "array", nullable: true })],
			[
				"oneOf",
				responseWithSchema({ type: "array", oneOf: [{ type: "array" }] }),
			],
			[
				"anyOf",
				responseWithSchema({ type: "array", anyOf: [{ type: "array" }] }),
			],
			[
				"allOf",
				responseWithSchema({ type: "array", allOf: [{ type: "array" }] }),
			],
			["not", responseWithSchema({ type: "array", not: {} })],
		];

		for (const [, responses] of rejected) {
			expect(cardinalityFor(responses)).toBeUndefined();
		}
	});
});

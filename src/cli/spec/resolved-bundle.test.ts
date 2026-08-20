import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import SwaggerParser from "@apidevtools/swagger-parser";

import { buildRuntimeContext } from "../runtime/context.js";
import { loadSpec, type SpecFs } from "./loader.js";
import { parserChildFilePath, resolveSpecBundle } from "./resolved-bundle.js";

type JsonObject = Record<string, unknown>;

const ENCODED_FILENAME_CASES = [
	{
		schema: "Thing",
		encoded: "hash%23child.json",
		native: "hash#child.json",
		wrong: "hash%23child.json",
	},
	{
		schema: "Dollar",
		encoded: "dollar%24child.json",
		native: "dollar$child.json",
		wrong: "dollar%24child.json",
	},
	{
		schema: "Ampersand",
		encoded: "amp%26child.json",
		native: "amp&child.json",
		wrong: "amp%26child.json",
	},
	{
		schema: "Comma",
		encoded: "comma%2Cchild.json",
		native: "comma,child.json",
		wrong: "comma%2Cchild.json",
	},
	{
		schema: "At",
		encoded: "at%40child.json",
		native: "at@child.json",
		wrong: "at%40child.json",
	},
	{
		schema: "Slash",
		encoded: "slash%2Fchild.json",
		native: "slash%2Fchild.json",
		wrong: path.join("slash", "child.json"),
	},
	{
		schema: "Question",
		encoded: "question%3Fchild.json",
		native: "question%3Fchild.json",
		wrong: "question?child.json",
	},
	{
		schema: "Space",
		encoded: "space%20child.json",
		native: "space child.json",
		wrong: "space%20child.json",
	},
	{
		schema: "Unicode",
		encoded: "caf%C3%A9%20child.json",
		native: "café child.json",
		wrong: "caf%C3%A9%20child.json",
	},
] as const;

const NATIVE_ROOT_FILENAMES = [
	"root%23.json",
	"root%20.json",
	"root%24.json",
	"root%26.json",
	"root%2C.json",
	"root%40.json",
	"root%2F.json",
	"root%3F.json",
	"root%ZZ.json",
	"root% value.json",
	"root space.json",
	"racine café 文档.json",
] as const;

function document(
	options: {
		title?: string;
		schema?: JsonObject;
		servers?: Array<{ url: string }>;
	} = {},
): JsonObject {
	return {
		openapi: "3.1.0",
		info: {
			...(options.title === undefined ? {} : { title: options.title }),
			version: "1.0.0",
		},
		...(options.servers ? { servers: options.servers } : {}),
		paths: {
			"/things": {
				get: {
					operationId: "getThing",
					tags: ["things"],
					responses: {
						"200": {
							description: "OK",
							content: {
								"application/json": {
									schema: { $ref: "#/components/schemas/Thing" },
								},
							},
						},
					},
				},
			},
		},
		components: {
			schemas: {
				Thing: options.schema ?? { type: "string" },
			},
		},
	};
}

function refDocument(ref: string, title = "Reference API"): JsonObject {
	return document({ title, schema: { $ref: ref } });
}

function schemaOf(doc: JsonObject, name: string): JsonObject {
	const components = doc.components as JsonObject;
	const schemas = components.schemas as JsonObject;
	return schemas[name] as JsonObject;
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

describe("resolved bundle fingerprint contract", () => {
	test("equivalent JSON and YAML have one lowercase SHA-256 fingerprint", async () => {
		const json = JSON.stringify(document({ title: "Identity API" }));
		const yaml = `
paths:
  /things:
    get:
      tags: [things]
      responses:
        "200":
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Thing"
          description: OK
      operationId: getThing
components:
  schemas:
    Thing:
      type: string
info:
  version: 1.0.0
  title: Identity API
openapi: 3.1.0
`;

		const fromJson = await loadSpec({ embeddedSpecText: json });
		const fromYaml = await loadSpec({ embeddedSpecText: yaml });

		expect(fromJson.fingerprint).toBe(fromYaml.fingerprint);
		expect(fromJson.fingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	test("is repeatable, scalar-sensitive, and preserves array order", async () => {
		const original = document({
			title: "Order API",
			servers: [
				{ url: "https://first.example" },
				{ url: "https://second.example" },
			],
		});
		const scalarChange = document({
			title: "Changed API",
			servers: [
				{ url: "https://first.example" },
				{ url: "https://second.example" },
			],
		});
		const arrayChange = document({
			title: "Order API",
			servers: [
				{ url: "https://second.example" },
				{ url: "https://first.example" },
			],
		});

		const first = await loadSpec({
			embeddedSpecText: JSON.stringify(original),
		});
		const repeated = await loadSpec({
			embeddedSpecText: JSON.stringify(original),
		});
		const changedScalar = await loadSpec({
			embeddedSpecText: JSON.stringify(scalarChange),
		});
		const changedArray = await loadSpec({
			embeddedSpecText: JSON.stringify(arrayChange),
		});

		expect(first.fingerprint).toBe(repeated.fingerprint);
		expect(first.fingerprint).not.toBe(changedScalar.fingerprint);
		expect(first.fingerprint).not.toBe(changedArray.fingerprint);
	});

	test("preserves shared identity and actual cycles after hashing", async () => {
		const shared = document({ title: "Shared API" });
		(shared.components as JsonObject).schemas = {
			Thing: { type: "object" },
			First: { $ref: "#/components/schemas/Thing" },
			Second: { $ref: "#/components/schemas/Thing" },
		};
		const sharedLoaded = await loadSpec({
			embeddedSpecText: JSON.stringify(shared),
		});
		const sharedSchemas = (sharedLoaded.doc.components as JsonObject)
			.schemas as JsonObject;
		expect(sharedSchemas.First).toBe(sharedSchemas.Thing);
		expect(sharedSchemas.Second).toBe(sharedSchemas.Thing);

		const cyclic = document({
			title: "Cycle API",
			schema: {
				type: "object",
				properties: { next: { $ref: "#/components/schemas/Thing" } },
			},
		});
		const cyclicLoaded = await loadSpec({
			embeddedSpecText: JSON.stringify(cyclic),
		});
		const node = schemaOf(cyclicLoaded.doc as JsonObject, "Thing");
		const properties = node.properties as JsonObject;
		expect(properties.next).toBe(node);
		expect(cyclicLoaded.fingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	test("distinguishes graph topology and a literal circular sentinel", async () => {
		const twoNodeCycle = document({ title: "Topology API" });
		(twoNodeCycle.components as JsonObject).schemas = {
			Thing: { $ref: "#/components/schemas/A" },
			A: { $ref: "#/components/schemas/B" },
			B: { $ref: "#/components/schemas/A" },
		};
		const selfAtB = structuredClone(twoNodeCycle);
		((selfAtB.components as JsonObject).schemas as JsonObject).B = {
			$ref: "#/components/schemas/B",
		};
		const recursive = document({
			title: "Sentinel API",
			schema: {
				type: "object",
				properties: { child: { $ref: "#/components/schemas/Thing" } },
			},
		});
		const literal = document({
			title: "Sentinel API",
			schema: {
				type: "object",
				properties: { child: { __specli_circular: true } },
			},
		});

		const [cycleA, cycleB, recursiveLoaded, literalLoaded] = await Promise.all([
			loadSpec({ embeddedSpecText: JSON.stringify(twoNodeCycle) }),
			loadSpec({ embeddedSpecText: JSON.stringify(selfAtB) }),
			loadSpec({ embeddedSpecText: JSON.stringify(recursive) }),
			loadSpec({ embeddedSpecText: JSON.stringify(literal) }),
		]);

		expect(cycleA.fingerprint).not.toBe(cycleB.fingerprint);
		expect(recursiveLoaded.fingerprint).not.toBe(literalLoaded.fingerprint);
	});
});

describe("resolved bundle source ownership", () => {
	test("includes local child content, resolves from the entry, and is relocation-stable", async () => {
		const temp = await mkdtemp(path.join(os.tmpdir(), "specli-local-"));
		const first = path.join(temp, "first");
		const second = path.join(temp, "second");
		await mkdir(first);
		await mkdir(second);
		const root = JSON.stringify(refDocument("./child.json#/Thing"));
		const child = JSON.stringify({
			Thing: { type: "string", description: "one" },
		});

		try {
			for (const directory of [first, second]) {
				await writeFile(path.join(directory, "root.json"), root);
				await writeFile(path.join(directory, "child.json"), child);
			}
			const firstContext = await buildRuntimeContext({
				spec: path.join(first, "root.json"),
			});
			const secondContext = await buildRuntimeContext({
				spec: path.join(second, "root.json"),
			});
			expect(firstContext.loaded.fingerprint).toBe(
				secondContext.loaded.fingerprint,
			);
			expect(firstContext.planned).toEqual(secondContext.planned);

			await writeFile(
				path.join(second, "child.json"),
				JSON.stringify({ Thing: { type: "number", description: "two" } }),
			);
			const changed = await loadSpec({ spec: path.join(second, "root.json") });
			expect(changed.fingerprint).not.toBe(firstContext.loaded.fingerprint);
			expect(changed.id).toBe(firstContext.loaded.id);
			expect(schemaOf(changed.doc as JsonObject, "Thing").description).toBe(
				"two",
			);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	});

	test("custom SpecFs leaves absolute HTTP children to the parser", async () => {
		const rootPath = path.resolve("/virtual-api/root.json");
		const childUrl = "https://spec.example/custom-fs-child.json";
		const reads: string[] = [];
		const customFs: SpecFs = {
			async readFile(filePath) {
				reads.push(filePath);
				if (filePath !== rootPath)
					throw new Error(`unexpected file: ${filePath}`);
				return JSON.stringify(refDocument(`${childUrl}#/Thing`));
			},
		};
		const originalFetch = globalThis.fetch;
		let httpReads = 0;
		globalThis.fetch = (async (input) => {
			if (requestUrl(input) !== childUrl) {
				return new Response("missing", { status: 404 });
			}
			httpReads += 1;
			return Response.json({ Thing: { type: "number" } });
		}) as typeof fetch;

		try {
			const loaded = await loadSpec({ spec: rootPath, fs: customFs });
			expect(reads).toEqual([rootPath]);
			expect(httpReads).toBe(1);
			expect(schemaOf(loaded.doc as JsonObject, "Thing").type).toBe("number");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("custom SpecFs preserves caller-native roots and decodes only explicit file URLs", async () => {
		const directory = path.resolve("/virtual roots/données");

		for (const [index, filename] of NATIVE_ROOT_FILENAMES.entries()) {
			const rootPath = path.join(directory, filename);
			const root = JSON.stringify(
				document({ title: `Native Root API ${index}` }),
			);
			const reads: string[] = [];
			const customFs: SpecFs = {
				async readFile(filePath) {
					reads.push(filePath);
					if (filePath !== rootPath)
						throw new Error(`unexpected root read: ${filePath}`);
					return root;
				},
			};

			const plain = await loadSpec({ spec: rootPath, fs: customFs });
			expect(reads).toEqual([rootPath]);

			reads.length = 0;
			const fromFileUrl = await loadSpec({
				spec: pathToFileURL(rootPath).href,
				fs: customFs,
			});
			expect(reads).toEqual([rootPath]);
			expect(fromFileUrl.fingerprint).toBe(plain.fingerprint);
		}

		const malformedReads: string[] = [];
		await expect(
			loadSpec({
				spec: "file:///virtual%20roots/donn%C3%A9es/root%ZZ.json",
				fs: {
					async readFile(filePath) {
						malformedReads.push(filePath);
						return JSON.stringify(document());
					},
				},
			}),
		).rejects.toThrow();
		expect(malformedReads).toEqual([]);
	});

	test("uses one controlled URL resolution pass and no dereference refetch", async () => {
		const rootUrl = "https://spec.example/root.json";
		const childUrl = "https://spec.example/child.json";
		const root = refDocument("./child.json#/Thing", "URL API");
		let childDescription = "one";
		const counts = new Map<string, number>();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input) => {
			const url = requestUrl(input);
			counts.set(url, (counts.get(url) ?? 0) + 1);
			if (url === rootUrl) {
				return Response.json(root);
			}
			if (url === childUrl) {
				return Response.json({
					Thing: { type: "string", description: childDescription },
				});
			}
			return new Response("missing", { status: 404 });
		}) as typeof fetch;

		try {
			const first = await resolveSpecBundle({ spec: rootUrl });
			expect(counts.get(rootUrl)).toBe(1);
			expect(counts.get(childUrl)).toBe(1);
			const beforeDereference = new Map(counts);
			const dereferenced = (await SwaggerParser.dereference(
				first.bundled,
			)) as JsonObject;
			expect(counts).toEqual(beforeDereference);
			expect(schemaOf(dereferenced, "Thing").description).toBe("one");

			childDescription = "two";
			const second = await resolveSpecBundle({ spec: rootUrl });
			expect(second.fingerprint).not.toBe(first.fingerprint);
			expect(counts.get(rootUrl)).toBe(2);
			expect(counts.get(childUrl)).toBe(2);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("embedded mode resolves internal and absolute HTTP refs", async () => {
		const internal = await loadSpec({
			embeddedSpecText: JSON.stringify(
				document({
					title: "Embedded API",
					schema: { type: "object" },
				}),
			),
		});
		expect(internal.fingerprint).toMatch(/^[0-9a-f]{64}$/);

		const childUrl = "https://spec.example/embedded-child.json";
		const originalFetch = globalThis.fetch;
		let description = "remote";
		let reads = 0;
		globalThis.fetch = (async (input) => {
			if (requestUrl(input) !== childUrl) {
				return new Response("missing", { status: 404 });
			}
			reads += 1;
			return Response.json({
				Thing: { type: "string", description },
			});
		}) as typeof fetch;
		try {
			const root = JSON.stringify(refDocument(`${childUrl}#/Thing`));
			const first = await loadSpec({ embeddedSpecText: root });
			description = "changed";
			const second = await loadSpec({ embeddedSpecText: root });
			expect(reads).toBe(2);
			expect(schemaOf(first.doc as JsonObject, "Thing").description).toBe(
				"remote",
			);
			expect(first.fingerprint).not.toBe(second.fingerprint);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("embedded relative refs cannot read a same-named cwd file", async () => {
		const temp = await mkdtemp(path.join(os.tmpdir(), "specli-embedded-"));
		const originalCwd = process.cwd();
		await writeFile(
			path.join(temp, "child.json"),
			JSON.stringify({ Thing: { type: "string" } }),
		);
		try {
			process.chdir(temp);
			await expect(
				loadSpec({
					embeddedSpecText: JSON.stringify(refDocument("./child.json#/Thing")),
				}),
			).rejects.toThrow();
		} finally {
			process.chdir(originalCwd);
			await rm(temp, { recursive: true, force: true });
		}
	});

	test("custom SpecFs owns decoded child paths without host fallback", async () => {
		const temp = await mkdtemp(path.join(os.tmpdir(), "specli virtual "));
		const directory = path.join(temp, "données space");
		const rootPath = path.join(directory, "root.json");
		const childPath = path.join(directory, "café child.json");
		await mkdir(directory);
		await writeFile(
			childPath,
			JSON.stringify({
				Thing: { type: "string", description: "host must be ignored" },
			}),
		);
		const root = JSON.stringify(refDocument("./café child.json#/Thing"));
		const customChild = JSON.stringify({
			Thing: { type: "string", description: "custom" },
		});
		const files = new Map([
			[rootPath, root],
			[childPath, customChild],
		]);
		const reads: string[] = [];
		const customFs: SpecFs = {
			async readFile(filePath) {
				reads.push(filePath);
				const content = files.get(filePath);
				if (content === undefined)
					throw new Error(`custom missing: ${filePath}`);
				return content;
			},
		};

		try {
			expect(parserChildFilePath(encodeURI(childPath))).toBe(childPath);
			expect(parserChildFilePath(pathToFileURL(childPath).href)).toBe(
				childPath,
			);
			const loaded = await loadSpec({ spec: rootPath, fs: customFs });
			expect(reads).toEqual([rootPath, childPath]);
			expect(schemaOf(loaded.doc as JsonObject, "Thing").description).toBe(
				"custom",
			);

			files.delete(childPath);
			await expect(
				loadSpec({ spec: rootPath, fs: customFs }),
			).rejects.toThrow();
			expect(reads.slice(-2)).toEqual([rootPath, childPath]);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	});

	test("custom SpecFs matches Ref Parser encoded filename semantics", async () => {
		const temp = await mkdtemp(path.join(os.tmpdir(), "specli-encoded-"));
		const directory = path.join(temp, "package");
		const rootPath = path.join(directory, "root.json");
		const cases = ENCODED_FILENAME_CASES;
		const rootDocument = document({ title: "Encoded Filename API" });
		(rootDocument.components as JsonObject).schemas = Object.fromEntries(
			cases.map(({ schema, encoded }) => [
				schema,
				{ $ref: `./${encoded}#/Thing` },
			]),
		);
		const root = JSON.stringify(rootDocument);
		const files = new Map<string, string>([[rootPath, root]]);
		await mkdir(directory, { recursive: true });
		await writeFile(rootPath, root);

		for (const testCase of cases) {
			const nativePath = path.join(directory, testCase.native);
			const wrongPath = path.join(directory, testCase.wrong);
			await mkdir(path.dirname(wrongPath), { recursive: true });
			await writeFile(
				nativePath,
				JSON.stringify({
					Thing: {
						type: "string",
						description: `ordinary-${testCase.schema}`,
					},
				}),
			);
			await writeFile(
				wrongPath,
				JSON.stringify({
					Thing: { type: "string", description: "wrong host child" },
				}),
			);
			files.set(
				nativePath,
				JSON.stringify({
					Thing: {
						type: "string",
						description: `custom-${testCase.schema}`,
					},
				}),
			);
		}

		const reads: string[] = [];
		const customFs: SpecFs = {
			async readFile(filePath) {
				reads.push(filePath);
				const content = files.get(filePath);
				if (content === undefined)
					throw new Error(`custom missing: ${filePath}`);
				return content;
			},
		};

		try {
			for (const testCase of cases) {
				expect(
					parserChildFilePath(path.join(directory, testCase.encoded)),
				).toBe(path.join(directory, testCase.native));
			}

			const ordinary = await loadSpec({ spec: rootPath });
			const custom = await loadSpec({ spec: rootPath, fs: customFs });
			expect(new Set(reads)).toEqual(
				new Set([
					rootPath,
					...cases.map(({ native }) => path.join(directory, native)),
				]),
			);
			for (const testCase of cases) {
				expect(
					schemaOf(ordinary.doc as JsonObject, testCase.schema).description,
				).toBe(`ordinary-${testCase.schema}`);
				expect(
					schemaOf(custom.doc as JsonObject, testCase.schema).description,
				).toBe(`custom-${testCase.schema}`);
			}

			const decodedHashPath = path.join(directory, cases[0].native);
			files.delete(decodedHashPath);
			const readsBeforeFailure = reads.length;
			await expect(
				loadSpec({ spec: rootPath, fs: customFs }),
			).rejects.toThrow();
			expect(reads.slice(readsBeforeFailure)).toContain(decodedHashPath);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	});

	test("custom SpecFs matches absolute file URLs and rejects malformed escapes", async () => {
		const temp = await mkdtemp(path.join(os.tmpdir(), "specli-file-url "));
		const directory = path.join(temp, "données package");
		const rootPath = path.join(directory, "root space.json");
		await mkdir(directory, { recursive: true });
		const directoryUrl = pathToFileURL(`${directory}${path.sep}`).href;
		const rootDocument = document({ title: "File URL API" });
		(rootDocument.components as JsonObject).schemas = Object.fromEntries(
			ENCODED_FILENAME_CASES.map(({ schema, encoded }) => [
				schema,
				{ $ref: `${directoryUrl}${encoded}#/Thing` },
			]),
		);
		const root = JSON.stringify(rootDocument);
		const files = new Map<string, string>([[rootPath, root]]);
		await writeFile(rootPath, root);

		for (const testCase of ENCODED_FILENAME_CASES) {
			const nativePath = path.join(directory, testCase.native);
			const wrongPath = path.join(directory, testCase.wrong);
			await mkdir(path.dirname(wrongPath), { recursive: true });
			await writeFile(
				nativePath,
				JSON.stringify({
					Thing: {
						type: "string",
						description: `ordinary-file-${testCase.schema}`,
					},
				}),
			);
			await writeFile(
				wrongPath,
				JSON.stringify({
					Thing: { type: "string", description: "wrong file URL child" },
				}),
			);
			files.set(
				nativePath,
				JSON.stringify({
					Thing: {
						type: "string",
						description: `custom-file-${testCase.schema}`,
					},
				}),
			);
		}

		const reads: string[] = [];
		const customFs: SpecFs = {
			async readFile(filePath) {
				reads.push(filePath);
				const content = files.get(filePath);
				if (content === undefined)
					throw new Error(`custom missing: ${filePath}`);
				return content;
			},
		};

		try {
			for (const testCase of ENCODED_FILENAME_CASES) {
				expect(parserChildFilePath(`${directoryUrl}${testCase.encoded}`)).toBe(
					path.join(directory, testCase.native),
				);
			}

			const ordinary = await loadSpec({ spec: rootPath });
			const custom = await loadSpec({
				spec: pathToFileURL(rootPath).href,
				fs: customFs,
			});
			expect(new Set(reads)).toEqual(
				new Set([
					rootPath,
					...ENCODED_FILENAME_CASES.map(({ native }) =>
						path.join(directory, native),
					),
				]),
			);
			for (const testCase of ENCODED_FILENAME_CASES) {
				expect(
					schemaOf(ordinary.doc as JsonObject, testCase.schema).description,
				).toBe(`ordinary-file-${testCase.schema}`);
				expect(
					schemaOf(custom.doc as JsonObject, testCase.schema).description,
				).toBe(`custom-file-${testCase.schema}`);
			}

			const questionPath = path.join(directory, "question%3Fchild.json");
			files.delete(questionPath);
			const readsBeforeFailure = reads.length;
			await expect(
				loadSpec({ spec: pathToFileURL(rootPath).href, fs: customFs }),
			).rejects.toThrow();
			expect(reads.slice(readsBeforeFailure)).toContain(questionPath);

			const malformedRootPath = path.join(directory, "malformed-root.json");
			const malformedChildPath = path.join(directory, "bad%ZZchild.json");
			const malformedRoot = JSON.stringify(
				refDocument(`${directoryUrl}bad%ZZchild.json#/Thing`),
			);
			await writeFile(malformedRootPath, malformedRoot);
			await writeFile(
				malformedChildPath,
				JSON.stringify({ Thing: { type: "string" } }),
			);
			files.set(malformedRootPath, malformedRoot);
			files.set(
				malformedChildPath,
				JSON.stringify({ Thing: { type: "string" } }),
			);
			await expect(loadSpec({ spec: malformedRootPath })).rejects.toThrow();
			const malformedReads = reads.length;
			await expect(
				loadSpec({
					spec: pathToFileURL(malformedRootPath).href,
					fs: customFs,
				}),
			).rejects.toThrow();
			expect(reads.slice(malformedReads)).toEqual([malformedRootPath]);

			const malformedRootReads: string[] = [];
			await expect(
				loadSpec({
					spec: `${directoryUrl}root%ZZ.json`,
					fs: {
						async readFile(filePath) {
							malformedRootReads.push(filePath);
							return root;
						},
					},
				}),
			).rejects.toThrow();
			expect(malformedRootReads).toEqual([]);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	});

	test("documents installed parser nested-$id relative-ref behavior", async () => {
		const rootUrl = "https://spec.example/root-id.json";
		const rootChild = "https://spec.example/child.json";
		const nestedChild = "https://schemas.example/scope/child.json";
		const root = document({ title: "ID Scope API" });
		(root.components as JsonObject).schemas = {
			Thing: {
				$id: "https://schemas.example/scope/",
				properties: { child: { $ref: "child.json#/Child" } },
			},
		};
		const requested: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input) => {
			const url = requestUrl(input);
			requested.push(url);
			if (url === rootUrl) return Response.json(root);
			if (url === rootChild)
				return Response.json({ Child: { type: "string" } });
			return new Response("missing", { status: 404 });
		}) as typeof fetch;
		try {
			await resolveSpecBundle({ spec: rootUrl });
			expect(requested).toContain(rootChild);
			expect(requested).not.toContain(nestedChild);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("uses the fingerprint prefix only as the titleless fallback ID", async () => {
		const titleless = await loadSpec({
			embeddedSpecText: JSON.stringify(document()),
		});
		expect(titleless.id).toBe(titleless.fingerprint.slice(0, 12));

		const titled = await loadSpec({
			embeddedSpecText: JSON.stringify(document({ title: "Stable Name API" })),
		});
		const changed = await loadSpec({
			embeddedSpecText: JSON.stringify(
				document({
					title: "Stable Name API",
					schema: { type: "number" },
				}),
			),
		});
		expect(titled.id).toBe("stable-name-api");
		expect(changed.id).toBe(titled.id);
		expect(changed.fingerprint).not.toBe(titled.fingerprint);
	});

	test("canonical bundle remains self-contained after source relocation", async () => {
		const temp = await mkdtemp(path.join(os.tmpdir(), "specli-relocate-"));
		const source = path.join(temp, "source");
		const moved = path.join(temp, "moved");
		await mkdir(source);
		await writeFile(
			path.join(source, "root.json"),
			JSON.stringify(refDocument("./child.json#/Thing")),
		);
		await writeFile(
			path.join(source, "child.json"),
			JSON.stringify({ Thing: { type: "boolean" } }),
		);
		try {
			const resolved = await resolveSpecBundle({
				spec: path.join(source, "root.json"),
			});
			const dynamic = await buildRuntimeContext({
				spec: path.join(source, "root.json"),
			});
			await rename(source, moved);
			const embedded = await buildRuntimeContext({
				embeddedSpecText: resolved.canonicalText,
			});
			expect(embedded.loaded.fingerprint).toBe(dynamic.loaded.fingerprint);
			expect(embedded.operations).toEqual(dynamic.operations);
			expect(embedded.commandsIndex).toEqual(dynamic.commandsIndex);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	});
});

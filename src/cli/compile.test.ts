import { beforeAll, describe, expect, test } from "bun:test";
import {
	access,
	mkdir,
	mkdtemp,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compileCommand } from "./compile.js";
import { buildRuntimeContext } from "./runtime/context.js";
import { resolveSpecBundle } from "./spec/resolved-bundle.js";

type SchemaCommand = {
	resource: string;
	action: string;
	pathArgs: string[];
};

type PublicSchemaResult = {
	data: {
		cliName: string;
		commands: SchemaCommand[];
	};
};

function rootDocument(ref: string, title: string): Record<string, unknown> {
	return {
		openapi: "3.1.0",
		info: { title, version: "1.0.0" },
		paths: {
			"/widgets": {
				get: {
					operationId: "getWidget",
					tags: ["widgets"],
					responses: {
						"200": {
							description: "OK",
							content: {
								"application/json": { schema: { $ref: ref } },
							},
						},
					},
				},
			},
		},
	};
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

async function runArtifact(
	executable: string,
	cwd: string,
): Promise<PublicSchemaResult> {
	const process = Bun.spawn({
		cmd: [executable, "__schema", "--commands", "--json"],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	return JSON.parse(stdout.trim()) as PublicSchemaResult;
}

beforeAll(async () => {
	// Always compile the current source. The stale marker proves the build's
	// clean step ran instead of allowing an old dist tree to satisfy the test.
	const staleMarker = path.resolve("dist/.specli-stale-build");
	await mkdir(path.dirname(staleMarker), { recursive: true });
	await writeFile(staleMarker, "stale");

	const build = Bun.spawn({
		cmd: ["bun", "run", "build"],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		build.exited,
		new Response(build.stdout).text(),
		new Response(build.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`Production build failed:\n${stdout}${stderr}`);
	}
	await expect(access(staleMarker)).rejects.toThrow();
}, 30_000);

describe("compile resolved snapshot parity", () => {
	test("rejects Swagger 2 before invoking Bun build", async () => {
		const temp = await mkdtemp(path.join(os.tmpdir(), "specli-swagger2-"));
		const rootPath = path.join(temp, "swagger.json");
		const executable = path.join(temp, "legacy-api");
		await writeFile(
			rootPath,
			JSON.stringify({
				swagger: "2.0",
				info: { title: "Legacy", version: "1.0.0" },
				paths: {},
			}),
		);
		const originalSpawn = Bun.spawn;
		let buildInvoked = false;
		Bun.spawn = (() => {
			buildInvoked = true;
			throw new Error("Bun build must not be invoked");
		}) as unknown as typeof Bun.spawn;

		try {
			await expect(
				compileCommand(rootPath, { outfile: executable }),
			).rejects.toThrow("not a valid OpenAPI 3 document");
			expect(buildInvoked).toBe(false);
			await expect(access(executable)).rejects.toThrow();
		} finally {
			Bun.spawn = originalSpawn;
			await rm(temp, { recursive: true, force: true });
		}
	});

	test("compiled multi-file spec matches dynamic mode after sources move", async () => {
		const temp = await mkdtemp(path.join(os.tmpdir(), "specli-compile-"));
		const source = path.join(temp, "source");
		const moved = path.join(temp, "moved-source");
		const runDirectory = path.join(temp, "run-elsewhere");
		const executable = path.join(temp, "compiled-api");
		await mkdir(source);
		await mkdir(runDirectory);
		const rootPath = path.join(source, "root.json");
		await writeFile(
			rootPath,
			JSON.stringify(rootDocument("./child.json#/Widget", "Compile API")),
		);
		await writeFile(
			path.join(source, "child.json"),
			JSON.stringify({ Widget: { type: "object", description: "external" } }),
		);

		try {
			const resolved = await resolveSpecBundle({ spec: rootPath });
			const dynamic = await buildRuntimeContext({ spec: rootPath });
			const embedded = await buildRuntimeContext({
				embeddedSpecText: resolved.canonicalText,
			});
			expect(embedded.loaded.fingerprint).toBe(dynamic.loaded.fingerprint);
			expect(embedded.operations).toEqual(dynamic.operations);
			expect(embedded.commandsIndex).toEqual(dynamic.commandsIndex);

			const originalCwd = process.cwd();
			process.chdir(temp);
			try {
				await compileCommand(rootPath, {
					name: "Exact_NAME",
					outfile: executable,
				});
			} finally {
				process.chdir(originalCwd);
			}
			await access(executable);
			await rename(source, moved);

			const result = await runArtifact(executable, runDirectory);
			const dynamicCommands = dynamic.planned.map(
				({ resource, action, pathArgs }) => ({
					resource,
					action,
					pathArgs,
				}),
			);
			expect(result.data.cliName).toBe("Exact_NAME");
			expect(result.data.commands).toEqual(dynamicCommands);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	}, 30_000);

	test("default URL name shares the single acquisition snapshot", async () => {
		const temp = await mkdtemp(path.join(os.tmpdir(), "specli-name-"));
		const executable = path.join(temp, "url-api");
		const rootUrl = "https://spec.example/root.json";
		const childUrl = "https://spec.example/child.json";
		const counts = new Map<string, number>();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input) => {
			const url = requestUrl(input);
			counts.set(url, (counts.get(url) ?? 0) + 1);
			if (url === rootUrl) {
				return Response.json(
					rootDocument("./child.json#/Widget", "Acquisition API"),
				);
			}
			if (url === childUrl) {
				return Response.json({ Widget: { type: "string" } });
			}
			return new Response("missing", { status: 404 });
		}) as typeof fetch;

		try {
			const originalCwd = process.cwd();
			process.chdir(temp);
			try {
				await compileCommand(rootUrl, { outfile: executable });
			} finally {
				process.chdir(originalCwd);
			}
			await access(executable);
			expect(counts.get(rootUrl)).toBe(1);
			expect(counts.get(childUrl)).toBe(1);
			const result = await runArtifact(executable, temp);
			expect(result.data.cliName).toBe("acquisition-api");
			expect(counts.get(rootUrl)).toBe(1);
			expect(counts.get(childUrl)).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
			await rm(temp, { recursive: true, force: true });
		}
	}, 30_000);
});

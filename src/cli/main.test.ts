import { describe, expect, test } from "bun:test";

import { ROOT_COMMAND_NAMES } from "./core/root-command-names.js";
import { main } from "./main.js";

const LOGIN_RESOURCE_SPEC = JSON.stringify({
	openapi: "3.0.3",
	info: { title: "Root collision", version: "1" },
	servers: [{ url: "https://api.example.test" }],
	paths: {
		"/sessions": {
			get: {
				operationId: "listLogin",
				tags: ["Login"],
				responses: {
					"200": {
						description: "OK",
						content: {
							"application/json": { schema: { type: "array" } },
						},
					},
				},
			},
		},
	},
});

async function captureStdout(run: () => Promise<void>): Promise<string> {
	const originalWrite = process.stdout.write;
	const originalExitCode = process.exitCode;
	const chunks: string[] = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
		);
		return true;
	}) as typeof process.stdout.write;

	try {
		await run();
		return chunks.join("");
	} finally {
		process.stdout.write = originalWrite;
		process.exitCode = originalExitCode;
	}
}

async function runEmbeddedCommand(commandArgs: string[]): Promise<string> {
	const mainModule = new URL("./main.js", import.meta.url).href;
	const source = `
		import { main } from ${JSON.stringify(mainModule)};
		await main(
			["bun", "specli", ...${JSON.stringify(commandArgs)}],
			{ embeddedSpecText: ${JSON.stringify(LOGIN_RESOURCE_SPEC)} },
		);
	`;
	const subprocess = Bun.spawn([process.execPath, "-e", source], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	return stdout;
}

describe("combined built-in and generated command registration", () => {
	test("qualifies a login resource without losing any root or generated command", async () => {
		const options = { embeddedSpecText: LOGIN_RESOURCE_SPEC };

		const help = await captureStdout(() => main(["bun", "specli"], options));
		expect(help).toContain("OpenAPI Commands:");
		expect(help).toContain("  openapi-login");
		expect(help).toContain(`${ROOT_COMMAND_NAMES.login} [token]`);
		expect(help).toContain(ROOT_COMMAND_NAMES.logout);
		expect(help).toContain(ROOT_COMMAND_NAMES.whoami);
		expect(help).toContain(ROOT_COMMAND_NAMES.schema);
		expect(help).toContain(`1) specli ${ROOT_COMMAND_NAMES.schema}`);
		expect(help).toContain("-h, --help");

		const helpCommand = await runEmbeddedCommand([ROOT_COMMAND_NAMES.help]);
		expect(helpCommand).toContain("Agent workflow:");
		expect(helpCommand).toContain(`1) specli ${ROOT_COMMAND_NAMES.schema}`);

		const schemaOutput = await captureStdout(() =>
			main(
				["bun", "specli", "--json", ROOT_COMMAND_NAMES.schema, "--commands"],
				options,
			),
		);
		const schema = JSON.parse(schemaOutput) as {
			data: {
				commands: Array<{
					resource: string;
					action: string;
					pathArgs: string[];
				}>;
			};
		};
		expect(schema.data.commands).toHaveLength(1);
		const generated = schema.data.commands[0];
		expect(generated).toEqual({
			resource: "openapi-login",
			action: "list",
			pathArgs: [],
		});

		const generatedHelp = await runEmbeddedCommand([
			generated?.resource ?? "",
			generated?.action ?? "",
			"--help",
		]);
		expect(generatedHelp).toContain(
			`use '${ROOT_COMMAND_NAMES.login}' command`,
		);

		const curlOutput = await captureStdout(() =>
			main(
				[
					"bun",
					"specli",
					"--json",
					generated?.resource ?? "",
					generated?.action ?? "",
					"--curl",
				],
				options,
			),
		);
		const curl = JSON.parse(curlOutput) as { curl: string; ok: boolean };
		expect(curl.ok).toBe(true);
		expect(curl.curl).toContain("-X GET");
		expect(curl.curl).toContain("https://api.example.test/sessions");
	});
});

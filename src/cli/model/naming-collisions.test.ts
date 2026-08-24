import { describe, expect, test } from "bun:test";

import type { NormalizedOperation } from "../core/types.js";
import { type PlannedOperation, planOperations } from "./naming.js";

function operation(
	method: string,
	path: string,
	operationId: string | undefined,
	tags: string[] = ["records"],
): NormalizedOperation {
	return {
		key: `${method} ${path}`,
		method,
		path,
		operationId,
		tags,
		parameters: [],
	};
}

function actionsByPath(planned: PlannedOperation[]): Record<string, string> {
	return Object.fromEntries(planned.map((op) => [op.path, op.action]));
}

function commandsByRequest(
	planned: PlannedOperation[],
): Record<string, string> {
	return Object.fromEntries(
		planned.map((op) => [op.key, `${op.resource} ${op.action}`]),
	);
}

function permutations<T>(values: T[]): T[][] {
	if (values.length <= 1) return [values];
	return values.flatMap((value, index) =>
		permutations(values.filter((_, candidate) => candidate !== index)).map(
			(rest) => [value, ...rest],
		),
	);
}

describe("final command collision repair", () => {
	test("preserves the first path segment before a Unicode line separator", () => {
		const [planned] = planOperations([
			operation("GET", "/Contacts.\u2028List", undefined, []),
		]);
		expect(`${planned?.resource} ${planned?.action}`).toBe("contacts list");
	});

	test("repairs the Jira collision independently of input order", () => {
		const operations = [
			operation("GET", "/priority", "getPriorities", ["Issue priorities"]),
			operation("GET", "/priority/search", "searchPriorities", [
				"Issue priorities",
			]),
		];
		const planned = planOperations(operations);
		expect(planned.map(({ aliasOf }) => aliasOf)).toEqual([
			"issue-priorities list",
			"issue-priorities list",
		]);
		expect(actionsByPath(planOperations([...operations].reverse()))).toEqual(
			actionsByPath(planned),
		);
	});

	test("keeps Jira's operationId-derived worklog owner", () => {
		const collection = "/rest/api/3/issue/{issueIdOrKey}/worklog";
		const item = "/rest/api/3/issue/{issueIdOrKey}/worklog/{id}";
		const planned = planOperations([
			operation("GET", collection, "getIssueWorklog", ["Issue worklogs"]),
			operation("GET", item, "getWorklog", ["Issue worklogs"]),
		]);

		expect(actionsByPath(planned)).toEqual({
			[collection]: "get-issue-worklog",
			[item]: "get-worklog",
		});
	});

	test("gives sole base fallbacks the short action", () => {
		const videos = [
			operation("GET", "/videos/{video_id}", "GetVideo", ["Videos"]),
			operation("GET", "/videos/{video_id}/content", "RetrieveVideoContent", [
				"Videos",
			]),
			operation(
				"GET",
				"/videos/characters/{character_id}",
				"GetVideoCharacter",
				["Videos"],
			),
		];
		const repos = [
			operation(
				"PUT",
				"/orgs/{org}/rulesets/{ruleset_id}",
				"repos/update-org-ruleset",
				["repos"],
			),
			operation("PATCH", "/repos/{owner}/{repo}", "repos/update", ["repos"]),
		];

		const cases: Array<{
			operations: NormalizedOperation[];
			expected: Record<string, string>;
		}> = [
			{
				operations: videos,
				expected: {
					"GET /videos/{video_id}": "videos get",
					"GET /videos/{video_id}/content": "videos get-content",
					"GET /videos/characters/{character_id}": "videos get-character",
				},
			},
			{
				operations: repos,
				expected: {
					"PUT /orgs/{org}/rulesets/{ruleset_id}":
						"repos update-update-org-ruleset",
					"PATCH /repos/{owner}/{repo}": "repos update",
				},
			},
		];

		for (const { operations, expected } of cases) {
			for (const input of [operations, [...operations].reverse()]) {
				expect(commandsByRequest(planOperations(input))).toEqual(expected);
			}
		}
	});

	test("keeps path-derived numeric spelling separate from a base fallback", () => {
		const basePath = "/users/{id}";
		const readablePath = "/users/{id}/1";
		const planned = planOperations([
			operation("GET", basePath, undefined, ["users"]),
			operation("GET", readablePath, undefined, ["users"]),
		]);
		const byPath = actionsByPath(planned);

		expect(byPath[readablePath]).toBe("get-1");
		expect(byPath[basePath]).toBe("get");
	});

	test("advances tied base fallbacks through distinct full operationIds", () => {
		const ops = [
			operation("GET", "/users/{id}", "getUser", ["users"]),
			operation("GET", "/users/{userId}", "retrieveUser", ["users"]),
		];
		const expected = {
			"/users/{id}": "get-user",
			"/users/{userId}": "retrieve-user",
		};

		for (const input of [ops, [...ops].reverse()]) {
			const planned = planOperations(input);
			expect(actionsByPath(planned)).toEqual(expected);
			expect(planned.some((op) => op.action === "get")).toBeFalse();
		}
	});

	test("advances equal base fallbacks to distinct exact terminals", () => {
		const id = "/users/{id}";
		const userId = "/users/{userId}";
		const ops = [
			operation("GET", id, "getUser", ["users"]),
			operation("GET", userId, "getUser", ["users"]),
		];

		const forward = actionsByPath(planOperations(ops));
		const reverse = actionsByPath(planOperations([...ops].reverse()));
		expect(reverse).toEqual(forward);
		expect(forward[id]).toStartWith("get-user--specli-route-v1-get-");
		expect(forward[userId]).toStartWith("get-user--specli-route-v1-get-");
		expect(forward[id]).not.toBe(forward[userId]);
		expect(Object.values(forward)).not.toContain("get");
	});

	test("preserves Atlassian path-derived API version actions", () => {
		const planned = planOperations([
			operation("DELETE", "/rest/api/3/dashboard/{id}", "deleteDashboard", [
				"dashboards",
			]),
			operation("DELETE", "/rest/api/3/dashboard/bulk", "deleteDashboardBulk", [
				"dashboards",
			]),
			operation("PUT", "/rest/api/3/dashboard/{id}", "updateDashboard", [
				"dashboards",
			]),
			operation(
				"PUT",
				"/rest/api/3/dashboard/{id}/items",
				"updateDashboardItems",
				["dashboards"],
			),
		]);
		const byRequest = commandsByRequest(planned);

		expect(byRequest["DELETE /rest/api/3/dashboard/{id}"]).toBe(
			"dashboards delete-3",
		);
		expect(byRequest["PUT /rest/api/3/dashboard/{id}"]).toBe(
			"dashboards update-3",
		);
	});

	test("preserves an authored numeric operationId term", () => {
		const planned = planOperations([
			operation("GET", "/artifacts/{id}", "getArtifactV_2", ["artifacts"]),
			operation("GET", "/artifacts/{id}/meta", "getArtifactMeta", [
				"artifacts",
			]),
		]);

		expect(actionsByPath(planned)["/artifacts/{id}"]).toBe("get-v-2");
	});

	test("does not displace an initially uncontested second-order owner", () => {
		const owner = "/IssueWorklogs.GetIssueWorklog";
		const collection = "/rest/api/3/issue/{issueIdOrKey}/worklog";
		const item = "/rest/api/3/issue/{issueIdOrKey}/worklog/{id}";
		const planned = planOperations([
			operation("POST", owner, "IssueWorklogs.GetIssueWorklog", [
				"Issue worklogs",
			]),
			operation("GET", collection, "getIssueWorklog", ["Issue worklogs"]),
			operation("GET", item, "getWorklog", ["Issue worklogs"]),
		]);
		const byPath = actionsByPath(planned);

		expect(byPath[owner]).toBe("get-issue-worklog");
		expect(byPath[item]).toBe("get-worklog");
		expect(byPath[collection]).toStartWith(
			"get-issue-worklog--specli-route-v1-get-",
		);
	});

	test("uses one readable path qualifier after tied full operationIds", () => {
		const draft = "/records/{id}/draft";
		const published = "/records/{id}/published";
		const operations = [
			operation("GET", draft, "getRecordVersion"),
			operation("GET", published, "getRecordVersion"),
		];
		const planned = planOperations(operations);

		expect(actionsByPath(planned)).toEqual({
			[draft]: "get-record-version-draft",
			[published]: "get-record-version-published",
		});
		expect(actionsByPath(planOperations([...operations].reverse()))).toEqual(
			actionsByPath(planned),
		);
	});

	test("selects then rejects a redundant path segment without scavenging", () => {
		const v1 = "/v1/records/{id}";
		const v2 = "/v2/records/{id}";
		const planned = planOperations([
			operation("GET", v1, "getRecordVersion"),
			operation("GET", v2, "getRecordVersion"),
		]);
		const byPath = actionsByPath(planned);

		expect(byPath[v1]).toStartWith("get-record-version--specli-route-v1-get-");
		expect(byPath[v2]).toStartWith("get-record-version--specli-route-v1-get-");
	});

	test("uses exact route identities when all readable candidates tie", () => {
		const records = "/records/😀/{id}/versions";
		const archives = "/archives/😁/{id}/versions";
		const planned = planOperations([
			operation("GET", records, "getRecord"),
			operation("GET", archives, "getRecord"),
		]);
		const byPath = actionsByPath(planned);
		const prefix = "get-record-versions--specli-route-v1-get-";

		expect(byPath[records]).toStartWith(prefix);
		expect(byPath[archives]).toStartWith(prefix);
		expect(byPath[records]).not.toBe(byPath[archives]);
		expect(byPath[records]?.slice(prefix.length)).toMatch(/^(?:[0-9a-f]{4})+$/);
		expect(byPath[records]).toContain("002fd83dde00002f");
	});

	test("uses final command identity for duplicate request terminals", () => {
		expect(
			planOperations([
				operation("GET", "/shared", "listRecords", ["records"]),
				operation("GET", "/shared", "listArchives", ["archives"]),
			]).map(({ resource, action, aliasOf }) => [resource, action, aliasOf]),
		).toEqual([
			["records", "list", undefined],
			["archives", "list", undefined],
		]);

		expect(
			planOperations([
				operation("GET", "/shared", "getRecordDraft"),
				operation("GET", "/shared", "getRecordPublished"),
			]).map(({ action }) => action),
		).toEqual(["list-draft", "list-published"]);

		expect(() =>
			planOperations([
				operation("GET", "/records/{id}/versions", "getRecord"),
				operation("GET", "/records/{id}/versions", "getRecord"),
			]),
		).toThrow(
			"Cannot generate a unique command for request: GET /records/{id}/versions",
		);
	});

	test("maps a three-operation group identically in all six permutations", () => {
		const deployments = [
			operation("GET", "/deployments/{id}", "getDeployment", ["deployments"]),
			operation("GET", "/deployments/{id}/events", "getDeploymentEvents", [
				"deployments",
			]),
			operation("GET", "/deployments/{id}/files", "listDeploymentFiles", [
				"deployments",
			]),
		];
		const expected = {
			"GET /deployments/{id}": "deployments get",
			"GET /deployments/{id}/events": "deployments get-events",
			"GET /deployments/{id}/files": "deployments get-files",
		};

		for (const input of permutations(deployments)) {
			expect(commandsByRequest(planOperations(input))).toEqual(expected);
		}
	});
});

import { pluralize } from "../core/pluralize.js";
import { kebabCase } from "../core/strings.js";
import type { NormalizedOperation } from "../core/types.js";

export type PlannedOperation = NormalizedOperation & {
	resource: string;
	action: string;
	/** CLI-friendly path arg names (kebab-case) */
	pathArgs: string[];
	/** Original path template variable names (for URL substitution) */
	rawPathArgs: string[];
	style: "rest" | "rpc";
	canonicalAction: string;
	aliasOf?: string;
};

const GENERIC_TAGS = new Set(["default", "defaults", "api"]);

function getPathSegments(path: string): string[] {
	return path
		.split("/")
		.map((s) => s.trim())
		.filter(Boolean);
}

function getPathArgs(path: string): string[] {
	return Array.from(path.matchAll(/\{([^}]+)\}/g)).flatMap((match) =>
		match.slice(1),
	);
}

function splitOperationId(operationId: string): {
	prefix?: string;
	suffix?: string;
} {
	const trimmed = operationId.trim();
	if (!trimmed) return {};

	for (const separator of [".", "__", "_"]) {
		if (!trimmed.includes(separator)) continue;
		const [prefix, ...rest] = trimmed.split(separator);
		return { prefix, suffix: rest.join(separator) };
	}

	return { suffix: trimmed };
}

function inferResource(op: NormalizedOperation): string {
	const tag = op.tags[0]?.trim();
	if (tag && !GENERIC_TAGS.has(tag.toLowerCase())) {
		return pluralize(kebabCase(tag));
	}

	if (op.operationId) {
		const { prefix } = splitOperationId(op.operationId);
		if (prefix) {
			const fromId = kebabCase(prefix);
			if (fromId === "ping") return "ping";
			return pluralize(fromId);
		}
	}

	const segments = getPathSegments(op.path);
	let first = segments[0] ?? "api";

	// If first segment is rpc-ish, like Contacts.List, split it.
	first = first.replace(/\.[\s\S]*$/, "");

	// Singletons like /ping generally shouldn't become `pings`.
	if (first.toLowerCase() === "ping") return "ping";

	// Strip path params if they appear in first segment (rare)
	const cleaned = first.replace(/^\{.+\}$/, "");
	return pluralize(kebabCase(cleaned || "api"));
}

/**
 * Extracts a meaningful disambiguator from an operationId by removing
 * redundant parts that are already represented in the command name.
 *
 * Examples:
 *   - "createDeployment" with action "create" and resource "deployments" -> null (no extra info)
 *   - "uploadDeploymentFiles" with action "create" and resource "deployments" -> "upload-files"
 *   - "getDeploymentEvents" with action "get" and resource "deployments" -> "events"
 */
function extractDisambiguator(
	operationId: string,
	action: string,
	resource: string,
): string | null {
	// Convert to kebab for consistent comparison
	let name = kebabCase(operationId);

	// Remove action prefix if it matches the command's action or its synonyms
	// This avoids redundancy like "get-get-deployment" or "get-list-files"
	const actionSynonyms: Record<string, string[]> = {
		get: ["get", "retrieve", "read", "list", "search"],
		list: ["list", "search", "get"],
		create: ["create", "post"],
		update: ["update", "patch", "put"],
		delete: ["delete", "remove"],
	};
	const synonyms = actionSynonyms[action] ?? [action];

	for (const synonym of synonyms) {
		if (name.startsWith(`${synonym}-`)) {
			name = name.slice(synonym.length + 1);
			break;
		}
	}

	// Remove resource name (singular and plural forms) from anywhere in the string
	const singularResource = resource.replace(/s$/, "");
	const resourcePatterns = [resource, singularResource];
	for (const pattern of resourcePatterns) {
		// Remove from start: "deployment-events" -> "events"
		if (name.startsWith(`${pattern}-`)) {
			name = name.slice(pattern.length + 1);
		}
		// Remove from middle: "upload-deployment-files" -> "upload-files"
		else if (name.includes(`-${pattern}-`)) {
			name = name.replace(`-${pattern}-`, "-");
		}
		// Remove from end: "upload-deployment" -> "upload"
		else if (name.endsWith(`-${pattern}`)) {
			name = name.slice(0, -(pattern.length + 1));
		}
		// Exact match means no extra info
		if (name === pattern) {
			return null;
		}
	}

	// If nothing meaningful remains, return null
	if (!name || name === action) return null;

	return name;
}

const LEGACY_SOURCE_STRENGTH = {
	"base-fallback": 0,
	"path-derived": 1,
	"operation-id-derived": 2,
	uncontested: 3,
} as const;

type LegacyNameSource = keyof typeof LEGACY_SOURCE_STRENGTH;

type LegacyPlannedOperation = {
	op: PlannedOperation;
	source: LegacyNameSource;
};

/** Derives the first candidate and its collision-repair priority. */
function deriveLegacyCandidate(op: PlannedOperation): {
	action: string;
	source: LegacyNameSource;
} {
	if (op.operationId) {
		const disambiguator = extractDisambiguator(
			op.operationId,
			op.action,
			op.resource,
		);
		if (disambiguator) {
			// Use the disambiguator directly as action: "upload-files", "get-events"
			return {
				action: `${op.action}-${disambiguator}`,
				source: "operation-id-derived",
			};
		}
	}

	// Fallback: try to extract something from the path
	const segments = getPathSegments(op.path);
	// Look for the last non-parameter segment that isn't the resource
	const singularResource = op.resource.replace(/s$/, "");
	for (let i = segments.length - 1; i >= 0; i--) {
		const seg = segments[i];
		if (!seg || seg.startsWith("{")) continue;
		const kebabSeg = kebabCase(seg);
		if (kebabSeg !== op.resource && kebabSeg !== singularResource) {
			return {
				action: `${op.action}-${kebabSeg}`,
				source: "path-derived",
			};
		}
	}

	// Equal fallback claims advance together through the repair stages below.
	return { action: op.action, source: "base-fallback" };
}

function canonicalizeAction(action: string): string {
	const a = kebabCase(action);

	// Common RPC verbs -> REST canonical verbs
	if (a === "retrieve" || a === "read") return "get";
	if (a === "search") return "list";
	if (a === "patch") return "update";
	if (a === "remove") return "delete";

	return a;
}

function inferRestAction(op: NormalizedOperation): string {
	// If operationId is present and looks intentional, prefer it.
	// This helps with singleton endpoints like GET /ping (Ping.Get) vs collections.
	if (op.operationId) {
		const { suffix } = splitOperationId(op.operationId);
		if (suffix) {
			const fromId = canonicalizeAction(suffix);
			if (["get", "list", "create", "update", "delete"].includes(fromId)) {
				return fromId;
			}
		}
	}

	const method = op.method.toUpperCase();
	const hasId = getPathArgs(op.path).length > 0;

	if (method === "GET" && !hasId) return "list";
	if (method === "POST" && !hasId) return "create";

	if (method === "GET" && hasId) return "get";
	if ((method === "PUT" || method === "PATCH") && hasId) return "update";
	if (method === "DELETE" && hasId) return "delete";

	return kebabCase(method);
}

function inferRpcAction(op: NormalizedOperation): string {
	// Prefer operationId suffix: Contacts.List -> list
	if (op.operationId) {
		const { suffix } = splitOperationId(op.operationId);
		if (suffix) return canonicalizeAction(suffix);
	}

	// Else take last segment and split by '.'
	const segments = getPathSegments(op.path);
	const last = segments[segments.length - 1] ?? "";
	if (last.includes(".")) {
		return canonicalizeAction(last.slice(last.lastIndexOf(".") + 1));
	}

	return kebabCase(op.method);
}

export function planOperation(op: NormalizedOperation): PlannedOperation {
	const style =
		op.path.includes(".") ||
		(op.operationId?.includes(".") && op.method === "POST")
			? "rpc"
			: "rest";
	const resource = inferResource(op);
	const action = style === "rpc" ? inferRpcAction(op) : inferRestAction(op);
	const rawPathArgs = getPathArgs(op.path);

	return {
		...op,
		style,
		resource,
		action,
		canonicalAction: action,
		pathArgs: rawPathArgs.map((a) => kebabCase(a)),
		rawPathArgs,
	};
}

function applyLegacyCollisionHandling(
	planned: PlannedOperation[],
): LegacyPlannedOperation[] {
	const counts = new Map<string, number>();
	for (const op of planned) {
		const key = `${op.resource}:${op.action}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	return planned.map((op) => {
		const key = `${op.resource}:${op.action}`;
		if (counts.get(key) === 1) return { op, source: "uncontested" };

		const candidate = deriveLegacyCandidate(op);

		return {
			op: {
				...op,
				action: candidate.action,
				aliasOf: `${op.resource} ${op.canonicalAction}`,
			},
			source: candidate.source,
		};
	});
}

function repairFinalCollisions(
	legacy: LegacyPlannedOperation[],
): PlannedOperation[] {
	type RepairOperation = LegacyPlannedOperation & { lastReadable: string };
	const operations: RepairOperation[] = legacy.map((claim) => ({
		...claim,
		lastReadable: claim.op.action,
	}));
	const groups = new Map<string, RepairOperation[]>();

	for (const claim of operations) {
		const { op } = claim;
		const key = `${op.resource}\0${op.action}`;
		const group = groups.get(key) ?? [];
		group.push(claim);
		groups.set(key, group);
	}

	const owned = new Set<string>();
	const blocked = new Set<string>();
	const pending = new Set<RepairOperation>();

	for (const [key, group] of groups) {
		if (group.length === 1) {
			owned.add(key);
			continue;
		}

		let strongest = -1;
		for (const { source } of group) {
			strongest = Math.max(strongest, LEGACY_SOURCE_STRENGTH[source]);
		}
		const winners = group.filter(
			({ source }) => LEGACY_SOURCE_STRENGTH[source] === strongest,
		);
		const winner = winners.length === 1 ? winners[0] : undefined;
		(winner ? owned : blocked).add(key);
		for (const claim of group) {
			if (claim === winner) continue;
			pending.add(claim);
		}
	}

	const runReadableStage = (
		derive: (op: PlannedOperation, last: string) => string | undefined,
	): void => {
		const proposals = new Map<string, RepairOperation[]>();

		for (const unresolved of pending) {
			const action = derive(unresolved.op, unresolved.lastReadable);
			if (!action) continue;

			// The next stage extends this candidate even if this stage cannot award it.
			unresolved.lastReadable = action;
			const key = `${unresolved.op.resource}\0${action}`;
			const claimants = proposals.get(key) ?? [];
			claimants.push(unresolved);
			proposals.set(key, claimants);
		}

		// Arbitrate the whole stage, never by encounter order.
		for (const [key, claimants] of proposals) {
			if (owned.has(key) || blocked.has(key)) continue;
			if (claimants.length > 1) {
				blocked.add(key);
				continue;
			}

			// biome-ignore lint/style/noNonNullAssertion: a proposal group is never empty
			const unresolved = claimants[0]!;
			const { op, lastReadable: action } = unresolved;

			unresolved.op = { ...op, action };
			owned.add(key);
			pending.delete(unresolved);
		}
	};

	runReadableStage((op) => kebabCase(op.operationId ?? ""));
	runReadableStage((op, lastReadable) => {
		const selected = getPathSegments(op.path).findLast(
			(segment) => !segment.includes("{") && !segment.includes("}"),
		);
		if (!selected) return undefined;

		const qualifier = kebabCase(selected);
		const singularResource = op.resource.replace(/s$/, "");
		if (
			!qualifier ||
			qualifier === op.resource ||
			qualifier === singularResource ||
			`-${lastReadable}-`.includes(`-${qualifier}-`)
		) {
			return undefined;
		}
		return `${lastReadable}-${qualifier}`;
	});

	for (const unresolved of pending) {
		const { op, lastReadable } = unresolved;
		const pathHex = op.path
			.split("")
			.map((unit) => unit.charCodeAt(0).toString(16).padStart(4, "0"))
			.join("");
		const action = `${lastReadable}--specli-route-v1-${op.method.toLowerCase()}-${pathHex}`;
		const key = `${op.resource}\0${action}`;
		if (owned.has(key)) {
			throw new Error(
				`Cannot generate a unique command for request: ${op.method.toUpperCase()} ${op.path}`,
			);
		}

		unresolved.op = { ...op, action };
		owned.add(key);
	}

	return operations.map(({ op }) => op);
}

export function planOperations(ops: NormalizedOperation[]): PlannedOperation[] {
	const planned = ops.map(planOperation);
	const legacy = applyLegacyCollisionHandling(planned);
	return repairFinalCollisions(legacy);
}

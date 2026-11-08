/**
 * Host entry for `dsh-session-messaging`: messages between top-level sessions.
 *
 * Shipped messaging follows an authority edge: `send_message` reaches a direct parent or child
 * (`ctx.subagents`), and Agent Teams reaches members of one Team. Two unrelated top-level sessions
 * have no such edge, so they cannot talk. This plugin adds that channel as three model tools:
 *
 * - `session_list` lists the top-level sessions the caller can message.
 * - `session_send_message` resolves the target through `ctx.sessionController.resolveAgent`, the
 *   path a Web UI prompt takes (cold-resuming a stored session), and steers or queues one
 *   user-role message carrying the shipped relay attribution
 *   `{ kind: 'agent-message', form: 'relay', senderSessionId }`. The message lives in the target's
 *   session log, the Web UI shows it as a received task message naming the sender session, and
 *   the recipient answers with the same tool.
 * - `session_create` opens a session in a registered workspace through
 *   `ctx.sessionController.create`, the Web UI's new-chat path, titles it, and starts its first
 *   turn with the same relay message.
 *
 * Subagent sessions keep their adjacency-only routing: the tools are hidden from them and they
 * are never targets.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

export const name = "session-messaging";
export const inject = ["agents", "sessions", "sessionController", "sessionQuery", "tools"];

export const SEND_TOOL = "session_send_message";
export const LIST_TOOL = "session_list";
export const CREATE_TOOL = "session_create";
export const TOOL_NAMES = [SEND_TOOL, LIST_TOOL, CREATE_TOOL];

const DEFAULT_MAX_MESSAGE_BYTES = 65_536;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_TITLE_READS = 200;
const DEFAULT_CREATE_LIMIT = 10;

/** Validate the patch row's config, falling back to defaults field by field. */
export function normalizeConfig(raw) {
	const config = raw ?? {};
	return {
		crossWorkspace: config.crossWorkspace !== false,
		maxMessageBytes:
			Number.isSafeInteger(config.maxMessageBytes) && config.maxMessageBytes > 0
				? config.maxMessageBytes
				: DEFAULT_MAX_MESSAGE_BYTES,
		listLimit:
			Number.isSafeInteger(config.listLimit) && config.listLimit > 0
				? Math.min(config.listLimit, MAX_LIST_LIMIT)
				: DEFAULT_LIST_LIMIT,
		createLimit:
			Number.isSafeInteger(config.createLimit) && config.createLimit > 0
				? config.createLimit
				: DEFAULT_CREATE_LIMIT
	};
}

function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

function isSubagentHeader(header) {
	return header?.origin === "subagent" || (header?.delegationDepth ?? 0) > 0;
}

function nonEmpty(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function liveTitle(ctx, session) {
	try {
		return nonEmpty(ctx.get("sessionTitle")?.get(session)?.title);
	} catch {
		return undefined;
	}
}

function archivedSessionIds(ctx) {
	try {
		const ids = ctx.get("workspaceRegistry")?.archivedSessionIds;
		return Array.isArray(ids) ? ids : [];
	} catch {
		return [];
	}
}

/** The exact live calling Agent, which must own a top-level session. */
function callerOf(exec) {
	const agent = exec?.agent;
	if (agent?.session === undefined) throw new Error("session messaging requires a calling session");
	if (isSubagentHeader(agent.session.header)) {
		throw new Error("session messaging is only available to top-level sessions; a subagent reaches its parent with send_message");
	}
	return agent;
}

/** Header of an attached or stored session, without resuming it. */
async function readHeader(ctx, sessionId, signal) {
	const attached = ctx.sessions.get(sessionId);
	if (attached !== undefined) return attached.header;
	const records = await ctx.sessionQuery.filterSessions([{ kind: "id", values: [sessionId] }], signal);
	return records.find((record) => record.header.id === sessionId)?.header;
}

/** The registered Workspace that owns an absolute directory path, without creating one. */
async function workspaceAt(ctx, path) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === undefined) throw new Error(`${CREATE_TOOL} requires the workspace registry`);
	try {
		return await registry.resolveByPath(path);
	} catch {
		// A path that does not exist rejects in realpath; it is not a workspace either.
		return undefined;
	}
}

/**
 * Build the model-visible content of one relayed message: an attribution line naming the sender
 * and how to answer, followed by the sender's text.
 * @param sender - sender session id, optional title, and workspace when it differs from the target's.
 * @param text - message text authored by the sender's agent.
 */
export function relayContent(sender, text) {
	const id = JSON.stringify(sender.id);
	const label = sender.title === undefined ? "" : ` (${JSON.stringify(sender.title)})`;
	const workspace = sender.workspace === undefined ? "" : ` in workspace ${sender.workspace}`;
	return [
		{
			type: "text",
			// Adjacent text blocks reach the model concatenated; the blank line keeps the sender's text apart.
			text:
				`Message from session ${id}${label}${workspace}. It was written by that session's agent, not by your user. ` +
				`To answer, call ${SEND_TOOL} with session_id ${id}; do not reply only to acknowledge it.\n\n`
		},
		{ type: "text", text }
	];
}

/** The relay text parts for a subagent delivery (attribution stays in the text). */
function relayMessageParts(text) {
	return [{ type: "text", text }];
}

/** @returns the delivery mode, defaulting to steer. */
function deliveryOf(requested) {
	return requested === "queue" ? "queue" : "steer";
}

/** One identified, frozen user-role message with the shipped relay attribution. */
function relayMessage(senderId, content) {
	return deepFreeze({
		id: randomUUID(),
		role: "user",
		content,
		source: { kind: "agent-message", form: "relay", senderSessionId: senderId }
	});
}

async function sendMessage(ctx, config, args, exec) {
	const sender = callerOf(exec);
	const agentId = nonEmpty(args?.agent_id);
	if (agentId !== undefined) {
		const agentText = typeof args?.message === "string" ? args.message : "";
		if (agentText.trim() === "") throw new Error("message must contain non-whitespace text");
		const subagents = ctx.get("subagents");
		if (subagents === undefined) throw new Error("message not delivered: this Harness does not mount the subagent service; use the built-in send_message for child agents");
		const parts = relayMessageParts(agentText);
		const messageId = await subagents.sendMessage(sender, agentId, parts, { signal: exec.signal });
		return { messageId, sessionId: agentId, state: "agent", delivery: deliveryOf(undefined) };
	}
	const targetId = nonEmpty(args?.session_id);
	if (targetId === undefined) throw new Error("session_id or agent_id must name a target; use session_list to find a session");
	const text = typeof args?.message === "string" ? args.message : "";
	if (text.trim() === "") throw new Error("message must contain non-whitespace text");
	const delivery = args?.delivery ?? "steer";
	if (delivery !== "steer" && delivery !== "queue") throw new Error('delivery must be "steer" or "queue"');
	if (targetId === sender.id) throw new Error("a session cannot message itself");

	const header = await readHeader(ctx, targetId, exec.signal);
	if (header?.cwd === undefined) throw new Error(`session ${targetId} was not found; use session_list to find a session id`);
	if (isSubagentHeader(header)) {
		throw new Error(`session ${targetId} is a subagent session; only its parent can message it, with send_message`);
	}
	if (archivedSessionIds(ctx).includes(targetId)) {
		throw new Error(`session ${targetId} is archived and cannot receive messages until it is restored`);
	}
	const senderWorkspace = sender.session.header.cwd;
	if (!config.crossWorkspace && header.cwd !== senderWorkspace) {
		throw new Error(`session ${targetId} belongs to workspace ${header.cwd}; messaging other workspaces is disabled (crossWorkspace: false)`);
	}
	const content = relayContent(
		{
			id: sender.id,
			title: liveTitle(ctx, sender.session),
			workspace: senderWorkspace !== undefined && senderWorkspace !== header.cwd ? senderWorkspace : undefined
		},
		text
	);
	const bytes = Buffer.byteLength(JSON.stringify(content), "utf8");
	if (bytes > config.maxMessageBytes) {
		throw new Error(`message not delivered: ${bytes} bytes exceeds the ${config.maxMessageBytes}-byte limit`);
	}
	exec.signal.throwIfAborted();

	const before = ctx.agents.get(targetId);
	const state = before === undefined ? "stored" : before.status === "running" ? "running" : "idle";
	// Resume as an unattributed Host operation, like a Web UI prompt: the target stays a runtime
	// root and is not recorded as work initiated by the sender's turn.
	const resolved = await ctx.agents.withoutInitiator(() => ctx.sessionController.resolveAgent(targetId));
	if ("error" in resolved) throw new Error(`message not delivered: ${resolved.error?.message ?? String(resolved.error)}`);
	const target = resolved.agent;
	exec.signal.throwIfAborted();
	if (ctx.agents.get(target.id) !== target) throw new Error(`message not delivered: session ${targetId} was unloaded during delivery`);

	const message = relayMessage(sender.id, content);
	ctx.agents.withoutInitiator(() => (delivery === "queue" ? target.followup(message) : target.steer(message)));
	// Acceptance is the inbox splice above; the flush only shortens the window before it reaches disk.
	try {
		await ctx.sessions.flush(target.session);
	} catch {}

	const title = liveTitle(ctx, target.session);
	return {
		messageId: message.id,
		sessionId: target.id,
		...(title === undefined ? {} : { title }),
		state,
		delivery
	};
}

function renderSend(value) {
	const label = value.title === undefined ? "" : ` (${JSON.stringify(value.title)})`;
	const outcome =
		value.state === "running"
			? value.delivery === "queue"
				? "It is busy; the message starts its next turn after the current one ends."
				: "It is busy and reads the message at its next step."
			: value.state === "agent"
				? "It is a subagent; the message is queued to its inbox."
				: value.state === "idle"
					? "It was idle and is starting a turn with the message."
					: "It was resumed from storage and is starting a turn with the message.";
	return `Message delivered to session ${value.sessionId}${label}. ${outcome}`;
}

async function createSession(ctx, config, opened, args, exec) {
	const creator = callerOf(exec);
	const title = nonEmpty(args?.title);
	if (title === undefined) throw new Error("title must contain non-whitespace text");
	const text = typeof args?.message === "string" ? args.message : "";
	if (text.trim() === "") throw new Error("message must contain non-whitespace text");

	const creatorCwd = creator.session.header.cwd;
	const home = creatorCwd === undefined ? undefined : await workspaceAt(ctx, creatorCwd);
	const requested = nonEmpty(args?.workspace);
	let workspace = home;
	if (requested !== undefined) {
		if (!isAbsolute(requested)) throw new Error("workspace must be an absolute directory path, as session_list shows it");
		workspace = await workspaceAt(ctx, requested);
		if (workspace === undefined) {
			throw new Error(`${requested} is not a registered workspace; session_list with all_workspaces shows the workspaces in use`);
		}
	} else if (workspace === undefined) {
		throw new Error("this session is not in a registered workspace; pass workspace with a path from session_list");
	}
	if (!config.crossWorkspace && workspace.id !== home?.id) {
		throw new Error(`${workspace.path} is not this session's workspace; opening sessions in other workspaces is disabled (crossWorkspace: false)`);
	}

	const content = relayContent(
		{
			id: creator.id,
			title: liveTitle(ctx, creator.session),
			workspace: workspace.id === home?.id ? undefined : (home?.path ?? creatorCwd)
		},
		text
	);
	const bytes = Buffer.byteLength(JSON.stringify(content), "utf8");
	if (bytes > config.maxMessageBytes) {
		throw new Error(`session not opened: the message is ${bytes} bytes, over the ${config.maxMessageBytes}-byte limit`);
	}
	const count = opened.get(creator.id) ?? 0;
	if (count >= config.createLimit) {
		throw new Error(`session not opened: this session has reached its limit of ${config.createLimit} new sessions per Harness run (createLimit)`);
	}
	exec.signal.throwIfAborted();

	// Count the attempt before awaiting; a failed creation gives the slot back.
	opened.set(creator.id, count + 1);
	let sessionId;
	try {
		// Open as an unattributed Host operation, like the Web UI's new-chat button: the new session
		// is a runtime root, not work initiated by the creator's turn.
		({ sessionId } = await ctx.agents.withoutInitiator(() => ctx.sessionController.create({ workspaceId: workspace.id })));
	} catch (error) {
		opened.set(creator.id, (opened.get(creator.id) ?? 1) - 1);
		throw new Error(`session not opened: ${error?.message ?? String(error)}`);
	}
	const resolved = await ctx.agents.withoutInitiator(() => ctx.sessionController.resolveAgent(sessionId));
	if ("error" in resolved) {
		throw new Error(`session ${sessionId} was opened but did not receive the message: ${resolved.error?.message ?? String(resolved.error)}`);
	}
	const target = resolved.agent;

	// Relayed messages never trigger automatic titling, so name the session before its turn starts.
	let accepted;
	try {
		accepted = nonEmpty(ctx.get("sessionTitle")?.rename(target.session, title)?.title);
	} catch (error) {
		ctx.logger?.warn?.(`session-messaging: could not title session ${sessionId}: ${error?.message ?? error}`);
	}
	const message = relayMessage(creator.id, content);
	ctx.agents.withoutInitiator(() => target.followup(message));
	try {
		await ctx.sessions.flush(target.session);
	} catch {}

	return {
		sessionId,
		...(accepted === undefined ? {} : { title: accepted }),
		workspace: workspace.path,
		messageId: message.id
	};
}

function renderCreate(value) {
	const label = value.title === undefined ? "" : ` (${JSON.stringify(value.title)})`;
	return `Opened session ${value.sessionId}${label} in workspace ${value.workspace}. It is starting a turn with your message.`;
}

function summaryTitle(item) {
	return nonEmpty(item.projections?.values?.title);
}

/** Fill titles the listing hints lack, for the rows actually returned. */
async function fillMissingTitles(ctx, rows, signal) {
	const missing = rows.filter((row) => row.title === undefined).map((row) => row.sessionId);
	if (missing.length === 0) return;
	let observations;
	try {
		observations = await ctx.sessionQuery.readTitleSnapshots(missing, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		return;
	}
	const titles = new Map();
	for (const observation of observations) {
		const title = observation.status === "fulfilled" ? nonEmpty(observation.value?.title?.title) : undefined;
		if (title !== undefined) titles.set(observation.sessionId, title);
	}
	for (const row of rows) if (row.title === undefined && titles.has(row.sessionId)) row.title = titles.get(row.sessionId);
}

async function listSessions(ctx, config, args, exec) {
	const caller = callerOf(exec);
	const workspace = caller.session.header.cwd;
	const allWorkspaces = args?.all_workspaces === true;
	if (allWorkspaces && !config.crossWorkspace) {
		throw new Error("listing other workspaces is disabled (crossWorkspace: false)");
	}
	if (!allWorkspaces && workspace === undefined) {
		throw new Error("this session has no workspace; set all_workspaces to true");
	}
	const requested = Number.isSafeInteger(args?.limit) && args.limit > 0 ? args.limit : config.listLimit;
	const limit = Math.min(requested, MAX_LIST_LIMIT);
	const query = nonEmpty(args?.query)?.toLowerCase();

	const { items } = await ctx.sessionController.list({}, exec.signal);
	const archived = new Set(archivedSessionIds(ctx));
	const candidates = [];
	for (const item of items) {
		if (item.sessionId === caller.id || item.blank || item.cwd === undefined) continue;
		if (item.origin === "subagent" || archived.has(item.sessionId)) continue;
		if (!allWorkspaces && item.cwd !== workspace) continue;
		candidates.push({
			sessionId: item.sessionId,
			status: item.running ? "running" : "inactive",
			updatedAt: Number.isFinite(item.updatedAt) ? new Date(item.updatedAt).toISOString() : "unknown",
			title: summaryTitle(item),
			workspace: item.cwd
		});
	}
	let matches = candidates;
	if (query !== undefined) {
		// Listing hints usually carry titles; read the rest so a title query does not miss them.
		await fillMissingTitles(ctx, candidates.filter((row) => row.title === undefined).slice(0, MAX_TITLE_READS), exec.signal);
		matches = candidates.filter((row) => row.sessionId.toLowerCase().includes(query) || (row.title ?? "").toLowerCase().includes(query));
	}
	const sessions = matches.slice(0, limit);
	await fillMissingTitles(ctx, sessions, exec.signal);
	return {
		...(allWorkspaces ? {} : { workspace }),
		total: matches.length,
		sessions: sessions.map(({ title, workspace: rowWorkspace, ...row }) => ({
			...row,
			...(title === undefined ? {} : { title }),
			...(allWorkspaces ? { workspace: rowWorkspace } : {})
		}))
	};
}

function renderList(value) {
	const scope = value.workspace === undefined ? "all workspaces" : `workspace ${value.workspace}`;
	if (value.sessions.length === 0) {
		return value.workspace === undefined
			? "No other top-level sessions found."
			: `No other top-level sessions found in ${scope}. Set all_workspaces to true to include other workspaces.`;
	}
	const lines = [
		`Sessions in ${scope}, most recently active first (${value.sessions.length} of ${value.total}; this session excluded):`
	];
	for (const row of value.sessions) {
		const title = row.title === undefined ? "untitled" : JSON.stringify(row.title);
		const where = row.workspace === undefined ? "" : ` | workspace ${row.workspace}`;
		lines.push(`- ${row.sessionId} [${row.status}] ${title} | active ${row.updatedAt}${where}`);
	}
	return lines.join("\n");
}

const sendOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["messageId", "sessionId", "state", "delivery"],
	properties: {
		messageId: { type: "string" },
		sessionId: { type: "string" },
		title: { type: "string" },
		state: { type: "string", enum: ["running", "idle", "stored", "agent"] },
		delivery: { type: "string", enum: ["steer", "queue"] }
	}
};

const listOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["total", "sessions"],
	properties: {
		workspace: { type: "string" },
		total: { type: "integer" },
		sessions: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["sessionId", "status", "updatedAt"],
				properties: {
					sessionId: { type: "string" },
					status: { type: "string", enum: ["running", "inactive"] },
					updatedAt: { type: "string" },
					title: { type: "string" },
					workspace: { type: "string" }
				}
			}
		}
	}
};

const createOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["sessionId", "workspace", "messageId"],
	properties: {
		sessionId: { type: "string" },
		title: { type: "string" },
		workspace: { type: "string" },
		messageId: { type: "string" }
	}
};

/** Register the tools and hide them from subagent sessions. */
export function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);

	ctx.tools.register({
		name: SEND_TOOL,
		description:
			"Send a message to another top-level session (a conversation in the session sidebar), such as one found with session_list. " +
			"A busy session reads it at its next step; an idle or stored session is resumed and starts a turn with it. " +
			"The recipient sees your session id and can answer with this tool. Returns delivery confirmation, not the answer; an answer arrives later as a new message.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["message"],
			properties: {
				session_id: {
					type: "string",
					description: "Id of the target top-level session, from session_list or from a message you received. Give either session_id or agent_id."
				},
				agent_id: {
					type: "string",
					description: "Id of a subagent (a child agent you started, or your direct parent). Only available when the Harness mounts the subagent service; Team members are reached with the built-in send_message instead."
				},
				message: {
					type: "string",
					description: "Self-contained message text; the recipient cannot see your conversation."
				},
				delivery: {
					type: "string",
					enum: ["steer", "queue"],
					description: "steer (default) delivers at the recipient's next step, even mid-turn; queue waits until its current turn ends."
				}
			}
		},
		output: {
			schema: sendOutputSchema,
			render: (_args, value) => [{ type: "text", text: renderSend(value) }]
		},
		presentCall: (args) => {
			const id = nonEmpty(args?.session_id);
			// Name a loaded target by its title; a stored one keeps its id.
			const session = id === undefined ? undefined : ctx.sessions.get(id);
			const title = session === undefined ? undefined : liveTitle(ctx, session);
			return {
				card: "generic",
				kind: "other",
				title: title !== undefined ? `Message session ${JSON.stringify(title)}` : `Message session ${id ?? ""}`.trim(),
				...(typeof args?.message === "string" ? { rawInput: args.message } : {})
			};
		},
		execute: (args, exec) => sendMessage(ctx, config, args, exec)
	});

	ctx.tools.register({
		name: LIST_TOOL,
		description:
			"List top-level sessions you can message with session_send_message, most recently active first, with id, status (running or inactive), and title.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: {
					type: "string",
					description: "Case-insensitive text to match against session titles and ids."
				},
				all_workspaces: {
					type: "boolean",
					description: "Include sessions from other workspaces; by default only sessions in this session's workspace are listed."
				},
				limit: {
					type: "integer",
					description: `Maximum sessions to return, from 1 to ${MAX_LIST_LIMIT}; defaults to ${config.listLimit}.`
				}
			}
		},
		output: {
			schema: listOutputSchema,
			render: (_args, value) => [{ type: "text", text: renderList(value) }]
		},
		isConcurrencySafe: () => true,
		presentCall: (args) => ({
			card: "generic",
			kind: "search",
			title: "List sessions",
			...(typeof args?.query === "string" && args.query.trim() !== "" ? { rawInput: args.query } : {})
		}),
		execute: (args, exec) => listSessions(ctx, config, args, exec)
	});

	const opened = new Map();
	ctx.tools.register({
		name: CREATE_TOOL,
		description:
			"Open a new top-level session (a new conversation in the session sidebar) and start it with a message. " +
			"The new session runs independently with default settings and reports back only if your message asks it to reply with session_send_message. " +
			"Returns the new session id.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["title", "message"],
			properties: {
				title: {
					type: "string",
					description: "Short title shown in the session sidebar."
				},
				message: {
					type: "string",
					description: "Self-contained first message; the new session cannot see your conversation."
				},
				workspace: {
					type: "string",
					description: "Absolute path of the workspace to open it in, as session_list shows it; defaults to this session's workspace."
				}
			}
		},
		output: {
			schema: createOutputSchema,
			render: (_args, value) => [{ type: "text", text: renderCreate(value) }]
		},
		presentCall: (args) => ({
			card: "generic",
			kind: "other",
			title: typeof args?.title === "string" && args.title.trim() !== "" ? `Open session ${JSON.stringify(args.title.trim())}` : "Open session",
			...(typeof args?.message === "string" ? { rawInput: args.message } : {})
		}),
		execute: (args, exec) => createSession(ctx, config, opened, args, exec)
	});

	// A subagent cannot be answered through this channel, so it does not see the tools. The
	// restriction lives on `agent.ctx` and in this plugin's effect, so either teardown lifts it.
	const lifts = new Map();
	const hide = (agent) => {
		if (lifts.has(agent) || !isSubagentHeader(agent?.session?.header)) return;
		try {
			lifts.set(agent, agent.ctx.tools.restrict({ deny: TOOL_NAMES }));
		} catch (error) {
			ctx.logger?.warn?.(`session-messaging: could not hide tools from subagent ${agent.id}: ${error?.message ?? error}`);
		}
	};
	ctx.on("agent/created", ({ agent }) => {
		hide(agent);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		lifts.delete(agent);
	});
	ctx.effect(() => {
		for (const agent of ctx.agents.list()) hide(agent);
		return () => {
			for (const lift of lifts.values()) {
				try {
					lift();
				} catch {}
			}
			lifts.clear();
		};
	}, "session-messaging: subagent tool restrictions");
}

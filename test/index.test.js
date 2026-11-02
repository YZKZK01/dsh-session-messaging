/**
 * Drives `apply()` through a mocked Harness context: tool registration, delivery to live, idle,
 * and stored sessions, every refusal path, listing filters, and the subagent tool restriction.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIST_TOOL, SEND_TOOL, TOOL_NAMES, apply, normalizeConfig, relayContent } from "../lib/index.js";

const WORKSPACE = "/work/main";

function makeAgent(id, { cwd = WORKSPACE, status = "idle", origin, title } = {}) {
	const agent = {
		id,
		status,
		received: [],
		restrictions: [],
		session: { id, header: { id, cwd, ...(origin === undefined ? {} : { origin }) }, title },
		steer(message) {
			this.received.push({ via: "steer", message });
		},
		followup(message) {
			this.received.push({ via: "followup", message });
		}
	};
	agent.ctx = {
		tools: {
			restrict(filter) {
				agent.restrictions.push(filter);
				return () => {
					agent.restrictions = agent.restrictions.filter((entry) => entry !== filter);
				};
			}
		}
	};
	return agent;
}

/** Minimal stand-in for the Harness services the plugin injects. */
function harness({ live = [], stored = [], summaries = [], archived = [], titles = {} } = {}) {
	const tools = new Map();
	const listeners = new Map();
	const disposers = [];
	const agents = new Map(live.map((agent) => [agent.id, agent]));
	const resumed = [];
	const flushed = [];
	const initiatorFree = [];
	let inWithout = false;
	const ctx = {
		logger: { warn() {} },
		get(name) {
			if (name === "sessionTitle") return { get: (session) => (session.title === undefined ? undefined : { title: session.title }) };
			if (name === "workspaceRegistry") return { archivedSessionIds: archived };
			return undefined;
		},
		effect(fn) {
			disposers.push(fn());
		},
		on(event, fn) {
			listeners.set(event, fn);
		},
		tools: { register: (definition) => tools.set(definition.name, definition) },
		agents: {
			get: (id) => agents.get(id),
			list: () => [...agents.values()],
			withoutInitiator(operation) {
				inWithout = true;
				try {
					return operation();
				} finally {
					inWithout = false;
				}
			}
		},
		sessions: {
			get: (id) => agents.get(id)?.session,
			flush: async (session) => {
				flushed.push(session.id);
				return true;
			}
		},
		sessionQuery: {
			filterSessions: async (filters) => {
				const ids = filters.find((filter) => filter.kind === "id")?.values ?? [];
				return stored.filter((header) => ids.includes(header.id)).map((header) => ({ header }));
			},
			readTitleSnapshots: async (ids) =>
				ids.map((sessionId) => ({
					sessionId,
					status: "fulfilled",
					value: { session: { id: sessionId }, ...(titles[sessionId] === undefined ? {} : { title: { title: titles[sessionId] } }) }
				}))
		},
		sessionController: {
			resolveAgent: async (id) => {
				initiatorFree.push(inWithout);
				const existing = agents.get(id);
				if (existing !== undefined) return { agent: existing };
				const header = stored.find((entry) => entry.id === id);
				if (header === undefined) return { error: { code: "session/not-found", message: `session "${id}" not found` } };
				const agent = makeAgent(id, { cwd: header.cwd, title: header.title });
				agents.set(id, agent);
				resumed.push(id);
				return { agent };
			},
			list: async () => ({ items: summaries })
		}
	};
	return { ctx, tools, listeners, disposers, agents, resumed, flushed, initiatorFree };
}

function exec(agent) {
	return { agent, signal: new AbortController().signal };
}

test("registers both tools with the supported schema subset", () => {
	const h = harness();
	apply(h.ctx, {});
	assert.deepEqual([...h.tools.keys()].sort(), [...TOOL_NAMES].sort());
	const allowed = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "title", "default", "examples"]);
	const walk = (node, path) => {
		for (const key of Object.keys(node)) assert.ok(allowed.has(key), `${path}.${key} is outside the supported subset`);
		for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.properties.${key}`);
		if (node.items) walk(node.items, `${path}.items`);
	};
	for (const tool of h.tools.values()) {
		walk(tool.parameters, `${tool.name}.parameters`);
		walk(tool.output.schema, `${tool.name}.output`);
	}
});

test("steers an attributed relay message into an idle live session", async () => {
	const sender = makeAgent("session-a", { title: "Sender work" });
	const target = makeAgent("session-b", { title: "Target work" });
	const h = harness({ live: [sender, target] });
	apply(h.ctx, {});
	const value = await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "Please rebase." }, exec(sender));
	assert.equal(value.sessionId, "session-b");
	assert.equal(value.state, "idle");
	assert.equal(value.delivery, "steer");
	assert.equal(value.title, "Target work");
	assert.equal(target.received.length, 1);
	const { via, message } = target.received[0];
	assert.equal(via, "steer");
	assert.equal(message.id, value.messageId);
	assert.equal(message.role, "user");
	assert.deepEqual(message.source, { kind: "agent-message", form: "relay", senderSessionId: "session-a" });
	assert.match(message.content[0].text, /^Message from session "session-a" \("Sender work"\)\. /);
	assert.match(message.content[0].text, /not by your user/);
	assert.match(message.content[0].text, /call session_send_message with session_id "session-a"/);
	assert.equal(message.content[1].text, "Please rebase.");
	assert.ok(Object.isFrozen(message) && Object.isFrozen(message.content[0]));
	assert.deepEqual(h.initiatorFree, [true]);
	assert.deepEqual(h.flushed, ["session-b"]);
	assert.match(h.tools.get(SEND_TOOL).output.render({}, value)[0].text, /was idle and is starting a turn/);
});

test("resumes a stored session and names the sender workspace when it differs", async () => {
	const sender = makeAgent("session-a");
	const h = harness({ live: [sender], stored: [{ id: "session-c", cwd: "/work/other" }] });
	apply(h.ctx, {});
	const value = await h.tools.get(SEND_TOOL).execute({ session_id: "session-c", message: "hi" }, exec(sender));
	assert.equal(value.state, "stored");
	assert.deepEqual(h.resumed, ["session-c"]);
	const message = h.agents.get("session-c").received[0].message;
	assert.match(message.content[0].text, /^Message from session "session-a" in workspace \/work\/main\. /);
	assert.match(h.tools.get(SEND_TOOL).output.render({}, value)[0].text, /resumed from storage/);
});

test("queue delivery uses followup for a running session", async () => {
	const sender = makeAgent("session-a");
	const target = makeAgent("session-b", { status: "running" });
	const h = harness({ live: [sender, target] });
	apply(h.ctx, {});
	const value = await h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "later", delivery: "queue" }, exec(sender));
	assert.equal(value.state, "running");
	assert.equal(target.received[0].via, "followup");
	assert.match(h.tools.get(SEND_TOOL).output.render({}, value)[0].text, /after the current one ends/);
});

test("refuses invalid senders, targets, and oversized messages without delivering", async () => {
	const sender = makeAgent("session-a");
	const child = makeAgent("session-child", { origin: "subagent" });
	const target = makeAgent("session-b");
	const h = harness({
		live: [sender, child, target],
		stored: [{ id: "session-arch", cwd: WORKSPACE }, { id: "session-far", cwd: "/elsewhere" }],
		archived: ["session-arch"]
	});
	apply(h.ctx, { maxMessageBytes: 300 });
	const send = (args, caller = sender) => h.tools.get(SEND_TOOL).execute(args, exec(caller));
	await assert.rejects(send({ session_id: "session-a", message: "x" }), /cannot message itself/);
	await assert.rejects(send({ session_id: "session-b", message: "   " }), /non-whitespace/);
	await assert.rejects(send({ session_id: "session-b", message: "x", delivery: "now" }), /delivery must be/);
	await assert.rejects(send({ session_id: "nope", message: "x" }), /was not found/);
	await assert.rejects(send({ session_id: "session-child", message: "x" }), /subagent session/);
	await assert.rejects(send({ session_id: "session-arch", message: "x" }), /archived/);
	await assert.rejects(send({ session_id: "session-b", message: "x".repeat(400) }), /exceeds the 300-byte limit/);
	await assert.rejects(send({ session_id: "session-b", message: "x" }, child), /only available to top-level sessions/);
	await assert.rejects(h.tools.get(SEND_TOOL).execute({ session_id: "session-b", message: "x" }, { signal: new AbortController().signal }), /requires a calling session/);
	assert.equal(target.received.length, 0);
	assert.deepEqual(h.resumed, []);

	const closed = harness({ live: [sender], stored: [{ id: "session-far", cwd: "/elsewhere" }] });
	apply(closed.ctx, { crossWorkspace: false });
	await assert.rejects(closed.tools.get(SEND_TOOL).execute({ session_id: "session-far", message: "x" }, exec(sender)), /crossWorkspace: false/);
	assert.deepEqual(closed.resumed, []);
});

test("reports a resolve failure as an undelivered message", async () => {
	const sender = makeAgent("session-a");
	const h = harness({ live: [sender], stored: [{ id: "session-x", cwd: WORKSPACE }] });
	h.ctx.sessionController.resolveAgent = async () => ({ error: { code: "session/writer-held", message: "writer held by another process" } });
	apply(h.ctx, {});
	await assert.rejects(h.tools.get(SEND_TOOL).execute({ session_id: "session-x", message: "x" }, exec(sender)), /message not delivered: writer held/);
});

test("lists messageable sessions in this workspace by default", async () => {
	const caller = makeAgent("session-a");
	const summaries = [
		{ sessionId: "session-a", updatedAt: 9, running: true, blank: false, cwd: WORKSPACE },
		{ sessionId: "session-run", updatedAt: 8, running: true, blank: false, cwd: WORKSPACE, projections: { values: { title: "Refactor auth" } } },
		{ sessionId: "session-blank", updatedAt: 7, running: false, blank: true, cwd: WORKSPACE },
		{ sessionId: "session-sub", updatedAt: 6, running: false, blank: false, cwd: WORKSPACE, origin: "subagent" },
		{ sessionId: "session-arch", updatedAt: 5, running: false, blank: false, cwd: WORKSPACE },
		{ sessionId: "session-far", updatedAt: 4, running: false, blank: false, cwd: "/elsewhere", projections: { values: { title: "Other repo" } } },
		{ sessionId: "session-cold", updatedAt: 3, running: false, blank: false, cwd: WORKSPACE }
	];
	const h = harness({ live: [caller], summaries, archived: ["session-arch"], titles: { "session-cold": "Write docs" } });
	apply(h.ctx, {});
	const list = (args) => h.tools.get(LIST_TOOL).execute(args, exec(caller));

	const local = await list({});
	assert.equal(local.workspace, WORKSPACE);
	assert.deepEqual(local.sessions.map((row) => [row.sessionId, row.status, row.title]), [
		["session-run", "running", "Refactor auth"],
		["session-cold", "inactive", "Write docs"]
	]);
	assert.ok(local.sessions.every((row) => row.workspace === undefined));
	const text = h.tools.get(LIST_TOOL).output.render({}, local)[0].text;
	assert.match(text, /^Sessions in workspace \/work\/main, most recently active first \(2 of 2; this session excluded\):/);
	assert.match(text, /- session-run \[running\] "Refactor auth" \| active /);

	const everywhere = await list({ all_workspaces: true, limit: 2 });
	assert.equal(everywhere.workspace, undefined);
	assert.equal(everywhere.total, 3);
	assert.deepEqual(everywhere.sessions.map((row) => [row.sessionId, row.workspace]), [
		["session-run", WORKSPACE],
		["session-far", "/elsewhere"]
	]);

	const byReadTitle = await list({ query: "DOCS" });
	assert.deepEqual(byReadTitle.sessions.map((row) => [row.sessionId, row.title]), [["session-cold", "Write docs"]]);
	const byTitleHint = await list({ query: "auth" });
	assert.deepEqual(byTitleHint.sessions.map((row) => row.sessionId), ["session-run"]);
	const byId = await list({ query: "SESSION-COLD" });
	assert.deepEqual(byId.sessions.map((row) => row.sessionId), ["session-cold"]);

	const none = harness({ live: [caller], summaries: [summaries[0]] });
	apply(none.ctx, {});
	const empty = await none.tools.get(LIST_TOOL).execute({}, exec(caller));
	assert.match(none.tools.get(LIST_TOOL).output.render({}, empty)[0].text, /Set all_workspaces to true/);

	const closed = harness({ live: [caller], summaries });
	apply(closed.ctx, { crossWorkspace: false });
	await assert.rejects(closed.tools.get(LIST_TOOL).execute({ all_workspaces: true }, exec(caller)), /crossWorkspace: false/);
});

test("hides both tools from subagents, including ones live before activation", () => {
	const early = makeAgent("session-early-child", { origin: "subagent" });
	const root = makeAgent("session-root");
	const h = harness({ live: [early, root] });
	apply(h.ctx, {});
	assert.deepEqual(early.restrictions, [{ deny: TOOL_NAMES }]);
	assert.deepEqual(root.restrictions, []);

	const late = makeAgent("session-late-child", { origin: "subagent" });
	h.listeners.get("agent/created")({ agent: late });
	h.listeners.get("agent/created")({ agent: makeAgent("session-root-2") });
	assert.deepEqual(late.restrictions, [{ deny: TOOL_NAMES }]);

	for (const dispose of h.disposers) dispose?.();
	assert.deepEqual(early.restrictions, []);
	assert.deepEqual(late.restrictions, []);
});

test("normalizes config and builds attribution text", () => {
	assert.deepEqual(normalizeConfig(undefined), { crossWorkspace: true, maxMessageBytes: 65536, listLimit: 20 });
	assert.deepEqual(normalizeConfig({ crossWorkspace: false, maxMessageBytes: -1, listLimit: 500 }), {
		crossWorkspace: false,
		maxMessageBytes: 65536,
		listLimit: 100
	});
	const [head, body] = relayContent({ id: 'say "hi"', title: 'a "b"' }, "text");
	assert.equal(head.text.startsWith('Message from session "say \\"hi\\"" ("a \\"b\\""). '), true);
	assert.equal(body.text, "text");
});

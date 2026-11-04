/**
 * Loads the browser module through a stub loader and checks that its parser recognizes exactly the
 * attribution `relayContent` writes, so a change to either side fails here instead of showing the
 * attribution line in the bubble.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { relayContent } from "../lib/index.js";

const reactStub = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useMemo: (compute) => compute()
};
let loadedId;
let plugin;
globalThis.window = {
	__ModuleLoader__: {
		load: ({ id, factory }) => {
			loadedId = id;
			plugin = factory(() => reactStub);
		}
	}
};
await import("../lib/client.js");
const { parseRelay } = plugin;

test("client module id and cordis.patch.yml name stay in sync with package.json name", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
	assert.equal(loadedId, pkg.name);
	assert.match(patch, new RegExp(`name:\\s*['"]?${pkg.name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}['"]?`));
});

/** The renderer `apply` registers, beside a shipped entry for the same key. */
function registeredRenderer(shipped) {
	const registered = [];
	const slots = {
		inject: (_owner, install) => install(),
		register: (options, component) => registered.push({ options, component }),
		entries: () => [...registered, { options: { key: "turn-trigger", priority: 0 }, component: shipped }]
	};
	plugin.apply({ slots, effect() {}, locale: { bind: () => (key) => key } });
	assert.equal(registered.length, 1);
	assert.equal(registered[0].options.key, "turn-trigger");
	assert.equal(registered[0].options.priority, -10);
	return registered[0].component;
}

const relaySource = { kind: "agent-message", form: "relay", senderSessionId: "session-a" };

test("a relayed message splits into sender title and the sender's text", () => {
	const content = relayContent({ id: "session-a", title: 'Plan "B" (draft)' }, "Hello.\n\nSecond paragraph.");
	const relay = parseRelay({ source: relaySource, content });
	assert.equal(relay.senderId, "session-a");
	assert.equal(relay.title, 'Plan "B" (draft)');
	assert.deepEqual(relay.content, [{ type: "text", text: "Hello.\n\nSecond paragraph." }]);
});

test("an untitled sender and a sender in another workspace still parse", () => {
	const untitled = parseRelay({ source: relaySource, content: relayContent({ id: "session-a" }, "Hi") });
	assert.equal(untitled.title, undefined);
	const elsewhere = parseRelay({ source: relaySource, content: relayContent({ id: "session-a", title: "T", workspace: "/work/other" }, "Hi") });
	assert.equal(elsewhere.title, "T");
	assert.deepEqual(elsewhere.content, [{ type: "text", text: "Hi" }]);
});

test("attribution and text merged into one block still separate", () => {
	const [attribution, body] = relayContent({ id: "session-a" }, "Hi");
	const relay = parseRelay({ source: relaySource, content: [{ type: "text", text: attribution.text + body.text }] });
	assert.deepEqual(relay.content, [{ type: "text", text: "Hi" }]);
});

test("the registered renderer hands a non-relay trigger to the shipped one with the same props", () => {
	const Shipped = () => null;
	const Renderer = registeredRenderer(Shipped);
	const props = { node: { data: { source: { kind: "goal" }, content: [{ type: "text", text: "Keep going" }] } } };
	const element = Renderer(props);
	assert.equal(element.type, Shipped);
	assert.equal(element.props, props);
});

test("the registered renderer does not use the shipped card for a relayed message", () => {
	const Shipped = () => null;
	const Renderer = registeredRenderer(Shipped);
	const element = Renderer({ node: { data: { source: relaySource, content: relayContent({ id: "session-a", title: "T" }, "Hi"), time: 1 } } });
	assert.notEqual(element.type, Shipped);
	assert.equal(element.props.relay.title, "T");
});

test("other triggers are left to the shipped renderer", () => {
	const content = [{ type: "text", text: "Some subagent report" }];
	assert.equal(parseRelay({ source: relaySource, content }), undefined);
	assert.equal(parseRelay({ source: { kind: "goal" }, content }), undefined);
	const relayed = relayContent({ id: "session-a" }, "Hi");
	assert.equal(parseRelay({ source: { kind: "schedule" }, content: relayed }), undefined);
	assert.equal(parseRelay({ source: { kind: "agent-message", form: "relay" }, content: relayed }), undefined);
});

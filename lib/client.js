/**
 * Client half of `dsh-session-messaging`: shows a relayed message as a user-style bubble.
 *
 * A message that wakes a session and has a non-user source is a `turn-trigger` Chat node, which
 * ships as a collapsed notice card. This renderer shadows that key for messages this plugin
 * relayed and draws the shipped `conversation.chat.user.content` bubble under a marker naming the
 * sender session. Every other trigger (goals, schedules, subagents, webhooks) goes to the shipped
 * renderer unchanged. Only the view changes: the model still receives the attribution line.
 */
window.__ModuleLoader__.load({
	id: "@you/dsh-session-messaging",
	factory(require) {
		const React = require("react");
		const h = React.createElement;
		const NS = "sessionMessaging";
		const NODE_SLOT = "conversation.chat.node";
		const TRIGGER_KEY = "turn-trigger";
		const STYLE_ID = "dsh-session-messaging-style";

		const css = [
			".dsm-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px}",
			".dsm-marker{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta,0px))}",
			".dsm-marker svg{flex:none;width:14px;height:14px}",
			".dsm-marker span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsm-actions{display:flex;align-items:center;gap:8px;height:calc(28px + var(--dsh-content-font-delta,0px))}",
			".dsm-time{padding-right:4px;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);white-space:nowrap}",
			".dsm-copy{display:inline-flex;align-items:center;justify-content:center;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
			".dsm-copy:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}"
		].join("");

		const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"';
		// The attribution `relayContent` in index.js writes; test/client.test.js keeps the two in step.
		const ATTRIBUTION = new RegExp(
			`^Message from session (${JSON_STRING})(?: \\((${JSON_STRING})\\))?(?: in workspace .*?)?\\. ` +
				"It was written by that session's agent, not by your user\\. " +
				"To answer, call session_send_message with session_id " +
				`${JSON_STRING}; do not reply only to acknowledge it\\.\\s*`
		);

		/**
		 * Split a relayed message into its sender and the sender's own content.
		 * @param data - `turn-trigger` node data.
		 * @returns the sender and display content, or undefined for any other trigger.
		 */
		function parseRelay(data) {
			const source = data?.source;
			if (source?.kind !== "agent-message" || source.form !== "relay" || typeof source.senderSessionId !== "string") return undefined;
			const content = Array.isArray(data.content) ? data.content : [];
			const first = content[0];
			if (first?.type !== "text" || typeof first.text !== "string") return undefined;
			const match = ATTRIBUTION.exec(first.text);
			if (match === null) return undefined;
			const remainder = first.text.slice(match[0].length);
			return {
				senderId: source.senderSessionId,
				...(match[2] === undefined ? {} : { title: JSON.parse(match[2]) }),
				content: remainder === "" ? content.slice(1) : [{ ...first, text: remainder }, ...content.slice(1)]
			};
		}

		/** Bubble content as the shipped user-content Factory expects it. */
		function prepareContent(content) {
			const parts = { text: "", attachments: [], extraBlocks: [] };
			for (const block of content) {
				if (block.type === "text" && typeof block.text === "string") parts.text += block.text;
				else if (block.type === "image" && block.attachment !== undefined) parts.attachments.push({ type: "image", image: { attachment: block.attachment } });
				else if (block.type === "file" && block.attachment !== undefined) parts.attachments.push({ type: "file", file: block.attachment });
				else parts.extraBlocks.push(block);
			}
			return parts;
		}

		function formatClock(time, t) {
			const date = new Date(time);
			const now = new Date();
			const pad = (value) => String(value).padStart(2, "0");
			const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
			if (date.toDateString() === now.toDateString()) return clock;
			const params = { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
			return `${t(date.getFullYear() === now.getFullYear() ? "clock.md" : "clock.ymd", params)} ${clock}`;
		}

		const icon = (children, size) =>
			h("svg", { viewBox: "0 0 16 16", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, children);
		const sentIcon = () => icon(h("path", { d: "M14 2 7 9M14 2l-4.5 12L7 9 2 6.5 14 2Z" }));
		const copyIcon = () =>
			icon([h("rect", { key: "a", x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.6 }), h("path", { key: "b", d: "M10.5 5.5V3.6c0-.9-.7-1.6-1.6-1.6H3.6C2.7 2 2 2.7 2 3.6v5.3c0 .9.7 1.6 1.6 1.6h1.9" })], 16);
		const checkIcon = () => icon(h("path", { d: "M3 8.5 6.5 12 13 4.5" }), 16);

		function RelayBubble({ relay, time, renderFactorySlot, loadImage, t, label }) {
			const [copied, setCopied] = React.useState(false);
			const prepared = React.useMemo(() => prepareContent(relay.content), [relay.content]);
			React.useEffect(() => {
				if (!copied) return undefined;
				const timer = setTimeout(() => setCopied(false), 1000);
				return () => clearTimeout(timer);
			}, [copied]);
			const onCopy = () => {
				navigator.clipboard?.writeText(prepared.text).then(() => setCopied(true), () => {});
			};
			return h(
				"div",
				{ className: "dsm-row", "data-session-message-sender": relay.senderId },
				h("div", { className: "dsm-marker", title: relay.senderId }, sentIcon(), h("span", null, label(relay.title))),
				renderFactorySlot("conversation.chat.user.content", { content: prepared, loadImage, facts: {}, interactive: true }),
				h(
					"div",
					{ className: "dsm-actions" },
					time === undefined ? null : h("time", { className: "dsm-time", dateTime: new Date(time).toISOString() }, formatClock(time, t)),
					h("button", { type: "button", className: "dsm-copy", title: copied ? t("copied") : t("copy"), "aria-label": copied ? t("copied") : t("copy"), onClick: onCopy }, copied ? checkIcon() : copyIcon())
				)
			);
		}

		return {
			parseRelay,
			inject: ["slots", "locale"],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, "zh", { from: "来自会话「{title}」", fromUntitled: "来自另一个会话" }));
				ctx.effect(() => ctx.locale.register(NS, "en", { from: "From session “{title}”", fromUntitled: "From another session" }));
				ctx.effect(() => {
					const style = document.createElement("style");
					style.id = STYLE_ID;
					style.textContent = css;
					document.head.appendChild(style);
					return () => style.remove();
				}, "session-messaging: bubble styles");

				const own = ctx.locale.bind(NS);
				const label = (title) => (title === undefined ? own("fromUntitled") : own("from", { title }));
				const shippedRenderer = (self) => {
					let best;
					for (const entry of ctx.slots.entries(NODE_SLOT)) {
						if (entry.options.key !== TRIGGER_KEY || entry.component === self) continue;
						if (best === undefined || (entry.options.priority ?? 0) < (best.options.priority ?? 0)) best = entry;
					}
					return best;
				};
				function SessionMessageTriggerView(props) {
					const { node, renderFactorySlot, loadImage, t } = props;
					const relay = React.useMemo(() => parseRelay(node.data), [node.data]);
					if (relay === undefined) {
						const shipped = shippedRenderer(SessionMessageTriggerView);
						return shipped === undefined ? null : h(shipped.component, props);
					}
					return h(RelayBubble, { relay, time: node.data.time, renderFactorySlot, loadImage, t, label });
				}
				ctx.slots.inject(NODE_SLOT, () =>
					ctx.slots.register(
						{
							name: NODE_SLOT,
							key: TRIGGER_KEY,
							locale: "chat",
							// Lower wins; the shipped renderer uses 0.
							priority: -10
						},
						SessionMessageTriggerView
					)
				);
			}
		};
	}
});

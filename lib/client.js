// dsh-quote-cards — browser half, hand-written in the dsh client-bundle format.
//
// The plugin turns quoting into a small, visible collection instead of dumping
// raw "> …" text into the composer:
//   1. hover an assistant reply → its action row gets a 引用 / Quote button;
//   2. select any text inside the chat → a floating 引用 button appears;
//   3. every pick becomes a removable card in a dock above the composer;
//   4. pressing Enter or the Send button merges the cards, plus whatever the
//      user typed, into one attributed blockquote and submits it.
window.__ModuleLoader__.load({
	id: "dsh-quote-cards",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		let primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (_error) {
			primitives = null;
		}

		const NS = "dshQuote";
		const MAX_QUOTES = 8;
		const MAX_CARD_CHARS = 280;
		const MAX_QUOTE_CHARS = 8000;

		const zh = {
			"action.quote": "引用",
			"action.quoteWhole": "引用这条回复",
			"action.quoteSelection": "引用卡片",
			"dock.title": "引用回复（{count}）",
			"dock.clear": "清空",
			"dock.remove": "移除这条引用",
			"dock.assistant": "助手",
			"dock.selection": "选中文字",
			"dock.replyPlaceholder": "回复这条引用…",
			"dock.prefill": "放入输入框",
			"dock.send": "发送引用回复（{count}）",
			"compose.assistant": "引用 · 助手{time}",
			"compose.selection": "引用 · 选中文字"
		};
		const en = {
			"action.quote": "Quote",
			"action.quoteWhole": "Quote this reply",
			"action.quoteSelection": "Quote card",
			"dock.title": "Quoted · {count}",
			"dock.clear": "Clear",
			"dock.remove": "Remove this quote",
			"dock.assistant": "Assistant",
			"dock.selection": "Selection",
			"dock.replyPlaceholder": "Reply to this quote…",
			"dock.prefill": "Insert into composer",
			"dock.send": "Send quoted replies ({count})",
			"compose.assistant": "Quoted · Assistant{time}",
			"compose.selection": "Quoted · Selection"
		};

		// ── per-session quote store ──────────────────────────────────────────

		const buckets = new Map();
		const listeners = new Set();
		let quoteSeq = 0;

		function bucketOf(sessionId) {
			let bucket = buckets.get(sessionId);
			if (bucket === void 0) {
				bucket = { items: [], revision: 0 };
				buckets.set(sessionId, bucket);
			}
			return bucket;
		}

		const EMPTY_ITEMS = Object.freeze([]);

		function quoteItems(sessionId) {
			if (sessionId === void 0 || sessionId === null) return EMPTY_ITEMS;
			return bucketOf(sessionId).items;
		}

		function subscribeQuotes(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}

		function emitQuotes() {
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch (_error) {}
			}
		}

		function addQuote(sessionId, input) {
			if (sessionId === void 0 || sessionId === null) return false;
			const text = String(input.text ?? "").replace(/\u0000/g, "").trim();
			if (text === "") return false;
			const bucket = bucketOf(sessionId);
			const key = input.role + "\u0000" + (input.messageId ?? "") + "\u0000" + text;
			for (const item of bucket.items) {
				if (item.key === key) return false;
			}
			if (bucket.items.length >= MAX_QUOTES) return false;
			const cropped = text.length > MAX_QUOTE_CHARS ? text.slice(0, MAX_QUOTE_CHARS) + "…" : text;
			quoteSeq += 1;
			const item = {
				id: "q" + quoteSeq,
				key,
				role: input.role,
				messageId: input.messageId,
				time: input.time ?? null,
				text: cropped,
				reply: "",
				createdAt: Date.now()
			};
			bucket.items = [...bucket.items, item];
			bucket.revision += 1;
			emitQuotes();
			return true;
		}

		function removeQuote(sessionId, id) {
			const bucket = buckets.get(sessionId);
			if (bucket === void 0) return;
			const next = bucket.items.filter((item) => item.id !== id);
			if (next.length === bucket.items.length) return;
			bucket.items = next;
			bucket.revision += 1;
			emitQuotes();
		}

		function setQuoteReply(sessionId, id, reply) {
			const bucket = buckets.get(sessionId);
			if (bucket === void 0) return;
			let changed = false;
			const next = bucket.items.map((item) => {
				if (item.id !== id || item.reply === reply) return item;
				changed = true;
				return { ...item, reply };
			});
			if (!changed) return;
			bucket.items = next;
			bucket.revision += 1;
			emitQuotes();
		}

		function clearQuotes(sessionId) {
			const bucket = buckets.get(sessionId);
			if (bucket === void 0 || bucket.items.length === 0) return;
			bucket.items = [];
			bucket.revision += 1;
			emitQuotes();
		}

		// ── text helpers ─────────────────────────────────────────────────────

		function textOfBlocks(blocks) {
			let out = "";
			for (const block of blocks ?? []) {
				if (block?.kind === "text" && typeof block.text === "string") out += block.text;
			}
			return out;
		}

		function formatClock(value) {
			if (value === void 0 || value === null || value === "") return "";
			const date = value instanceof Date ? value : new Date(value);
			if (Number.isNaN(date.getTime())) return "";
			const hh = String(date.getHours()).padStart(2, "0");
			const mm = String(date.getMinutes()).padStart(2, "0");
			return hh + ":" + mm;
		}

		function clockSuffix(time) {
			const clock = formatClock(time);
			return clock === "" ? "" : " · " + clock;
		}

		function excerpt(text) {
			const flat = text.replace(/\s+/g, " ").trim();
			return flat.length > MAX_CARD_CHARS ? flat.slice(0, MAX_CARD_CHARS) + "…" : flat;
		}

		function toBlockquote(text) {
			return text
				.split(/\r?\n/)
				.map((line) => (line === "" ? ">" : "> " + line))
				.join("\n");
		}

		/** Merge each quote with its own reply, then append the composer draft. */
		function composeDraft(items, draft, t) {
			const blocks = items.map((item) => {
				const header = item.role === "assistant"
					? t("compose.assistant", { time: clockSuffix(item.time) })
					: t("compose.selection");
				const quote = "> **" + header + "**\n" + toBlockquote(item.text);
				const reply = String(item.reply ?? "").replace(/\s+$/, "");
				return reply.trim() === "" ? quote : quote + "\n\n" + reply;
			});
			const body = String(draft ?? "").replace(/\s+$/, "");
			if (blocks.length === 0) return body;
			const quoted = blocks.join("\n\n");
			return body.trim() === "" ? quoted : quoted + "\n\n" + body;
		}

		/**
		 * Build the semantic draft the composer restores as native quote nodes.
		 * Each quote becomes a QuoteNode preview instead of literal "> ..." text.
		 */
		function buildPrefillDraft(items, draft, formatQuoteText) {
			if (typeof formatQuoteText !== "function") return null;
			let text = "";
			const quotes = [];
			for (const item of items) {
				const formatted = formatQuoteText(item.text);
				if (text !== "") text += "\n\n";
				const offset = text.length;
				text += formatted;
				quotes.push({ offset, length: formatted.length, text: item.text });
				const reply = String(item.reply ?? "").replace(/\s+$/, "");
				if (reply !== "") text += "\n\n" + reply;
			}
			const body = String(draft ?? "").replace(/\s+$/, "");
			if (body.trim() !== "") text += (text === "" ? "" : "\n\n") + body;
			return { text, references: [], quotes };
		}

		function useStoreSelector(subscribe, getSnapshot) {
			if (typeof react.useSyncExternalStore === "function") {
				return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
			}
			const [value, setValue] = react.useState(getSnapshot);
			react.useEffect(() => subscribe(() => setValue(getSnapshot())), [subscribe, getSnapshot]);
			return value;
		}

		// ── icons ────────────────────────────────────────────────────────────

		function QuoteIcon({ size = 15 }) {
			return react.createElement(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "currentColor",
					"aria-hidden": true
				},
				react.createElement("path", {
					d: "M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"
				}),
				react.createElement("path", {
					d: "M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"
				})
			);
		}

		function CloseIcon() {
			return react.createElement(
				"svg",
				{ width: 12, height: 12, viewBox: "0 0 12 12", fill: "none", "aria-hidden": true },
				react.createElement("path", {
					d: "M2.5 2.5l7 7M9.5 2.5l-7 7",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinecap: "round"
				})
			);
		}

		// ── floating selection button ────────────────────────────────────────

		let activeComposer = null; // set by the mounted dock
		let toolbar = null;
		let pendingSelection = "";
		let hideTimer = 0;

		function ensureToolbar(t) {
			if (toolbar !== null) return toolbar;
			const button = document.createElement("button");
			button.type = "button";
			button.className = "dsh-quote-float";
			button.setAttribute("aria-label", t("action.quoteSelection"));
			button.setAttribute("title", t("action.quoteSelection"));
			button.appendChild(iconNode());
			button.addEventListener("mousedown", (event) => event.preventDefault());
			button.addEventListener("click", () => {
				const text = pendingSelection;
				const composer = activeComposer;
				hideToolbar();
				clearSelection();
				if (text === "" || composer === null) return;
				if (addQuote(composer.sessionId, { role: "selection", text })) focusComposer();
			});
			document.body.appendChild(button);
			toolbar = button;
			return button;
		}

		function iconNode() {
			const holder = document.createElement("span");
			holder.className = "dsh-quote-float-icon";
			holder.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>';
			return holder;
		}

		function hideToolbar() {
			pendingSelection = "";
			if (toolbar !== null) toolbar.style.display = "none";
			if (hideTimer !== 0) {
				clearTimeout(hideTimer);
				hideTimer = 0;
			}
		}

		function placeToolbar(button, rect) {
			const vw = window.innerWidth || 0;
			const vh = window.innerHeight || 0;
			const w = button.offsetWidth || 30;
			const h = button.offsetHeight || 30;
			const candidates = [
				{ x: rect.right + 8, y: rect.top - 2 },
				{ x: rect.left - w - 8, y: rect.top - 2 },
				{ x: rect.left + (rect.width - w) / 2, y: rect.top - h - 8 },
				{ x: rect.left + (rect.width - w) / 2, y: rect.bottom + 8 }
			];
			for (const spot of candidates) {
				const x = Math.max(6, Math.min(spot.x, vw - w - 6));
				const y = Math.max(6, Math.min(spot.y, vh - h - 6));
				button.style.left = x + "px";
				button.style.top = y + "px";
				if (x === spot.x && y === spot.y) return;
			}
		}

		function clearSelection() {
			try {
				window.getSelection?.()?.removeAllRanges();
			} catch (_error) {}
			hideToolbar();
		}

		function onSelectionChange() {
			if (hideTimer !== 0) {
				clearTimeout(hideTimer);
				hideTimer = 0;
			}
			hideTimer = setTimeout(inspectSelection, 40);
		}

		function inspectSelection() {
			hideTimer = 0;
			const composer = activeComposer;
			if (composer === null || typeof document === "undefined") {
				hideToolbar();
				return;
			}
			const selection = window.getSelection ? window.getSelection() : null;
			if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
				hideToolbar();
				return;
			}
			const text = String(selection).trim();
			if (text === "") {
				hideToolbar();
				return;
			}
			const range = selection.getRangeAt(0);
			const anchor = range?.commonAncestorContainer;
			const element = anchor?.nodeType === 3 ? anchor.parentElement : anchor;
			const inside = element !== null && element !== void 0 && typeof element.closest === "function" &&
				element.closest("[data-chat-flow], [data-conversation-scroll]") !== null;
			if (!inside) {
				hideToolbar();
				return;
			}
			const bounds = range.getBoundingClientRect();
			if (bounds.width === 0 && bounds.height === 0) {
				hideToolbar();
				return;
			}
			pendingSelection = text;
			const button = ensureToolbar(composer.t);
			button.style.display = "inline-flex";
			placeToolbar(button, bounds);
		}

		function focusComposer() {
			if (typeof document === "undefined") return;
			const card = document.querySelector("[data-composer-card]");
			const target = card?.querySelector('[contenteditable="true"]');
			if (target === null || target === void 0) return;
			target.focus();
			setTimeout(() => {
				try {
					const selection = window.getSelection?.();
					if (selection === null || selection === void 0) return;
					const range = document.createRange();
					range.selectNodeContents(target);
					range.collapse(false);
					selection.removeAllRanges();
					selection.addRange(range);
				} catch (_error) {}
			}, 0);
		}

		// ── submit interception ──────────────────────────────────────────────

		function isSendButton(button) {
			if (!(button instanceof Element)) return false;
			if (button.disabled) return false;
			const classes = String(button.className ?? "");
			if (!/(^|_)primary(\s|$)/.test(classes)) return false;
			return button.querySelector('path[d^="M8.3125"]') !== null;
		}

		function hasAnyQuoteReply(items) {
			return items.some((item) => String(item.reply ?? "").trim() !== "");
		}

		function canSubmitWithQuotes() {
			const composer = activeComposer;
			if (composer === null) return false;
			const items = quoteItems(composer.sessionId);
			if (items.length === 0) return false;
			if (composer.phase !== "plain") return false;
			if (String(composer.draftRef.current ?? "").trim() === "" && !hasAnyQuoteReply(items)) return false;
			return true;
		}

		function submitWithQuotes() {
			const composer = activeComposer;
			if (composer === null) return false;
			const items = quoteItems(composer.sessionId);
			const draft = composer.draftRef.current;
			if (items.length === 0) return false;
			if (String(draft ?? "").trim() === "" && !hasAnyQuoteReply(items)) return false;
			const composed = composeDraft(items, draft, composer.t);
			try {
				composer.inputActions.setDraft(composed);
				clearQuotes(composer.sessionId);
				composer.inputActions.submit();
				return true;
			} catch (error) {
				console.error("[dsh-quote-cards] submit failed", error);
				return false;
			}
		}

		/** Compose cards into the composer without sending; lets the user draft while busy. */
		function prefillWithQuotes() {
			const composer = activeComposer;
			if (composer === null) return false;
			if (composer.phase !== "plain") return false;
			const items = quoteItems(composer.sessionId);
			if (items.length === 0) return false;
			const draft = composer.draftRef.current;
			const snapshot = buildPrefillDraft(items, draft, primitives?.formatQuoteText);
			const input = snapshot ?? composeDraft(items, draft, composer.t);
			try {
				composer.inputActions.setDraft(input);
				clearQuotes(composer.sessionId);
				focusComposer();
				return true;
			} catch (error) {
				console.error("[dsh-quote-cards] prefill failed", error);
				return false;
			}
		}

		function onKeyDownCapture(event) {
			if (!canSubmitWithQuotes()) return;
			if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
			if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
			const target = event.target;
			if (!(target instanceof Element) || target.closest("[data-composer-input]") === null) return;
			if (document.querySelector("[data-trigger-menu]") !== null) return;
			const root = target.closest("[data-composer-input]");
			if (root !== null && root.hasAttribute("data-composer-chip-selected")) return;
			event.preventDefault();
			event.stopPropagation();
			submitWithQuotes();
		}

		const NATIVE_QUOTE_LABELS = new Set(["引用文本", "Quote text"]);

		/** If the built-in quote pill survived the slot replacement, route it to a card. */
		function interceptNativeQuote(event) {
			const composer = activeComposer;
			if (composer === null) return false;
			const target = event.target;
			if (!(target instanceof Element)) return false;
			const button = target.closest("button");
			if (button === null || button.classList.contains("dsh-quote-selection")) return false;
			const label = String(button.textContent ?? "").trim();
			if (!NATIVE_QUOTE_LABELS.has(label)) return false;
			const text = String(window.getSelection?.() ?? "").trim();
			if (text === "") return false;
			event.preventDefault();
			event.stopPropagation();
			addQuote(composer.sessionId, { role: "selection", text });
			try {
				window.getSelection?.()?.removeAllRanges();
			} catch (_error) {}
			focusComposer();
			return true;
		}

		function onClickCapture(event) {
			if (interceptNativeQuote(event)) return;
			if (!canSubmitWithQuotes()) return;
			const target = event.target;
			if (!(target instanceof Element)) return;
			const button = target.closest("button");
			if (button === null || !isSendButton(button)) return;
			if (button.closest("[data-composer-card]") === null) return;
			event.preventDefault();
			event.stopPropagation();
			submitWithQuotes();
		}

		// ── components ───────────────────────────────────────────────────────

		function QuoteCard({ item, sessionId, t }) {
			const inputRef = react.useRef(null);
			react.useEffect(() => {
				const node = inputRef.current;
				if (node === null) return;
				node.style.height = "auto";
				node.style.height = Math.min(node.scrollHeight, 120) + "px";
			}, [item.reply]);
			return react.createElement(
				"article",
				{ className: "dsh-quote-card", "data-role": item.role },
				react.createElement(
					"div",
					{ className: "dsh-quote-card-meta" },
					react.createElement("span", { className: "dsh-quote-role" }, item.role === "assistant" ? t("dock.assistant") : t("dock.selection")),
					item.time !== null && formatClock(item.time) !== ""
						? react.createElement("span", { className: "dsh-quote-clock" }, formatClock(item.time))
						: null,
					react.createElement(
						"button",
						{
							type: "button",
							className: "dsh-quote-remove",
							title: t("dock.remove"),
							"aria-label": t("dock.remove"),
							onMouseDown: (event) => event.preventDefault(),
							onClick: () => removeQuote(sessionId, item.id)
						},
						react.createElement(CloseIcon)
					)
				),
				react.createElement("p", { className: "dsh-quote-card-text" }, excerpt(item.text)),
				react.createElement("textarea", {
					ref: inputRef,
					className: "dsh-quote-reply",
					rows: 1,
					value: item.reply,
					placeholder: t("dock.replyPlaceholder"),
					"aria-label": t("dock.replyPlaceholder"),
					onChange: (event) => setQuoteReply(sessionId, item.id, event.target.value)
				})
			);
		}

		function QuoteSelectionButton({ dismiss, readText, clearSelection, sessionId, t, useSession }) {
			const enabled = useSession((session) => !session.removed && (session.subagent === null || session.subagent.address.mode === "continuable"));
			react.useEffect(() => {
				if (!enabled) dismiss();
			}, [enabled, dismiss]);
			if (!enabled) return null;
			return react.createElement(
				"button",
				{
					type: "button",
					className: "dsh-quote-selection",
					"aria-label": t("action.quoteSelection"),
					onPointerDown: (event) => event.preventDefault(),
					onClick: () => {
						const text = readText();
						if (text === null) {
							dismiss();
							return;
						}
						addQuote(sessionId, { role: "selection", text });
						clearSelection();
						dismiss();
						focusComposer();
					}
				},
				t("action.quoteSelection")
			);
		}

		function QuoteDock({ sessionId, t, useInput, inputActions }) {
			const items = useStoreSelector(subscribeQuotes, () => quoteItems(sessionId));
			const draft = useInput((state) => state.draft);
			const phase = useInput((state) => state.phase);
			const draftRef = react.useRef(draft);
			const phaseRef = react.useRef(phase);
			draftRef.current = draft;
			phaseRef.current = phase;

			react.useEffect(() => {
				const previous = activeComposer;
				activeComposer = {
					sessionId,
					inputActions,
					t,
					draftRef,
					phase: phaseRef.current ?? "plain"
				};
				toolbar?.setAttribute("title", t("action.quoteSelection"));
				toolbar?.setAttribute("aria-label", t("action.quoteSelection"));
				return () => {
					if (activeComposer !== null && activeComposer.sessionId === sessionId) activeComposer = previous;
					hideToolbar();
				};
			}, [sessionId, inputActions, t]);

			react.useEffect(() => {
				if (activeComposer !== null && activeComposer.sessionId === sessionId) {
					activeComposer.draftRef = draftRef;
					activeComposer.phase = phase;
				}
			}, [sessionId, phase]);

			if (items.length === 0) return null;
			const replyCount = items.filter((item) => String(item.reply ?? "").trim() !== "").length;
			const canSend = phase === "plain" && (replyCount > 0 || String(draft ?? "").trim() !== "");
			const canPrefill = phase === "plain" && items.length > 0;

			return react.createElement(
				"section",
				{ className: "dsh-quote-dock", "data-dsh-quote-dock": true, "aria-label": t("dock.title", { count: items.length }) },
				react.createElement(
					"div",
					{ className: "dsh-quote-dock-head" },
					react.createElement("span", { className: "dsh-quote-dock-title" }, t("dock.title", { count: items.length })),
					react.createElement(
						"button",
						{
							type: "button",
							className: "dsh-quote-clear",
							onMouseDown: (event) => event.preventDefault(),
							onClick: () => clearQuotes(sessionId)
						},
						t("dock.clear")
					)
				),
				react.createElement(
					"div",
					{ className: "dsh-quote-list" },
					items.map((item) => react.createElement(QuoteCard, { key: item.id, item, sessionId, t }))
				),
				react.createElement(
					"div",
					{ className: "dsh-quote-dock-foot" },
					react.createElement(
						"button",
						{
							type: "button",
							className: "dsh-quote-prefill",
							disabled: !canPrefill,
							onMouseDown: (event) => event.preventDefault(),
							onClick: () => prefillWithQuotes()
						},
						t("dock.prefill")
					),
					react.createElement(
						"button",
						{
							type: "button",
							className: "dsh-quote-send",
							disabled: !canSend,
							onMouseDown: (event) => event.preventDefault(),
							onClick: () => submitWithQuotes()
						},
						t("dock.send", { count: items.length })
					)
				)
			);
		}

		function QuoteAction({ messageId, sessionId, t, useChat, useSession }) {
			const useChatSnapshot = typeof useChat === "function"
				? useChat
				: (selector) => useSession((snapshot) => selector(snapshot.chat ?? {}));
			// Selectors must return primitives: a fresh object every read would make
			// the store selector compare unequal forever.
			const text = useChatSnapshot((snapshot) => {
				const nodes = snapshot.nodes ?? snapshot.chat?.nodes;
				for (const node of nodes?.values?.() ?? []) {
					const finalNode = node?.data?.finalNode;
					if (finalNode !== void 0 && finalNode.messageId === messageId) {
						return textOfBlocks(finalNode.blocks).trim();
					}
				}
				return "";
			});
			const time = useChatSnapshot((snapshot) => {
				const nodes = snapshot.nodes ?? snapshot.chat?.nodes;
				for (const node of nodes?.values?.() ?? []) {
					const finalNode = node?.data?.finalNode;
					if (finalNode !== void 0 && finalNode.messageId === messageId) {
						return finalNode.time ?? "";
					}
				}
				return "";
			});
			if (text === "") return null;
			return react.createElement(
				"button",
				{
					type: "button",
					className: "dsh-quote-action",
					title: t("action.quoteWhole"),
					"aria-label": t("action.quoteWhole"),
					onMouseDown: (event) => event.preventDefault(),
					onClick: () => {
						if (addQuote(sessionId, { role: "assistant", messageId, text, time })) {
							focusComposer();
						}
					}
				},
				react.createElement(QuoteIcon)
			);
		}

		// ── styles ───────────────────────────────────────────────────────────

		const CSS = [
			".dsh-quote-selection{corner-shape:round;background:var(--dsw-alias-button-floating-fill);--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);cursor:pointer;border:none;border-radius:999px;padding:5px 10px}",
			".dsh-quote-selection:hover{background:var(--dsw-alias-button-floating-hover)}",
			".dsh-quote-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:8px;justify-content:center;align-items:center;padding:6px;display:inline-flex}",
			".dsh-quote-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dsh-quote-float{position:fixed;z-index:1200;display:none;width:30px;height:30px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-menu,#fff);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:var(--dsw-elevation-panel,0 4px 16px rgba(0,0,0,.18));cursor:pointer;justify-content:center;align-items:center;padding:0}",
			".dsh-quote-float:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-quote-float-icon{display:inline-flex;color:var(--dsw-alias-state-business-primary)}",
			".dsh-quote-dock{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,760px);margin:0 auto;padding:0 var(--dsh-composer-side-clearance,16px)}",
			".dsh-quote-dock-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 4px 4px}",
			".dsh-quote-dock-title{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-weight:500}",
			".dsh-quote-clear{background:0 0;border:none;border-radius:6px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:18px;padding:2px 6px}",
			".dsh-quote-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dsh-quote-list{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto}",
			".dsh-quote-card{position:relative;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-left:2px solid var(--dsw-alias-state-business-primary);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-specific-menu,#fff);padding:6px 28px 7px 10px}",
			".dsh-quote-card-meta{display:flex;align-items:center;gap:6px;margin-bottom:1px}",
			".dsh-quote-role{font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-state-business-primary)}",
			".dsh-quote-clock{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".dsh-quote-remove{position:absolute;top:5px;right:5px;width:20px;height:20px;display:grid;place-items:center;border:none;border-radius:5px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}",
			".dsh-quote-remove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-quote-card-text{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
			".dsh-quote-reply{box-sizing:border-box;display:block;width:100%;min-height:26px;max-height:120px;margin-top:5px;padding:3px 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-specific-input-major,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;resize:none;outline:none;overflow-y:auto}",
			".dsh-quote-reply::placeholder{color:var(--dsw-alias-label-caption)}",
			".dsh-quote-reply:focus{border-color:var(--dsw-alias-state-business-primary)}",
			".dsh-quote-dock-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:6px 4px 0}",
			".dsh-quote-prefill{height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:25px;cursor:pointer}",
			".dsh-quote-prefill:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-quote-prefill:disabled{opacity:.45;cursor:default}",
			".dsh-quote-send{height:26px;padding:0 12px;border:none;border-radius:6px;background:var(--dsw-alias-state-business-primary);color:#fff;font-size:12px;line-height:26px;cursor:pointer}",
			".dsh-quote-send:hover:not(:disabled){opacity:.9}",
			".dsh-quote-send:disabled{opacity:.45;cursor:default}",
			"@media (max-width:560px){.dsh-quote-list{max-height:220px}}"
		].join("\n");

		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="dsh-quote-cards/dock.css"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-quote-cards";
			tag.dataset.pluginCss = "dsh-quote-cards/dock.css";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ── plugin body ──────────────────────────────────────────────────────

		const inject = ["slots", "locale"];

		function apply(ctx) {
			installStyles();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-quote: dictionaries");

			ctx.effect(() => {
				if (typeof document === "undefined") return;
				document.addEventListener("keydown", onKeyDownCapture, true);
				document.addEventListener("click", onClickCapture, true);
				return () => {
					document.removeEventListener("keydown", onKeyDownCapture, true);
					document.removeEventListener("click", onClickCapture, true);
				};
			}, "dsh-quote: submit watcher");

			ctx.slots.inject("conversation.input.dock", () => {
				const dispose = ctx.slots.register({
					name: "conversation.input.dock",
					id: "quote-dock",
					order: 5,
					locale: NS
				}, QuoteDock);
				return () => dispose();
			});

			ctx.slots.inject("conversation.chat.assistant-actions", () => {
				const dispose = ctx.slots.register({
					name: "conversation.chat.assistant-actions",
					id: "quote-reply",
					order: 4,
					locale: NS
				}, QuoteAction);
				return () => dispose();
			});

			ctx.slots.inject("conversation.chat.text-interaction", () => {
				const dispose = ctx.slots.register({
					name: "conversation.chat.text-interaction",
					key: "quote",
					priority: -1,
					locale: NS
				}, QuoteSelectionButton);
				return () => dispose();
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__test = {
			addQuote,
			clearQuotes,
			buildPrefillDraft,
			composeDraft,
			excerpt,
			formatClock,
			quoteItems,
			prefillWithQuotes,
			removeQuote,
			setQuoteReply,
			setActiveComposer: (value) => {
				activeComposer = value;
			},
			submitWithQuotes,
			toBlockquote
		};
		return module.exports;
	}
});

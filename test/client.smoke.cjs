process.env.TZ = "Asia/Shanghai";
// Smoke test for dsh-quote's client bundle body (no browser needed).
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const assert = require("assert");

const code = fs.readFileSync(path.join(__dirname, "..", "lib", "client.js"), "utf8");

function makeElement(tag) {
  return {
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    listeners: {},
    className: "",
    innerHTML: "",
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); },
    removeEventListener() {},
    querySelector() { return null; },
    closest() { return null; },
    contains() { return false; },
    focus() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    offsetWidth: 0,
    offsetHeight: 0
  };
}

const documentListeners = {};
const documentStub = {
  head: makeElement("head"),
  body: makeElement("body"),
  addEventListener(name, fn) { (documentListeners[name] ??= []).push(fn); },
  removeEventListener() {},
  createElement(tag) { return makeElement(tag); },
  querySelector() { return null; },
  createRange() {
    return { selectNodeContents() {}, collapse() {} };
  }
};

const reactStub = {
  createElement(type, props, ...children) { return { type, props, children }; },
  useRef(value) { return { current: value }; },
  useState(value) { return [value, () => {}]; },
  useEffect() {},
  useSyncExternalStore() { return []; }
};

let loaded = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition.factory((name) => {
          if (name === "react") return reactStub;
          throw new Error("unexpected require: " + name);
        });
      }
    },
    innerWidth: 1280,
    innerHeight: 800,
    getSelection() { return { isCollapsed: true, rangeCount: 0, removeAllRanges() {} }; }
  },
  document: documentStub,
  Element: class Element {},
  setTimeout,
  clearTimeout,
  console,
  Date,
  Math,
  Object,
  String,
  Number,
  Array,
  Map,
  Set,
  Symbol
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "lib/client.js" });

assert.ok(loaded, "bundle should expose a module");
assert.strictEqual(typeof loaded.apply, "function");
const api = loaded.__test;
assert.ok(api, "test hooks should be exported");

// ---- pure helpers ----
assert.strictEqual(api.toBlockquote("a\n\nb"), "> a\n>\n> b");
assert.strictEqual(api.formatClock("2026-11-05T14:22:31+08:00"), "14:22");
assert.strictEqual(api.formatClock("nope"), "");

// ---- store ----
const S = "session-1";
assert.strictEqual(api.addQuote(S, { role: "assistant", messageId: "m1", text: "hello", time: "2026-11-05T14:22:00+08:00" }), true);
assert.strictEqual(api.addQuote(S, { role: "assistant", messageId: "m1", text: "hello" }), false, "duplicates are ignored");
assert.strictEqual(api.addQuote(S, { role: "selection", text: "fragment" }), true);
assert.strictEqual(api.quoteItems(S).length, 2);

const items = api.quoteItems(S);
const t = (key, params) => {
  const dict = {
    "compose.assistant": "引用 · 助手{time}",
    "compose.selection": "引用 · 选中文字"
  };
  let out = dict[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {})) out = out.replace("{" + name + "}", String(value));
  return out;
};
const composed = api.composeDraft(items, "my reply", t);
assert.ok(composed.includes("> **引用 · 助手 · 14:22**"), composed);
assert.ok(composed.includes("> hello"), composed);
assert.ok(composed.includes("> **引用 · 选中文字**"), composed);
assert.ok(composed.endsWith("\n\nmy reply"), composed);

assert.strictEqual(api.composeDraft([], "only me", t), "only me");
assert.strictEqual(api.composeDraft([], "  ", t), "");

api.removeQuote(S, items[0].id);
assert.strictEqual(api.quoteItems(S).length, 1);
api.clearQuotes(S);
assert.strictEqual(api.quoteItems(S).length, 0);

for (let i = 0; i < 12; i += 1) api.addQuote(S, { role: "selection", text: "piece " + i });
assert.strictEqual(api.quoteItems(S).length, 8, "quote collection is capped");

// ---- submit path ----
api.clearQuotes(S);
api.addQuote(S, { role: "assistant", messageId: "m2", text: "quoted body", time: "2026-11-05T09:05:00+08:00" });
let submittedDraft = null;
let submitted = 0;
api.setActiveComposer({
  sessionId: S,
  t,
  phase: "plain",
  draftRef: { current: "my answer" },
  inputActions: {
    setDraft(text) { submittedDraft = text; },
    submit() { submitted += 1; }
  }
});
assert.strictEqual(api.submitWithQuotes(), true);
assert.ok(submittedDraft.includes("> quoted body"), submittedDraft);
assert.ok(submittedDraft.endsWith("\n\nmy answer"), submittedDraft);
assert.strictEqual(submitted, 1);
assert.strictEqual(api.quoteItems(S).length, 0, "quotes clear after submit");
api.setActiveComposer(null);

// ---- plugin registration ----
const registered = [];
const effects = [];
const ctx = {
  effect(fn, label) { effects.push(label); const dispose = fn(); return dispose; },
  locale: { register(ns, dicts) { registered.push({ kind: "locale", ns, dicts }); return () => {}; } },
  slots: {
    inject(key, callback) { callback(); return () => {}; },
    register(entry, component) { registered.push({ kind: "slot", entry, component }); return () => {}; }
  }
};
loaded.apply(ctx);
assert.ok(registered.some((r) => r.kind === "locale" && r.ns === "dshQuote" && r.dicts.zh && r.dicts.en));
assert.ok(registered.some((r) => r.kind === "slot" && r.entry.name === "conversation.input.dock"));
assert.ok(registered.some((r) => r.kind === "slot" && r.entry.name === "conversation.chat.assistant-actions"));
assert.ok(documentListeners.keydown.some((fn) => fn.length >= 1), "submit key handler is installed");
assert.ok(documentListeners.click.some((fn) => fn.length >= 1), "submit click handler is installed");
assert.ok(documentStub.head.children.length >= 1, "stylesheet is installed");

// ---- assistant action renders and collects the whole reply ----
const actionEntry = registered.find((r) => r.kind === "slot" && r.entry.name === "conversation.chat.assistant-actions");
const snapshot = {
  nodes: new Map([["node-1", {
    data: { finalNode: { messageId: "m9", blocks: [{ kind: "text", text: "whole reply" }], time: "2026-11-05T08:30:00+08:00" } }
  }]])
};
const tree = actionEntry.component({
  messageId: "m9",
  sessionId: "session-2",
  t,
  useChat: (selector) => selector(snapshot)
});
assert.ok(tree && tree.type === "button", "action renders a button");
tree.props.onClick();
assert.strictEqual(api.quoteItems("session-2").length, 1);
assert.strictEqual(api.quoteItems("session-2")[0].text, "whole reply");

console.log("ok — dsh-quote smoke test passed");

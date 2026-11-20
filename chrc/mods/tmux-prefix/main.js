import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, closeOverlay, focused, hc, nextCommand, props, run, shared, theme } from "herdr";

// Edit these two things to make the example yours. Only repeatable actions
// start a timer: the first key after Ctrl+B can take as long as you like.
const REPEAT_MS = 500;
// Mirrors the Herdr TUI prefix keys (~/.config/herdr/config.toml [keys]).
// Shifted digits follow a US layout: !@#$%^&*( select spaces 1-9.
const SPACE_KEYS = "!@#$%^&*(";
const BINDINGS = [
  ["c", "New tab", "tab.new"],
  ["T", "Rename tab", "tab.rename"],
  ["X", "Close tab", "tab.close"],
  ["n", "Next tab", "tab.next", {}, true],
  ["p", "Previous tab", "tab.prev", {}, true],
  ["v", "Split right", "pane.split", { direction: "right" }],
  ["-", "Split down", "pane.split", { direction: "down" }],
  ['"', "Split down", "pane.split", { direction: "down" }],
  ["x", "Close pane", "pane.close"],
  ["z", "Zoom pane", "pane.zoom"],
  ["h", "Focus left", "pane.go", { direction: "left" }, true],
  ["j", "Focus down", "pane.go", { direction: "down" }, true],
  ["k", "Focus up", "pane.go", { direction: "up" }, true],
  ["l", "Focus right", "pane.go", { direction: "right" }, true],
  ["H", "Swap left", "pane.swap", { direction: "left" }, true],
  ["L", "Swap right", "pane.swap", { direction: "right" }, true],
  ["left", "Focus left", "pane.go", { direction: "left" }, true],
  ["down", "Focus down", "pane.go", { direction: "down" }, true],
  ["up", "Focus up", "pane.go", { direction: "up" }, true],
  ["right", "Focus right", "pane.go", { direction: "right" }, true],
  ["J", "Next agent", "agent.next", {}, true],
  ["K", "Previous agent", "agent.prev", {}, true],
  ["]", "Next space", "space.next", {}, true],
  ["[", "Previous space", "space.prev", {}, true],
  ["N", "New space", "space.new"],
  ["W", "Rename space", "space.rename"],
  ["D", "Close space", "space.close"],
  ["a", "Agents board", "mod.open", { name: "agents-board" }],
  ["w", "Go to (picker)", "mod.open", { name: "picker" }],
  ["g", "Go to (picker)", "mod.open", { name: "picker" }],
  ["b", "Toggle sidebar", "layout.toggle", { id: "sidebar" }],
  ["s", "Settings", "app.settings"],
  ["q", "Hide window (detach)", "window.minimize"],
  ["d", "Minimize window", "window.minimize"],
  ...Array.from({ length: 10 }, (_, i) => [String(i), `Tab ${i === 0 ? 10 : i}`, "tab.select", { index: i === 0 ? 10 : i }]),
  ...Array.from(SPACE_KEYS, (key, i) => [key, `Space ${i + 1}`, "space.select", { index: i + 1 }]),
];

// Agents as the sidebar numbers them: ordered-agents publishes its open order.
// Without it (another layout), fall back to open order by terminal number.
function numberedAgents() {
  const list = agents();
  const order = shared("agents.order");
  if (Array.isArray(order) && order.length) return order.map((addr) => list.find((a) => a.address === addr)).filter(Boolean);
  const key = (addr) => { const [m, id] = addr.includes("/") ? addr.split("/") : ["", addr]; return [m, Number(id.replace(/\D/g, "")) || 0]; };
  return [...list].sort((x, y) => { const [mx, nx] = key(x.address); const [my, ny] = key(y.address); return mx === my ? nx - ny : mx < my ? -1 : 1; });
}

// The help groups, as columns. Keys go to a group by their command.
const GROUPS = ["Tabs", "Panes", "Spaces", "Agents", "App"];
function groupOf([, label, command, args]) {
  if (command?.startsWith("tab.")) return "Tabs";
  if (command?.startsWith("pane.")) return "Panes";
  if (command?.startsWith("space.")) return "Spaces";
  if (command?.startsWith("agent.") || args?.name === "agents-board" || /agent/i.test(label)) return "Agents";
  return "App";
}
// Keys this mod handles outside BINDINGS (Alt), and one-row summaries of the numbered keys.
const EXTRAS = [
  ["⌥1–9", "Focus agent N", null],
  ["⌥g", "Lazygit", "terminal.open", { argv: ["lazygit"], name: "lazygit" }],
];
const SUMMARIES = [
  ["0–9", "Tab 1–10", "tab.select"],
  ["←↓↑→", "Focus pane", "pane.go"],
  ["!–(", "Space 1–9 (⇧1–9)", "space.select"],
];
const isNumbered = ([key]) => ["left", "right", "up", "down"].includes(key) || /^\d$/.test(key) || SPACE_KEYS.includes(key);
const ARROWS = { left: "←", right: "→", up: "↑", down: "↓" };
const shown = (key) => ARROWS[key] ?? key;

function forwardKey(e, key) {
  if (["enter", "tab", "backspace", "left", "right", "up", "down", "space"].includes(e.key)) return e.key;
  if (key === " ") return "space";
  if (/^[A-Z]$/.test(key)) return `shift+${key.toLowerCase()}`;
  if (key.length === 1 && "abcdefghijklmnopqrstuvwxyz0123456789`\\[],=-.';/".includes(key)) return key === "\\" ? "backslash" : key;
  return null;
}

export default class TmuxPrefix extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.repeat = false;
    this.generation = 0;
    this.all = false;
    // "/" search: the query, and which match Enter runs.
    this.query = null;
    this.pick = 0;
    // The mod-specific key binding beats the global opener while we're open.
    cx.spawn(async (cx) => {
      for (;;) {
        await nextCommand();
        this.sendPrefix(cx);
      }
    });
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  send(key, cx) {
    this.generation++;
    const terminal = focused()?.terminal;
    if (!terminal) return this.dismiss();
    // hc starts its subprocess at the call, before closing cancels this view's tasks.
    const pending = hc(["keys", terminal, key]);
    cx.spawn(async () => {
      const result = await pending;
      if (result.code !== 0) console.log(`tmux-prefix: ${result.stderr}`);
    });
    this.dismiss();
  }

  sendPrefix(cx) {
    this.send("ctrl+b", cx);
  }

  // Every row the search can find: numbered keys included, Alt keys too.
  matches() {
    const q = (this.query ?? "").toLowerCase();
    return [...BINDINGS, ...EXTRAS].filter((b) => !q || b[1].toLowerCase().includes(q) || shown(b[0]).toLowerCase() === q);
  }

  searchKey(e, cx) {
    const m = e.modifiers;
    const found = this.matches();
    if (e.key === "escape") this.query = null;
    else if (e.key === "enter") {
      const [, , command, args = {}] = found[this.pick] ?? [];
      if (!command) return;
      this.dismiss();
      return run(command, args);
    } else if (e.key === "down" || (m.control && (e.key === "n" || e.key === "j"))) this.pick = Math.min(this.pick + 1, found.length - 1);
    else if (e.key === "up" || (m.control && (e.key === "p" || e.key === "k"))) this.pick = Math.max(this.pick - 1, 0);
    else if (e.key === "backspace") {
      if (!this.query) this.query = null;
      else this.query = this.query.slice(0, -1);
      this.pick = 0;
    } else if (!m.control && !m.platform && e.key_char && e.key_char.length === 1) {
      this.query += e.key_char;
      this.pick = 0;
    }
    cx.notify();
  }

  key(e, cx) {
    cx.stop_propagation();
    const m = e.modifiers;
    if (this.query != null) return this.searchKey(e, cx);
    if (e.key === "escape") return this.dismiss();
    if (m.control && e.key === "b") return this.sendPrefix(cx);
    if (m.alt && !m.control && !m.platform) {
      if (/^[1-9]$/.test(e.key)) {
        const agent = numberedAgents()[Number(e.key) - 1];
        this.dismiss();
        if (agent) run("agent.focus", { terminal: agent.address });
        return;
      }
      if (e.key === "g") {
        this.dismiss();
        return run("terminal.open", { argv: ["lazygit"], name: "lazygit" });
      }
    }
    const plain = !m.control && !m.alt && !m.platform;
    const key = plain ? (e.key_char ?? (m.shift && e.key.length === 1 ? e.key.toUpperCase() : e.key)) : e.key;
    if (plain && key === "/" && !this.repeat) {
      this.query = "";
      this.pick = 0;
      cx.notify();
      return;
    }
    if (plain && key === "?") {
      this.all = !this.all;
      this.repeat = false;
      this.generation++;
      cx.notify();
      return;
    }
    const binding = plain && BINDINGS.find((b) => b[0] === key);
    if (!binding) {
      const forwarded = this.repeat && plain && forwardKey(e, key);
      if (forwarded) return this.send(forwarded, cx);
      return this.dismiss();
    }
    const [, , command, args = {}, repeatable = false] = binding;
    if (!repeatable) this.dismiss();
    run(command, args);
    if (repeatable) {
      this.repeat = true;
      const generation = ++this.generation;
      cx.timer.after(REPEAT_MS, () => {
        if (this.generation === generation) this.dismiss();
      });
      cx.notify();
    }
  }

  row(t, [key, label, , , repeatable], on = false) {
    return h_flex().h(20).flex_none().items_center().gap(8).px(4).rounded(4)
      .when(on, (el) => el.bg(t.selected))
      .child(div().w(36).flex_none().text_color(t.accent).child(shown(key)))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(repeatable), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("↻")));
  }

  render() {
    const t = theme();
    const searching = this.query != null;
    const head = searching
      ? h_flex().gap(6).items_center().child(div().text_color(t.accent).child("/")).child(div().flex_1().child(`${this.query}▏`))
      : div().font_semibold().child(this.repeat ? `Repeat · ${REPEAT_MS} ms` : "Ctrl+B · waiting for a key");
    const hint = searching ? "⏎ run · ↑↓ / ^n ^p move · Esc back" : "/ search · ? all · Esc cancel · ^B send prefix";
    let body;
    if (searching) {
      const found = this.matches();
      body = v_flex().h(330).min_h(0).overflow_y_scrollbar()
        .when(found.length === 0, (el) => el.child(div().text_color(t.dim).child("No match")))
        .children(found.map((b, i) => h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).child(this.row(t, b, i === this.pick)))
          .child(div().w(60).flex_none().text_size(10.5).text_color(t.dim).child(groupOf(b)))));
    } else {
      const rows = [...(this.all ? BINDINGS : [...BINDINGS.filter((b) => !isNumbered(b)), ...SUMMARIES]), ...EXTRAS];
      body = h_flex().items_start().gap(16).children(GROUPS.map((g) => v_flex().flex_1().min_w(0).gap(2)
        .child(div().px(4).pb(4).text_size(11).font_semibold().text_color(t.muted).child(g))
        .child(v_flex().id(`grp-${g}`).max_h(this.all ? 300 : 330).overflow_y_scrollbar()
          .children(rows.filter((b) => groupOf(b) === g).map((b) => this.row(t, b))))));
    }
    return v_flex().id("tmux-prefix").track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .p(14).gap(10).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(h_flex().justify_between().items_center().child(head).child(div().text_color(t.muted).child(hint)))
      .child(body)
      .child(div().text_color(t.dim).text_size(11).child("↻ repeats: press again within the window, no ^B needed"));
  }
}

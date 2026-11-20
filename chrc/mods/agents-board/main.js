// Agents as a kanban board by state: what needs you first, then working, done and idle.
// Opened with Ctrl+B a (tmux-prefix). Vim keys move a cursor (h/l columns, j/k cards,
// g/G top/bottom), Enter jumps to it; a click or the card's number jumps directly.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, closeOverlay, props, run, shared, spaces, theme } from "herdr";

const COLUMNS = [
  { id: "blocked", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "done", label: "Done" },
  { id: "idle", label: "Idle" },
];
const columnOf = (status) => (status === "error" ? "blocked" : COLUMNS.some((c) => c.id === status) ? status : "idle");

// Drops a status glyph or spinner an agent puts before its title ("✦  Working").
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").trim();

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class AgentsBoard extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    // The cursor: a column, and the selected agent's address (follows it as it moves).
    this.col = null;
    this.sel = null;
  }

  // The board's columns with their members, as rendered.
  columns() {
    const list = [...agents()].sort((x, y) => y.seq - x.seq);
    return COLUMNS.map((c) => ({ ...c, members: list.filter((a) => columnOf(a.status) === c.id) }));
  }

  // Where the cursor is: the selected agent's column and row, else the first non-empty column.
  cursor(cols) {
    for (let c = 0; c < cols.length; c++) {
      const r = cols[c].members.findIndex((a) => a.address === this.sel);
      if (r >= 0) return { c, r };
    }
    const c = this.col ?? Math.max(0, cols.findIndex((col) => col.members.length));
    return { c, r: cols[c].members.length ? 0 : -1 };
  }

  move(dc, dr, cx) {
    const cols = this.columns();
    let { c, r } = this.cursor(cols);
    if (dc) {
      // Skip empty columns; stay put at the edges.
      let n = c + dc;
      while (n >= 0 && n < cols.length && !cols[n].members.length) n += dc;
      if (n < 0 || n >= cols.length) return;
      c = n;
      r = Math.min(Math.max(r, 0), cols[c].members.length - 1);
    } else {
      const len = cols[c].members.length;
      if (!len) return;
      r = dr === -Infinity ? 0 : dr === Infinity ? len - 1 : Math.min(Math.max(r + dr, 0), len - 1);
    }
    this.col = c;
    this.sel = cols[c].members[r]?.address ?? null;
    cx.notify();
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(a) {
    this.close();
    run("pane.focus", { pane: a.pane });
  }

  // Same numbers as the sidebar (ordered-agents publishes them), so ⌥N and N agree.
  numbered() {
    const list = agents();
    const order = shared("agents.order");
    if (!Array.isArray(order) || !order.length) return list;
    return order.map((addr) => list.find((a) => a.address === addr)).filter(Boolean);
  }

  key(e, cx) {
    cx.stop_propagation();
    if (e.key === "escape" || e.key === "q") return this.close();
    const shift = e.modifiers?.shift;
    const k = e.key;
    if (k === "h" || k === "left") return this.move(-1, 0, cx);
    if (k === "l" || k === "right") return this.move(1, 0, cx);
    if (k === "j" || k === "down") return this.move(0, 1, cx);
    if (k === "k" || k === "up") return this.move(0, -1, cx);
    if (k === "g" && !shift) return this.move(0, -Infinity, cx);
    if (k === "G" || (k === "g" && shift)) return this.move(0, Infinity, cx);
    if (k === "enter" || k === "o" || k === "space") {
      const cols = this.columns();
      const { c, r } = this.cursor(cols);
      const a = cols[c].members[r];
      if (a) this.go(a);
      return;
    }
    if (/^[1-9]$/.test(e.key)) {
      const a = this.numbered()[Number(e.key) - 1];
      if (a) this.go(a);
    }
  }

  card(t, a, n, tabs, selected) {
    const tab = tabs.get(a.tab);
    const detail = tab?.named ? tab.name : clean(a.title) || a.program?.name || "";
    const color = t[columnOf(a.status)] ?? t.dim;
    return v_flex()
      .id(`card-${a.address}`)
      .flex_none()
      .p(10)
      .gap(4)
      .rounded(8)
      .bg(a.focused ? t.selected : t.raised)
      .border_l(3)
      .border_color(color)
      .when(selected, (el) => el.border(2).border_color(t.accent))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.go(a))
      .child(h_flex().gap(8).items_center()
        .child(div().w(14).flex_none().text_size(11).text_color(t.dim).child(n ? String(n) : ""))
        .when(Boolean(icon(a.program, 16, t.foreground)), (el) => el.child(icon(a.program, 16, t.foreground)))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(a.space_name || detail)))
      .child(div().pl(22).text_size(11.5).text_color(t.muted).truncate().child(detail))
      .child(h_flex().pl(22).gap(6).text_size(10.5).text_color(t.dim)
        .child(div().child(a.program?.name ?? a.app ?? ""))
        .child(div().child(`· ${a.address}`)));
  }

  render() {
    const t = theme();
    const numbered = this.numbered();
    const number = new Map(numbered.map((a, i) => [a.address, i + 1]));
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const cols = this.columns();
    const cur = this.cursor(cols);
    const selected = cols[cur.c]?.members[cur.r]?.address;
    return v_flex()
      .id("agents-board")
      .size_full()
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .p(16)
      .gap(12)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(13)
      .child(h_flex().justify_between().items_center()
        .child(div().font_semibold().text_size(14).child("Agents"))
        .child(div().text_size(11).text_color(t.dim).child("h/l column · j/k card · g/G top/bottom · ⏎ open · 1–9 jump · Esc close")))
      .child(h_flex().flex_1().min_h(0).gap(12).items_start().children(cols.map((c) => {
        const members = c.members;
        return v_flex().id(`col-${c.id}`).flex_1().min_w(0).h_full().gap(8).p(8).rounded(10).bg(t.chrome)
          .child(h_flex().gap(6).items_center().px(4).h(22).flex_none()
            .child(div().size(8).rounded(4).bg(t[c.id] ?? t.dim))
            .child(div().font_semibold().text_size(12).text_color(t[c.id] ?? t.foreground).child(c.label))
            .child(div().text_size(11).text_color(t.dim).child(String(members.length))))
          .child(v_flex().id(`list-${c.id}`).flex_1().min_h(0).gap(8).overflow_y_scrollbar()
            .when(members.length === 0, (el) => el.child(div().px(4).text_size(11.5).text_color(t.dim).child("Nothing here")))
            .children(members.map((a) => this.card(t, a, number.get(a.address), tabs, a.address === selected))));
      })));
  }
}

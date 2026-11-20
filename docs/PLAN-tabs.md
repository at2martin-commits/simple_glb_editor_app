# Plan: tabs — several projects, and several Claude sessions + you, in one editor at once (for later)

Status: **built** 2026-11-20 (see CLAUDE.md "Tabs").

## What it does
- A **tab bar** across the top of the 3D view, one tab per open project: its name, a dot when it has unsaved changes, ✕ to close,
  **+** for a new empty tab. Tabs opened by a Claude session show a 🤖 badge and the session's name (e.g. "🤖 Claude 1").
- Each tab keeps **everything of its own**: model, animations, Build-mode project, Undo/Redo, selection, mode, camera, open file.
- Keys (rebindable): **Ctrl+T** new tab, **Ctrl+W** close, **Ctrl+Tab / Ctrl+Shift+Tab** next / previous, **Ctrl+1…9** jump.
  Middle-click closes, drag to reorder.
- Opening a file goes into the current tab if it is empty, otherwise a **new tab** (setting: "always new tab" / "replace current").
- Closing a tab or the app with unsaved changes asks: Save / Don't save / Cancel. Open tabs come back on the next start.

## Several sessions + you at the same time
- **Every Claude session gets its own tab**, created on its first call and named after the session ("🤖 Claude 1",
  "🤖 Claude 2"…). Its work happens there, in the background — it never changes the tab you are looking at, your selection,
  camera, tool or undo history. Many sessions can work at once (each in its own tab), plus you in yours.
- A session can be pointed at a specific tab or file (`glb_start {tab: "toon_m"}`), or share one with another session if asked.
- **Your control over Claude tabs**: you can switch to any tab and look around freely. A banner says "Claude (Claude 1) is
  working here"; editing is paused for you there until you press **Take over** (then that session's next call gets a clear
  "The user took over this tab" message) — no tug-of-war on one model. You can also close a Claude tab (the session is told).
- **Saving**: each tab saves its own file. If two tabs have the same Library file open, the second to save is warned
  ("changed by tab X since you opened it") instead of silently overwriting.
- **Watch page**: a tab picker at the top (all tabs, 🤖 ones marked); it can follow your active tab or stick to one tab — e.g.
  watch a session's work from the phone while you edit something else at the PC. Each tab publishes its own feed
  (`/api/watch/scene?tab=…`).
- **MCP stays lean**: no new tools. Each MCP server process (one per Claude session) remembers its tab; `glb_start` gets an optional
  `tab` (name) to choose or name it; everything else (glb_run, glb_build, glb_open …) simply works on that session's tab.
  Scripts inside glb_run still see `editor` = their tab's editor.

## Sub-tabs: work on one part alone (added 2026-11-20)
Like Photoshop Smart Objects (opens in its own tab, saves back), Unity Prefab mode (edit a piece alone, the rest hidden or greyed),
Blender Local view / Blockbench isolate (show only the selection).
- Right-click a group (e.g. `arm_right`) or a selection > **Open in a sub-tab**. It appears nested under its project's tab
  ("toon_f › arm_right"), and Build-mode groups, the model's joints and clothing sets can all be opened that way.
- The sub-tab is a **live view of the same project, not a copy**: every change (shapes, paint, pivots, colliders, slide rails,
  animation keys on its joints) shows in the main tab at once; nothing to save back or merge.
- Shows only that part, centred, with its **own camera, tool and selection**. Toggle: **Alone** (everything else hidden) /
  **In context** (the rest of the model shown greyed and not clickable, so the arm still fits the shoulder).
- Clicks, box-select, Select all, Delete, Mirror etc. are limited to that part, so you can't touch the body by accident.
  New shapes made there land inside that group.
- **Undo is shared** with the project (one history, so the main tab's Undo also takes back what you did in the sub-tab), with the
  sub-tab's name in each step's label.
- Closing the sub-tab just closes the view; the changes are already in the project. Closing the project closes its sub-tabs.
- A Claude session can be given a sub-tab too ("work on the arms only"), and the watch page can follow it.
- Later, a natural next step: **linked parts** — the same arm used in two characters, edit once, both update (Unity prefab / Figma
  component style). Not part of this plan.

Tech: a sub-tab = a filter + its own camera / tool / selection over the SAME Editor (and Build doc) as its parent tab: a node set
(the group and its descendants) used for drawing (hide or grey the rest), picking, box-select and the "picked" commands; switching
between a project and its sub-tabs only swaps the view state, never the data.

## How (tech) — one Editor per tab, one shared renderer
- Each tab owns its **own `Editor`** (scene graph, clips, undo, Build-mode `build`, mixer, watch publisher). Background tabs
  run their operations on their own objects — nothing to swap, so several sessions really can work at the same time
  (JavaScript runs one operation at a time; operations from different tabs interleave safely because they share no state).
- **One WebGL renderer** for the window (browsers cap WebGL contexts at ~16): it draws the ACTIVE tab's scene. Background tabs
  render on demand with the same renderer into an offscreen target (screenshots for MCP, watch thumbnails); things that need the
  live view (picking, paint brush, gizmo drags) only ever run on the active tab, which is the user's.
- Refactor: `Editor` takes a shared renderer / DOM and can run "headless"; `window.editor` and ui.js use the **active** editor
  through a getter (`editors.active`), and panels re-render on tab switch. `glbAction` acts on the active tab.
- Control endpoint (main.js `/run`): requests carry a `tab` id; the code runs with `editor` = that tab's Editor. The MCP server
  creates its tab on first use (`POST /tab`) and keeps the id; a tab closed by the user returns a clear error to that session.
- Library: per-file "opened at version" check on save (file mtime / hash) to catch two tabs overwriting each other.
- Memory: hidden tabs cost only memory; a soft limit with a warning for very heavy models.
- Alternatives considered: (a) one editor that swaps state between tabs — simpler, but only one tab can be worked on at a time,
  so sessions would fight over it; (b) a separate window per session — easy isolation, but no tab bar and more windows to manage.

## Steps
1. Editor refactor: shared renderer, headless mode, per-tab Editor + Build instances, `editors` manager (`tabs()`, `newTab`,
   `switchTab`, `closeTab`), active-editor getter for ui.js / panels / keys / watch.
2. Tab bar UI (badges, unsaved dot, ✕, +, reorder), keys, open-in-new-tab rule, close / quit prompts, remember tabs.
3. Sessions: `/run` with `tab`, MCP server keeps its tab (+ `glb_start {tab}`), banner + Take over, save-conflict warning.
4. Watch page: per-tab feeds + tab picker / follow.
5. Docs (CLAUDE.md / glb_help) and tests: two sessions building different models at the same time while the user edits a third tab;
   undo in each; switching during playback; closing a session's tab; same file in two tabs; watch page following a session tab.

## Questions to settle when we start
- Opening a file: always a new tab, or reuse an empty / current one?
- Reopen the last tabs automatically on start?
- In a Claude tab, should you be able to edit right away (shared), or only after **Take over** (recommended)?
- Should a session's tab close by itself when the session ends, or stay until you close it?

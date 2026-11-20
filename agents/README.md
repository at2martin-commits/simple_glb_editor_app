# AI assistant plugins

The editor's AI panel (the **🤖** button, Ctrl+`) runs a command-line AI assistant in a terminal inside the editor. Each assistant is described by one plugin file: a `.json` file in

- **this folder** (`agents/`, next to the editor's code): built-in plugins. **Claude Code** ships here (`claude-code.json`).
- **your plugins folder**: `%APPDATA%\simple-glb-editor\agents\`. Drop a `.json` file in it and restart the editor. A file with the same `id` as a built-in plugin replaces it (to change how Claude starts, for example).

When there is more than one plugin, the **▾** menu next to the AI button lists them, and you pick which one the panel uses. The panel, the answer buttons, the "Where should it work?" folder box and the notifications work the same for every plugin.

The editor only ever starts the commands a plugin lists, and signing in is the assistant's own flow (usually in your browser), so the editor never sees passwords or keys. Only install plugins you trust: a plugin decides which program runs.

## Letting the assistant drive the editor

The panel only gives the assistant a terminal. To let it open, edit and save models, the assistant needs the editor's **MCP server** (`mcp/server.mjs`), which works with any assistant that supports the [Model Context Protocol](https://modelcontextprotocol.io). Register it in that assistant's own settings with the command `node "<editor folder>\mcp\server.mjs"`. Started from the panel, it finds this editor window by itself and works in its own tab. The full scripting API is in `CLAUDE.md` (also served to the assistant by the `glb_help` tool).

## The file

```json
{
  "id": "my-assistant",
  "name": "My Assistant",
  "program": "My Assistant CLI",
  "icon": "✨",
  "description": "Shown as the tooltip in the ▾ menu.",
  "find": { "commands": ["my-assistant"], "paths": ["~/.local/bin/my-assistant.exe"] },
  "install": { "command": "npm install -g my-assistant", "shell": "PowerShell", "url": "https://example.com/my-assistant" },
  "chat": { "args": ["--system-prompt-append", "{panelNote}"] },
  "version": { "args": ["--version"] },
  "env": { "GLB_SESSION_NAME": "In-app My Assistant" },
  "dropEnv": ["^MY_ASSISTANT_SESSION"],
  "status": {
    "args": ["auth", "status", "--json"],
    "json": { "loggedIn": "loggedIn", "method": "method" },
    "methods": { "subscription": "My subscription", "api": "API key" }
  },
  "signIn": [
    { "id": "browser", "label": "Sign in…", "tip": "Opens the sign-in page in your browser.", "args": ["login"], "intro": "Your browser opens; finish there." }
  ],
  "signOut": { "args": ["logout"], "confirm": "Sign My Assistant out on this computer?" },
  "panelNote": "You are running inside the Simple GLB Editor's AI panel. Offer choices as a numbered list at the end of your message."
}
```

| Field | Needed | What it does |
|---|---|---|
| `id` | yes | Unique name. The same id as a built-in plugin replaces it. |
| `find` | yes | How to find the program: `commands` are looked up on the PATH (`where`), then `paths` are tried (`~` = your home folder). |
| `chat` | yes | Arguments for a conversation. `{panelNote}` is replaced by `panelNote`. |
| `name`, `program`, `icon`, `description` | no | What the button, panel header and menu show. |
| `install` | no | Shown in the panel when the program is not found. |
| `version` | no | A quick command, used by the editor's self-test. |
| `env` | no | Extra environment variables. `GLB_SESSION_NAME` names the assistant's tab in the editor. |
| `dropEnv` | no | Regular expressions: environment variables to remove before starting (e.g. markers of a session that opened the editor). |
| `status` | no | A command that prints JSON about the sign-in; `json.loggedIn` / `json.method` are the fields to read (dotted paths work, `a.b.c`), `methods` turns the method into readable words. Without it the menu just says the assistant is ready. |
| `signIn` | no | Sign-in choices for the **▾** menu, each with its own arguments. |
| `signOut` | no | The sign-out command (with an optional confirmation question). |
| `panelNote` | no | Text handed to the assistant through `{panelNote}`. The answer bar turns a numbered list (1. 2. 3.) or A) B) C) at the end of its message into buttons, so asking for that helps. |

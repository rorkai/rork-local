# rork-local agent skill

A portable [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
that teaches AI coding agents to drive [rork-local](https://github.com/rorkai/rork-local):
start it from an app project, read status and auto-detection, publish to
TestFlight or the App Store with streamed logs, and capture / frame / upload
App Store screenshots — all over the plain HTTP API.

Works in Claude Code, Cursor, Codex CLI, Gemini CLI, GitHub Copilot, and any
other tool that implements the open Agent Skills standard.

## Install

### Claude Code

```sh
/plugin marketplace add rorkai/rork-local
/plugin install rork-local
```

### Any agent that supports the Agent Skills standard (Cursor, Codex CLI, Gemini CLI, …)

```sh
bunx add-skill rorkai/rork-local
# or
npx skills add rorkai/rork-local
```

### Manual install

Copy this folder into your agent's skills directory:

```sh
# from a clone of this repo
cp -r skills/rork-local ~/.claude/skills/rork-local
# or for other agents: ~/.agents/skills/rork-local, ~/.cursor/skills/rork-local, etc.
```

The skill is a single `SKILL.md` — no build step.

## Prerequisites on the user's machine

The skill walks the agent through checking these:

- macOS with Xcode command line tools (`xcrun simctl`), Node.js 20+.
- The `asc` CLI on `PATH` (or `ASC_BIN` set), with `asc auth login` completed.
- Optional: `asc web auth login` for creating brand-new App Store Connect apps,
  and `koubou` for screenshot framing.

## Source of truth

Every endpoint and flag in the skill was verified against the rork-local source
at the time of authoring. When the server surface changes, update the skill
alongside it (see `AGENTS.md`).

## License

Apache-2.0, same as the rest of the rork-local repository.

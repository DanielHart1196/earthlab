# AGENTS

## Main Rule

- If the user's prompt includes a question mark (`?`), do not make changes.
- In that case, answer the question, clarify intent if needed, and wait for explicit confirmation before editing files.

## Git Shortcut

- `gp` means:
  - `git add .`
  - `git commit -m "<clear message>"`
  - `git push origin main`

## Usage Notes

- Use `gp` only when the current working tree is intentionally ready to publish.
- Choose a specific commit message that matches the actual change.
- If branch, remote, or push target differ from `origin main`, do not assume `gp` applies unchanged.

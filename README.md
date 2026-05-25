# streamark

Ultra-fast streaming markdown parser tuned for LLM chat output — handles partial/incomplete markdown without flickering.

## What it does

- Character-level state-machine parser that accepts markdown one chunk at a time
- Auto-completes dangling tokens (open code fences, unclosed bold, half-tables) as the stream arrives
- GFM support: tables, strikethrough, task lists
- DOM renderer with RAF-batched updates and a zero-allocation streamer variant
- Optional thin React wrapper; works without React too
- Built-in XSS sanitization, zero runtime dependencies

## Stack

TypeScript, built with Bun. React is an optional peer dependency.

## Run it

```bash
bun install
bun run build        # emits dist/
bun test
```

Demo / playground app:

```bash
cd test-app
bun install
bun run dev          # vite dev server
```

## Notes

- Library entry: `src/index.ts`. Core parser lives in `src/core/`.
- Consume in another project via the published package or by pointing at `dist/`.

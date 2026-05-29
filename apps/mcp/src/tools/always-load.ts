// Tool-level _meta marking a schema to stay resident in model context
// every turn (Claude Code otherwise defers tool schemas behind Tool
// Search). Lives in its own module so tool files can import it without
// a circular dependency through tools/index.ts (which imports them).
export const ALWAYS_LOAD_META = { "anthropic/alwaysLoad": true } as const;

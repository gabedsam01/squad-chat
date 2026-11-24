export interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
  /** Flags that may repeat (`--agent a --agent b`). */
  lists: Map<string, string[]>;
}

const VALUE_FLAGS = new Set([
  "server",
  "from",
  "out",
  "data",
  "company",
  "dir",
  "name",
  "task",
  "run",
  "home",
  "agent",
  "code",
  "agent-uid-range",
  "token-env",
  "token-file",
  "state",
  "enroll-file",
  "rotate",
  "link",
  "minutes",
  "org",
]);
const LIST_FLAGS = new Set(["agent", "rotate"]);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
  const set = (key: string, value: string | true) => {
    flags.set(key, value);
    if (LIST_FLAGS.has(key) && typeof value === "string") lists.set(key, [...(lists.get(key) ?? []), value]);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h") flags.set("help", true);
    else if (arg === "-v") flags.set("version", true);
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      if (eq > 0) set(key, arg.slice(eq + 1));
      else if (VALUE_FLAGS.has(key)) {
        const value = argv[i + 1];
        if (value === undefined) throw new Error(`--${key} needs a value`);
        set(key, value);
        i++;
      } else set(key, true);
    } else positional.push(arg);
  }
  return { positional, flags, lists };
}

export const flagString = (p: Parsed, key: string) => {
  const v = p.flags.get(key);
  return typeof v === "string" ? v : undefined;
};

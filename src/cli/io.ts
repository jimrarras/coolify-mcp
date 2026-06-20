export interface IO {
  prompt(q: string, def?: string): Promise<string>;
  promptMasked(q: string): Promise<string>;
  confirm(q: string, def?: boolean): Promise<boolean>;
  print(s: string): void;
  /** Release any held input handle (e.g. the readline interface). Optional. */
  close?(): void;
}

export function makeScriptedIO(answers: string[]): IO & { printed: string[] } {
  const queue = [...answers];
  const printed: string[] = [];
  const next = () => (queue.length ? queue.shift()! : "");
  return {
    printed,
    async prompt(_q, def) { const a = next(); return a === "" && def !== undefined ? def : a; },
    async promptMasked() { return next(); },
    async confirm(_q, def = false) {
      const a = next().trim().toLowerCase();
      if (a === "") return def;
      return a === "y" || a === "yes";
    },
    print(s) { printed.push(s); },
  };
}

// One readline interface for the whole session. Creating a fresh interface per
// prompt breaks on piped/non-interactive stdin (the second interface sees an
// already-ended stream), so the wizard hangs after the first answer. A single
// shared interface works for both interactive typing and scripted input.
let _rl: import("node:readline/promises").Interface | undefined;
let _muted = false;

async function getRl(): Promise<import("node:readline/promises").Interface> {
  if (!_rl) {
    const rl = await import("node:readline/promises");
    const i = rl.createInterface({ input: process.stdin, output: process.stdout });
    // Gate the interface's echo so promptMasked can suppress a typed secret.
    (i as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput = (s: string) => {
      if (!_muted) process.stdout.write(s);
    };
    _rl = i;
  }
  return _rl;
}

export const defaultIO: IO = {
  async prompt(q, def) {
    const i = await getRl();
    const a = (await i.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a === "" && def !== undefined ? def : a;
  },
  async promptMasked(q) {
    const i = await getRl();
    process.stdout.write(`${q}: `); // show the label visibly...
    _muted = true;                  // ...then suppress the typed secret + its echo
    try { return (await i.question("")).trim(); }
    finally { _muted = false; process.stdout.write("\n"); }
  },
  async confirm(q, def = false) {
    const a = (await defaultIO.prompt(`${q} (${def ? "Y/n" : "y/N"})`)).trim().toLowerCase();
    if (a === "") return def;
    return a === "y" || a === "yes";
  },
  print(s) { process.stdout.write(s + "\n"); },
  close() { _rl?.close(); _rl = undefined; },
};

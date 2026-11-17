// Dependency levels for loading in dependency order.
// HAPI 8.12.0 with referential integrity off links a reference only if its target exists when the referrer is written,
// or is written in the same transaction (observed; a later identical PUT does not repair the link).
// So every resource is loaded after everything it references: level(r) = 0 without in-dataset targets,
// else 1 + max(level(target)). Same-level resources never reference each other, except members of one cycle,
// which are grouped into a single transaction.

export class DependencyGraph {
  private readonly index = new Map<string, number>();
  private readonly defined: boolean[] = [];
  private from: Int32Array = new Int32Array(1 << 16);
  private to: Int32Array = new Int32Array(1 << 16);
  private edges = 0;

  private node(key: string): number {
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.defined.length;
      this.index.set(key, i);
      this.defined.push(false);
    }
    return i;
  }

  /** Declares a resource ("Type/id"). Returns false if it was already declared (a duplicate). */
  define(key: string): boolean {
    const i = this.node(key);
    if (this.defined[i]) return false;
    this.defined[i] = true;
    return true;
  }

  has(key: string): boolean {
    const i = this.index.get(key);
    return i !== undefined && this.defined[i] === true;
  }

  addEdge(fromKey: string, toKey: string): void {
    if (fromKey === toKey) return; // a self-reference needs no ordering
    if (this.edges === this.from.length) {
      const grow = (a: Int32Array) => { const b = new Int32Array(a.length * 2); b.set(a); return b; };
      this.from = grow(this.from);
      this.to = grow(this.to);
    }
    this.from[this.edges] = this.node(fromKey);
    this.to[this.edges] = this.node(toKey);
    this.edges++;
  }

  /** Targets referenced but never defined, with the number of references to each. */
  dangling(): Map<string, number> {
    const keys = [...this.index.keys()];
    const out = new Map<string, number>();
    for (let e = 0; e < this.edges; e++) {
      const t = this.to[e]!;
      if (!this.defined[t]) out.set(keys[t]!, (out.get(keys[t]!) ?? 0) + 1);
    }
    return out;
  }

  /**
   * Level and transaction group of every defined resource. Members of a reference cycle (a strongly connected
   * component with more than one member, e.g. MIMIC microbiology hasMember/derivedFrom) share a level and a group id
   * and must be written in one transaction. Tarjan's algorithm emits components dependencies-first.
   */
  plan(): { level: Map<string, number>; group: Map<string, number>; groupSizes: number[] } {
    const n = this.defined.length;
    const start = new Int32Array(n + 1);
    for (let e = 0; e < this.edges; e++) if (this.defined[this.to[e]!]) start[this.from[e]! + 1]!++;
    for (let i = 0; i < n; i++) start[i + 1]! += start[i]!;
    const fill = start.slice(0, n);
    const adj = new Int32Array(start[n]!);
    for (let e = 0; e < this.edges; e++) if (this.defined[this.to[e]!]) adj[fill[this.from[e]!]!++] = this.to[e]!;

    const index = new Int32Array(n).fill(-1);
    const low = new Int32Array(n);
    const onStack = new Uint8Array(n);
    const stack = new Int32Array(n);
    const callNode = new Int32Array(n);
    const callEdge = new Int32Array(n);
    const comp = new Int32Array(n).fill(-1);
    const compLevel: number[] = [];
    const compGroup: number[] = [];
    const groupSizes: number[] = [];
    let sp = 0;
    let counter = 0;
    for (let s = 0; s < n; s++) {
      if (index[s] !== -1 || !this.defined[s]) continue;
      let csp = 0;
      const enter = (v: number) => {
        index[v] = low[v] = counter++;
        stack[sp++] = v;
        onStack[v] = 1;
        callNode[csp] = v;
        callEdge[csp] = start[v]!;
        csp++;
      };
      enter(s);
      while (csp > 0) {
        const v = callNode[csp - 1]!;
        if (callEdge[csp - 1]! < start[v + 1]!) {
          const w = adj[callEdge[csp - 1]!++]!;
          if (index[w] === -1) enter(w);
          else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
          continue;
        }
        csp--;
        if (csp > 0) { const u = callNode[csp - 1]!; low[u] = Math.min(low[u]!, low[v]!); }
        if (low[v] !== index[v]) continue;
        const id = compLevel.length;
        const members: number[] = [];
        let w: number;
        do { w = stack[--sp]!; onStack[w] = 0; comp[w] = id; members.push(w); } while (w !== v);
        let level = 0;
        for (const m of members) {
          for (let k = start[m]!; k < start[m + 1]!; k++) {
            const c = comp[adj[k]!]!;
            if (c !== id) level = Math.max(level, compLevel[c]! + 1);
          }
        }
        compLevel.push(level);
        if (members.length > 1) { compGroup.push(groupSizes.length); groupSizes.push(members.length); } else compGroup.push(-1);
      }
    }
    const keys = [...this.index.keys()];
    const level = new Map<string, number>();
    const group = new Map<string, number>();
    keys.forEach((k, i) => {
      if (!this.defined[i]) return;
      level.set(k, compLevel[comp[i]!]!);
      const g = compGroup[comp[i]!]!;
      if (g >= 0) group.set(k, g);
    });
    return { level, group, groupSizes };
  }
}

/** One base-36 character per line of a type file. */
export const encodeLevel = (level: number) => {
  if (level < 0 || level > 35) throw new Error(`dependency level ${level} out of range`);
  return level.toString(36);
};
export const decodeLevel = (ch: string) => parseInt(ch, 36);

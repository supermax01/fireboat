import { fault, SCOPE_TOKEN, type GrantedInteraction } from './token-provider.js';

/** `v2` asks for `.rs`; `v1` asks for `.read`. Chosen by the operator; never auto-detected. */
export type ScopeSyntax = 'v1' | 'v2';
/** Backend Services asks for `system/` scopes; a standalone patient launch asks for `patient/` scopes. */
export type ScopeContext = 'system' | 'patient';

const RESOURCE_TYPE = /^[A-Z][A-Za-z]{0,63}$/;
const MAX_SCOPE_CHARS = 16_384;
const MAX_OVERRIDES = 64;

const READ_ONLY = { v2: /^(system|patient)\/([A-Z][A-Za-z]{0,63})\.(rs|r|s)$/, v1: /^(system|patient)\/([A-Z][A-Za-z]{0,63})\.(read)$/ } as const;

function interactionsOf(permission: string): GrantedInteraction[] {
  if (permission === 'read') return ['read', 'search'];
  const out: GrantedInteraction[] = [];
  if (permission.includes('r')) out.push('read');
  if (permission.includes('s')) out.push('search');
  return out;
}

/** One read-only scope per served type, in registry order: `<context>/<Type>.rs` (v2) or `.read` (v1). */
export function requestedScopes(context: ScopeContext, servedTypes: readonly string[], syntax: ScopeSyntax): string[] {
  return servedTypes.map(type => `${context}/${type}.${syntax === 'v2' ? 'rs' : 'read'}`);
}

/**
 * Operator scope overrides follow a read-only grammar: the configured context only, a served resource type
 * (no wildcards), and only read permissions in the configured syntax (no write letters, no `user/`, no parameters).
 */
export function validateScopeOverrides(scopes: unknown, context: ScopeContext, syntax: ScopeSyntax, servedTypes: readonly string[]): string[] {
  const served = new Set(servedTypes);
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > MAX_OVERRIDES || new Set(scopes).size !== scopes.length) {
    throw fault('INVALID_CONFIG', 'SMART scope configuration is invalid.');
  }
  for (const scope of scopes) {
    const match = typeof scope === 'string' ? READ_ONLY[syntax].exec(scope) : null;
    if (!match || match[1] !== context || !served.has(match[2]!)) {
      throw fault('INVALID_CONFIG', 'SMART scopes must be read-only scopes for served resource types in the configured context and syntax.');
    }
  }
  return [...scopes] as string[];
}

/** What a token response's `scope` grants, judged against what was requested. */
export interface GrantAssessment {
  /** Canonical form (sorted, unique tokens); a different value is a grant change. */
  readonly scope: string;
  /** Read-only permissions in the requested context, per served type. Parameterised scopes grant nothing. */
  readonly permits: ReadonlyMap<string, ReadonlySet<GrantedInteraction>>;
  /** Something beyond the request was granted, read-only (for example `system/*.read`). Accepted with a warning. */
  readonly broader: boolean;
  /** Some requested permission was not granted; calls needing it are refused before sending. */
  readonly narrower: boolean;
}

/**
 * Parses a granted `scope`. A missing scope is an invalid token response. Any scope that could permit a write
 * (`c`, `u` or `d`, v1 `write` or `*`), or a resource scope that cannot be interpreted, refuses the whole grant.
 * Only scopes in the requested context grant permissions; scopes with `?` parameters count as not granted.
 */
export function assessGrant(scope: unknown, requested: readonly string[], context: ScopeContext, servedTypes: readonly string[]): GrantAssessment {
  const text: string | undefined = typeof scope === 'string' ? scope : undefined;
  if (text === undefined) throw fault('INVALID_TOKEN_RESPONSE', 'Token response does not state the granted scope.');
  if (text.length > MAX_SCOPE_CHARS) throw fault('INVALID_TOKEN_RESPONSE', 'Token response scope is invalid.');
  const tokens = [...new Set(text.split(' ').filter(token => token.length > 0))].sort();
  if (tokens.some(token => !SCOPE_TOKEN.test(token))) throw fault('INVALID_TOKEN_RESPONSE', 'Token response scope is invalid.');

  const served = new Set(servedTypes);
  const permits = new Map<string, Set<GrantedInteraction>>();
  let broader = false;
  for (const token of tokens) {
    const prefix = /^(patient|user|system)\//.exec(token);
    if (!prefix) continue; // launch context, offline_access and identity scopes carry no resource permission
    const match = /^(patient|user|system)\/([^.?]+)\.([^?]*)(\?.*)?$/.exec(token);
    const type = match?.[2];
    const permission = match?.[3] ?? '';
    const v1 = permission === 'read' || permission === 'write' || permission === '*';
    if (!match || (type !== '*' && !RESOURCE_TYPE.test(type!)) || (!v1 && !/^c?r?u?d?s?$/.test(permission)) || permission === '') {
      throw fault('POLICY_DENIED', 'Token grant contains a resource scope that cannot be interpreted.');
    }
    const write = v1 ? permission !== 'read' : /[cud]/.test(permission);
    if (write) throw fault('POLICY_DENIED', 'Token grant includes write permission.');
    if (match[4] !== undefined) continue;
    if (match[1] !== context) { broader = true; continue; }
    const types = type === '*' ? servedTypes : served.has(type!) ? [type!] : [];
    if (type === '*' || types.length === 0) broader = true;
    for (const one of types) {
      const set = permits.get(one) ?? new Set<GrantedInteraction>();
      for (const interaction of interactionsOf(permission)) set.add(interaction);
      permits.set(one, set);
    }
  }

  const wanted = new Map<string, Set<GrantedInteraction>>();
  for (const one of requested) {
    const match = /^(?:system|patient)\/([A-Za-z]+)\.(rs|r|s|read)$/.exec(one);
    if (!match) continue;
    const set = wanted.get(match[1]!) ?? new Set<GrantedInteraction>();
    for (const interaction of interactionsOf(match[2]!)) set.add(interaction);
    wanted.set(match[1]!, set);
  }
  let narrower = false;
  for (const [type, interactions] of wanted) for (const interaction of interactions) if (!permits.get(type)?.has(interaction)) narrower = true;
  for (const [type, interactions] of permits) for (const interaction of interactions) if (!wanted.get(type)?.has(interaction)) broader = true;
  return { scope: tokens.join(' '), permits, broader, narrower };
}

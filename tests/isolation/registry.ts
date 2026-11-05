/** Executable scenario contracts. Display titles never establish independence. */
export const SCENARIO_CONTRACTS = {
  "B2-SEL-01": {
    "decision": "refuse conflicting caller patient",
    "goal": "substitute B for trusted A",
    "oracle": "pre-send",
    "outcome": "POLICY_DENIED",
    "predicate_id": "b2.sel-01.terminal",
    "fault": "Bypass refuse conflicting caller patient"
  },
  "B2-SEL-02": {
    "decision": "refuse conflicting subject on subject-only source",
    "goal": "replace subject-bound authority",
    "oracle": "pre-send",
    "outcome": "POLICY_DENIED",
    "predicate_id": "b2.sel-02.terminal",
    "fault": "Bypass refuse conflicting subject on subject-only source"
  },
  "B2-SEL-03": {
    "decision": "validate every Patient _id alternative",
    "goal": "probe B via Patient search",
    "oracle": "pre-send",
    "outcome": "POLICY_DENIED",
    "predicate_id": "b2.sel-03.terminal",
    "fault": "Bypass validate every Patient _id alternative"
  },
  "B2-SEL-04": {
    "decision": "refuse bare clinical reference IDs",
    "goal": "bypass reference target admission",
    "oracle": "pre-send",
    "outcome": "POLICY_DENIED",
    "predicate_id": "b2.sel-04.terminal",
    "fault": "Bypass refuse bare clinical reference IDs"
  },
  "B2-SEL-05": {
    "decision": "refuse bare Patient link selector",
    "goal": "probe B relationship by bare link",
    "oracle": "pre-send",
    "outcome": "POLICY_DENIED",
    "predicate_id": "b2.sel-05.terminal",
    "fault": "Bypass refuse bare Patient link selector"
  },
  "B2-SEL-06": {
    "decision": "bound OR alternatives and inspect final member",
    "goal": "hide foreign target after OR bound",
    "oracle": "pre-send",
    "outcome": "INVALID_ARGUMENTS,POLICY_DENIED",
    "predicate_id": "b2.sel-06.terminal",
    "fault": "Bypass bound OR alternatives and inspect final member"
  },
  "B2-SEL-15": {
    "decision": "deny conditional Patient references",
    "goal": "probe identity through conditional selector",
    "oracle": "pre-send",
    "outcome": "POLICY_DENIED",
    "predicate_id": "b2.sel-15.terminal",
    "fault": "Bypass deny conditional Patient references"
  },
  "B2-SEL-16": {
    "decision": "recognize encoded conditional Patient reference",
    "goal": "evade selector gate with nested percent encoding",
    "oracle": "pre-send",
    "outcome": "POLICY_DENIED",
    "predicate_id": "b2.sel-16.terminal",
    "fault": "Bypass recognize encoded conditional Patient reference"
  },
  "B2-SEL-19": {
    "decision": "distinguish escaped comma from escaped backslash separator",
    "goal": "hide alternative overflow through escape confusion",
    "oracle": "pre-send",
    "outcome": "INVALID_ARGUMENTS,POLICY_DENIED",
    "predicate_id": "b2.sel-19.terminal",
    "fault": "Bypass distinguish escaped comma from escaped backslash separator"
  },
  "B2-SEL-23": {
    "decision": "deny declared reverse joins",
    "goal": "probe foreign Observation relationship on directory search",
    "oracle": "pre-send",
    "outcome": "UNSUPPORTED_SEARCH",
    "predicate_id": "b2.sel-23.terminal",
    "fault": "Bypass deny declared reverse joins"
  },
  "B2-SEL-24": {
    "decision": "deny source-advertised chains",
    "goal": "infer foreign organization relationships",
    "oracle": "pre-send",
    "outcome": "UNSUPPORTED_SEARCH",
    "predicate_id": "b2.sel-24.terminal",
    "fault": "Bypass deny source-advertised chains"
  },
  "B2-SEL-25": {
    "decision": "deny caller include shaping",
    "goal": "bring foreign included records into output",
    "oracle": "pre-send",
    "outcome": "UNSUPPORTED_SEARCH",
    "predicate_id": "b2.sel-25.terminal",
    "fault": "Bypass deny caller include shaping"
  },
  "B2-SEL-33": {
    "decision": "deny declared filter control",
    "goal": "execute unreviewed shared record predicate",
    "oracle": "pre-send",
    "outcome": "UNSUPPORTED_SEARCH",
    "predicate_id": "b2.sel-33.terminal",
    "fault": "Bypass deny declared filter control"
  },
  "B2-HPP-01": {
    "decision": "encode each search pair exactly once",
    "goal": "inject second patient pair through a value",
    "oracle": "non-execution",
    "outcome": "success:exact ordered pairs",
    "predicate_id": "b2.hpp-01.terminal",
    "fault": "Bypass encode each search pair exactly once"
  },
  "B2-HPP-02": {
    "decision": "reject pollution in parameter name",
    "goal": "smuggle foreign confinement via name delimiter",
    "oracle": "pre-send",
    "outcome": "UNSUPPORTED_SEARCH,SEARCH_PARAMETER_UNRESOLVED",
    "predicate_id": "b2.hpp-02.terminal",
    "fault": "Bypass reject pollution in parameter name"
  },
  "B2-PTH-07": {
    "decision": "validate logical ID grammar",
    "goal": "escape read path with separators",
    "oracle": "pre-send",
    "outcome": "INVALID_ARGUMENTS",
    "predicate_id": "b2.pth-07.terminal",
    "fault": "Bypass validate logical ID grammar"
  },
  "B2-PTH-09": {
    "decision": "validate resource type grammar",
    "goal": "escape source through resource type",
    "oracle": "pre-send",
    "outcome": "INVALID_ARGUMENTS,UNSUPPORTED_RESOURCE",
    "predicate_id": "b2.pth-09.terminal",
    "fault": "Bypass validate resource type grammar"
  },
  "B2-PTH-11": {
    "decision": "reject undeclared tool fields",
    "goal": "supply arbitrary URL headers method path or body",
    "oracle": "pre-send",
    "outcome": "INVALID_ARGUMENTS",
    "predicate_id": "b2.pth-11.terminal",
    "fault": "Bypass reject undeclared tool fields"
  },
  "B2-PTH-16": {
    "decision": "expose implemented read-only tools only",
    "goal": "invoke write ingestion or HTTP tool",
    "oracle": "pre-send",
    "outcome": "UNKNOWN_TOOL,SDK_TOOL_ERROR",
    "predicate_id": "b2.pth-16.terminal",
    "fault": "Bypass expose implemented read-only tools only"
  },
  "B2-PTH-01": {
    "decision": "refuse dot-only read IDs without work",
    "goal": "normalize read into parent or base path",
    "oracle": "pre-send",
    "outcome": "NOT_FOUND",
    "predicate_id": "b2.pth-01.terminal",
    "fault": "Bypass refuse dot-only read IDs without work"
  },
  "B2-PTH-03": {
    "decision": "bind all public tools to configured alias",
    "goal": "select foreign source alias",
    "oracle": "pre-send",
    "outcome": "POLICY_DENIED,INVALID_ARGUMENTS",
    "predicate_id": "b2.pth-03.terminal",
    "fault": "Bypass bind all public tools to configured alias"
  },
  "B2-CNT-01": {
    "decision": "validate continuation origin independently of path",
    "goal": "send page request to foreign in-base path",
    "oracle": "continuation",
    "outcome": "safe-prefix partial without cursor",
    "predicate_id": "b2.cnt-01.terminal",
    "fault": "Bypass validate continuation origin independently of path"
  },
  "B2-CNT-02": {
    "decision": "retain patient pair on continuation",
    "goal": "drop patient constraint on second page",
    "oracle": "continuation",
    "outcome": "safe-prefix partial without cursor",
    "predicate_id": "b2.cnt-02.terminal",
    "fault": "Bypass retain patient pair on continuation"
  },
  "B2-CNT-06": {
    "decision": "retain Patient _id on continuation",
    "goal": "enumerate Patient outside immutable binding",
    "oracle": "continuation",
    "outcome": "safe-prefix partial without cursor",
    "predicate_id": "b2.cnt-06.terminal",
    "fault": "Bypass retain Patient _id on continuation"
  },
  "B2-CNT-12": {
    "decision": "confine next link to exact base path",
    "goal": "follow sibling API path",
    "oracle": "continuation",
    "outcome": "safe-prefix partial without cursor",
    "predicate_id": "b2.cnt-12.terminal",
    "fault": "Bypass confine next link to exact base path"
  },
  "B2-PTH-02": {
    "decision": "reject encoded separators in page links",
    "goal": "normalize encoded traversal into source admin",
    "oracle": "continuation",
    "outcome": "safe-prefix partial or UNSAFE_URL",
    "predicate_id": "b2.pth-02.terminal",
    "fault": "Bypass reject encoded separators in page links"
  },
  "B2-CNT-16": {
    "decision": "never follow authenticated redirects",
    "goal": "exfiltrate bearer to live sink",
    "oracle": "continuation",
    "outcome": "UNSAFE_REDIRECT,NOT_FOUND",
    "predicate_id": "b2.cnt-16.terminal",
    "fault": "Bypass never follow authenticated redirects"
  },
  "B2-CNT-22": {
    "decision": "reauthorize opaque rebound pages and keep uncertainty sticky",
    "goal": "deliver B rows or falsely prove opaque terminal chain",
    "oracle": "continuation",
    "outcome": "empty rebound page and explicit unverified reason",
    "predicate_id": "b2.cnt-22.terminal",
    "fault": "Bypass reauthorize opaque rebound pages and keep uncertainty sticky"
  },
  "B2-CNT-23": {
    "decision": "refuse explicit opaque conflicting confinement",
    "goal": "override A via opaque next link pair",
    "oracle": "continuation",
    "outcome": "safe-prefix partial without cursor",
    "predicate_id": "b2.cnt-23.terminal",
    "fault": "Bypass refuse explicit opaque conflicting confinement"
  },
  "B2-CUR-04": {
    "decision": "bind clinical cursor to its own gateway store",
    "goal": "replay A cursor in B process and reverse",
    "oracle": "locator",
    "outcome": "RESULT_EXPIRED",
    "predicate_id": "b2.cur-04.terminal",
    "fault": "Bypass bind clinical cursor to its own gateway store"
  },
  "B2-HND-01": {
    "decision": "bind retained result to its own gateway store",
    "goal": "project A handle in B process and reverse",
    "oracle": "locator",
    "outcome": "RESULT_EXPIRED",
    "predicate_id": "b2.hnd-01.terminal",
    "fault": "Bypass bind retained result to its own gateway store"
  },
  "B2-CUR-06": {
    "decision": "freeze cursor query against extra fields",
    "goal": "alter page request query after capture",
    "oracle": "pre-send",
    "outcome": "INVALID_ARGUMENTS",
    "predicate_id": "b2.cur-06.terminal",
    "fault": "Bypass freeze cursor query against extra fields"
  },
  "B2-CUR-09": {
    "decision": "separate discovery cursor from clinical cursor",
    "goal": "replay public discovery locator through page tool",
    "oracle": "locator",
    "outcome": "executed:discovery cursor separation",
    "predicate_id": "b2.cur-09.terminal",
    "fault": "Bypass separate discovery cursor from clinical cursor"
  },
  "B2-CUR-10": {
    "decision": "separate discovery result from clinical handle",
    "goal": "replay discovery locator through result tool",
    "oracle": "locator",
    "outcome": "executed:discovery cursor separation",
    "predicate_id": "b2.cur-10.terminal",
    "fault": "Bypass separate discovery result from clinical handle"
  },
  "B2-HND-03": {
    "decision": "enforce locator kind prefix",
    "goal": "exchange cursor and result authority",
    "oracle": "pre-send",
    "outcome": "RESULT_EXPIRED",
    "predicate_id": "b2.hnd-03.terminal",
    "fault": "Bypass enforce locator kind prefix"
  },
  "B2-CUR-08": {
    "decision": "enforce immutable context handle",
    "goal": "rebind cursor or search to forged context",
    "oracle": "pre-send",
    "outcome": "CONTEXT_REQUIRED",
    "predicate_id": "b2.cur-08.terminal",
    "fault": "Bypass enforce immutable context handle"
  },
  "B2-CLS-01": {
    "decision": "uniformize foreign read and missing read",
    "goal": "distinguish existence through public envelope",
    "oracle": "uniform-read",
    "outcome": "NOT_FOUND:equal public twins",
    "predicate_id": "b2.cls-01.terminal",
    "fault": "Bypass uniformize foreign read and missing read"
  },
  "B2-CLS-03": {
    "decision": "require all Patient references to bind A",
    "goal": "deliver composite with B performer or suppression caveat",
    "oracle": "suppression",
    "outcome": "NOT_FOUND and empty search; equal caveat twin",
    "predicate_id": "b2.cls-03.terminal",
    "fault": "Bypass require all Patient references to bind A"
  },
  "B2-CLS-23": {
    "decision": "require primary subject linkage",
    "goal": "borrow A secondary reference for missing unbound or B primary",
    "oracle": "suppression",
    "outcome": "NOT_FOUND and empty search",
    "predicate_id": "b2.cls-23.terminal",
    "fault": "Bypass require primary subject linkage"
  },
  "B2-CLS-02": {
    "decision": "refuse contained Patient identities",
    "goal": "smuggle Patient data including A ID in contained body",
    "oracle": "suppression",
    "outcome": "NOT_FOUND and empty search",
    "predicate_id": "b2.cls-02.terminal",
    "fault": "Bypass refuse contained Patient identities"
  },
  "B2-CLS-19": {
    "decision": "authorize contained clinical resources",
    "goal": "smuggle B Observation via contained reference",
    "oracle": "suppression",
    "outcome": "NOT_FOUND and empty search",
    "predicate_id": "b2.cls-19.terminal",
    "fault": "Bypass authorize contained clinical resources"
  },
  "B2-CLS-04": {
    "decision": "exclude include-mode entries from match delivery",
    "goal": "promote included record to match",
    "oracle": "counts",
    "outcome": "success:one delivered match",
    "predicate_id": "b2.cls-04.terminal",
    "fault": "Bypass exclude include-mode entries from match delivery"
  },
  "B2-NUM-03": {
    "decision": "count matches independently of include entries",
    "goal": "inflate returned match or include counts",
    "oracle": "counts",
    "outcome": "success:one match zero includes",
    "predicate_id": "b2.num-03.terminal",
    "fault": "Bypass count matches independently of include entries"
  },
  "B2-CLS-05": {
    "decision": "validate returned Patient identity",
    "goal": "return B body for A read",
    "oracle": "uniform-read",
    "outcome": "NOT_FOUND",
    "predicate_id": "b2.cls-05.terminal",
    "fault": "Bypass validate returned Patient identity"
  },
  "B2-ERR-05": {
    "decision": "validate exact returned type and ID",
    "goal": "swap requested read body identity",
    "oracle": "uniform-read",
    "outcome": "NOT_FOUND",
    "predicate_id": "b2.err-05.terminal",
    "fault": "Bypass validate exact returned type and ID"
  },
  "B2-REF-01": {
    "decision": "deny unverifiable conditional Patient companions",
    "goal": "retain hidden identity in conditional display or identifier",
    "oracle": "suppression",
    "outcome": "NOT_FOUND and empty search",
    "predicate_id": "b2.ref-01.terminal",
    "fault": "Bypass deny unverifiable conditional Patient companions"
  },
  "B2-REF-02": {
    "decision": "mask Patient.link.other through retained views",
    "goal": "disclose foreign link identity",
    "oracle": "sanitization",
    "outcome": "success:link type preserved other absent",
    "predicate_id": "b2.ref-02.terminal",
    "fault": "Bypass mask Patient.link.other through retained views"
  },
  "B2-NUM-01": {
    "decision": "make suppressed-only page equal empty",
    "goal": "reveal foreign total through counts or caveats",
    "oracle": "counts",
    "outcome": "success:equal empty public twins",
    "predicate_id": "b2.num-01.terminal",
    "fault": "Bypass make suppressed-only page equal empty"
  },
  "B2-NUM-02": {
    "decision": "keep suppression count downgrade sticky across pages",
    "goal": "publish source total after late foreign page",
    "oracle": "counts",
    "outcome": "success:delivered-only terminal counts",
    "predicate_id": "b2.num-02.terminal",
    "fault": "Bypass keep suppression count downgrade sticky across pages"
  },
  "B2-ERR-01": {
    "decision": "uniformize 403 and 404 under concurrent A read",
    "goal": "probe existence through faults handles or work counts",
    "oracle": "uniform-read",
    "outcome": "NOT_FOUND:equal concurrent twins",
    "predicate_id": "b2.err-01.terminal",
    "fault": "Bypass uniformize 403 and 404 under concurrent A read"
  },
  "B2-ERR-02": {
    "decision": "uniformize parse and decoding faults",
    "goal": "reveal malformed foreign body through errors",
    "oracle": "uniform-read",
    "outcome": "NOT_FOUND:equal missing twin",
    "predicate_id": "b2.err-02.terminal",
    "fault": "Bypass uniformize parse and decoding faults"
  },
  "B2-ERR-03": {
    "decision": "uniformize size content and compression faults",
    "goal": "leak body-stage existence distinction",
    "oracle": "uniform-read",
    "outcome": "NOT_FOUND:equal missing twin",
    "predicate_id": "b2.err-03.terminal",
    "fault": "Bypass uniformize size content and compression faults"
  },
  "B2-PAY-01": {
    "decision": "withhold inline attachment bodies and capability URLs",
    "goal": "retain forbidden payload through projections",
    "oracle": "sanitization",
    "outcome": "success:metadata and labelled payload omission",
    "predicate_id": "b2.pay-01.terminal",
    "fault": "Bypass withhold inline attachment bodies and capability URLs"
  },
  "B2-LOG-02": {
    "decision": "keep rejected arguments out of logs",
    "goal": "leak credential or identity through error logging",
    "oracle": "logs",
    "outcome": "INVALID_ARGUMENTS",
    "predicate_id": "b2.log-02.terminal",
    "fault": "Bypass keep rejected arguments out of logs"
  },
  "B2-LOG-05": {
    "decision": "keep denied reference companions out of operational state",
    "goal": "log B companion on read refusal",
    "oracle": "logs",
    "outcome": "NOT_FOUND",
    "predicate_id": "b2.log-05.terminal",
    "fault": "Bypass keep denied reference companions out of operational state"
  },
  "B2-OUT-03": {
    "decision": "reduce upstream outcomes to safe vocabulary",
    "goal": "leak diagnostics details or arbitrary code",
    "oracle": "sanitization",
    "outcome": "safe SOURCE_OUTCOME or UNVERIFIED_QUERY",
    "predicate_id": "b2.out-03.terminal",
    "fault": "Bypass reduce upstream outcomes to safe vocabulary"
  },
  "B2-MET-03": {
    "decision": "omit source documentation globally",
    "goal": "retain metadata prose in discovery cache or output",
    "oracle": "metadata",
    "outcome": "success:reviewed local discovery only",
    "predicate_id": "b2.met-03.terminal",
    "fault": "Bypass omit source documentation globally"
  },
  "B2-MET-08": {
    "decision": "drop hostile source search names before caching",
    "goal": "retain foreign identity in metadata keys",
    "oracle": "metadata",
    "outcome": "success:reviewed names only",
    "predicate_id": "b2.met-08.terminal",
    "fault": "Bypass drop hostile source search names before caching"
  },
  "B2-INJ-02": {
    "decision": "treat instruction-shaped authorized prose as data",
    "goal": "induce patient switch or tool write",
    "oracle": "non-execution",
    "outcome": "success:prose preserved zero induced work",
    "predicate_id": "b2.inj-02.terminal",
    "fault": "Bypass treat instruction-shaped authorized prose as data"
  },
  "B2-INJ-03": {
    "decision": "redact capability URLs in authorized prose",
    "goal": "induce sink request or retain credential URL",
    "oracle": "non-execution",
    "outcome": "success:labelled link omission zero induced work",
    "predicate_id": "b2.inj-03.terminal",
    "fault": "Bypass redact capability URLs in authorized prose"
  },
  "B2-ADM-04": {
    "decision": "prevent source-induced server requests",
    "goal": "invoke sampling roots or elicitation through prose",
    "oracle": "non-execution",
    "outcome": "success:no server methods or induced work",
    "predicate_id": "b2.adm-04.terminal",
    "fault": "Bypass prevent source-induced server requests"
  },
  "B2-BAS-01": {
    "decision": "validate entry fullUrl before relative linkage",
    "goal": "treat foreign-base relative Patient A as locally authorized",
    "oracle": "suppression",
    "outcome": "success:foreign entry suppressed",
    "predicate_id": "b2.bas-01.terminal",
    "fault": "Bypass validate entry fullUrl before relative linkage"
  },
  "B2-XRF-01": {
    "decision": "refuse unverified non-Patient clinical target selectors",
    "goal": "distinguish foreign Encounter existing versus missing",
    "oracle": "pre-send",
    "outcome": "POLICY_DENIED",
    "predicate_id": "b2.xrf-01.terminal",
    "fault": "Bypass refuse unverified non-Patient clinical target selectors"
  },
  "B2-REF-11": {
    "decision": "mask all bound Patient reference companions",
    "goal": "carry B display or identifier on Patient A reference",
    "oracle": "sanitization",
    "outcome": "success:Patient companions omitted Practitioner display kept",
    "predicate_id": "b2.ref-11.terminal",
    "fault": "Bypass mask all bound Patient reference companions"
  },
  "B2-SHR-05": {
    "decision": "deny configured patient identifier system on Practitioner",
    "goal": "deliver patient-system identity from shared record",
    "oracle": "sanitization",
    "outcome": "success:directory identity kept patient identifier omitted",
    "predicate_id": "b2.shr-05.terminal",
    "fault": "Bypass deny configured patient identifier system on Practitioner"
  },
  "B2-SHR-06": {
    "decision": "mask Organization alias symmetrically",
    "goal": "deliver protected alias as shared prose",
    "oracle": "sanitization",
    "outcome": "success:name kept alias omitted with label",
    "predicate_id": "b2.shr-06.terminal",
    "fault": "Bypass mask Organization alias symmetrically"
  },
  "B2-SHR-17": {
    "decision": "mask Location description symmetrically",
    "goal": "deliver protected facility description",
    "oracle": "sanitization",
    "outcome": "success:name kept description omitted with label",
    "predicate_id": "b2.shr-17.terminal",
    "fault": "Bypass mask Location description symmetrically"
  },
  "B2-DIR-01": {
    "decision": "deny configured patient identifier system on Organization",
    "goal": "deliver patient-system identity via directory organization",
    "oracle": "sanitization",
    "outcome": "success:directory identity kept patient identifier omitted",
    "predicate_id": "b2.dir-01.terminal",
    "fault": "Bypass deny configured patient identifier system on Organization"
  }
} as const;

const features: Record<string, string> = {};
function assign(ids: string, feature: string) { for (const id of ids.split(' ')) features[`B2-${id}`] = feature; }
assign('SEL-01 SEL-02', 'arg:patient-selector');
assign('SEL-04 SEL-05 XRF-01', 'arg:reference-selector');
assign('SEL-06', 'arg:comma'); assign('SEL-15 SEL-16', 'arg:percent'); assign('SEL-19', 'arg:backslash');
assign('SEL-23 SEL-24 SEL-25 SEL-33', 'arg:directory-name');
assign('HPP-01', 'arg:pollution-punctuation'); assign('HPP-02', 'arg:code-parameter');
assign('PTH-07 PTH-01', 'arg:dotted-hyphenated-id'); assign('PTH-03', 'arg:source-alias');
assign('CNT-01 CNT-02 CNT-06 CNT-12 CNT-16 CNT-22 CNT-23 PTH-02 CUR-04 CUR-06 CUR-08 HND-03', 'response:next-cursor');
assign('HND-01 CUR-09 CUR-10', 'response:retained-handle');
assign('SEL-03 CLS-05 REF-02', 'response:active-patient');
assign('CLS-02 CLS-19', 'response:contained-resource');
assign('CLS-03 CLS-23 REF-01 REF-11 LOG-05', 'response:performer');
assign('CLS-04 NUM-01 NUM-02 NUM-03', 'response:match-count');
assign('PAY-01', 'response:attachment'); assign('OUT-03', 'response:source-outcome');
assign('MET-03 MET-08', 'response:reviewed-discovery');
assign('INJ-02 INJ-03 ADM-04', 'response:note');
assign('SHR-05 DIR-01', 'response:directory-identifier'); assign('SHR-06 SHR-17', 'response:directory-name');
assign('CLS-01 PTH-09 PTH-11 PTH-16 ERR-01 ERR-02 ERR-03 ERR-05 LOG-02 BAS-01', 'response:patient-reference');
export function overblockingFeature(id: string): string {
  if (!features[id]) throw new Error(`missing per-case overblocking feature: ${id}`);
  return features[id]!;
}

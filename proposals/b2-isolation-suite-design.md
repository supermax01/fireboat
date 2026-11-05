# B2 isolation suite: round-2 design and implementation handoff

Design only, 2026-10-19. GPT is the design partner; Claude is root for this round. Root assigns implementer and exact path ownership. This revision edits only this design and appends the response document. No code, competitor execution, tests, mutation run, commit or push is part of this round.

Contract: [PLAN revision 0.4 and agreed amendments](../PLAN.md), [CONSENSUS](CONSENSUS.md), [M3b specification](m3b-spec.md) and [integration plan](m3b-integration-plan.md). The request calls the contract “0.4.1”; the inspected PLAN header still says **0.4**. This document applies that file's agreed A1/A7 restrictions; it does not create a new PLAN revision. Research/11 B2 and B3 remain separate gates. [Claude's complete review](audit/claude-b2-design-review.md) is the round-2 input.

Inspection baseline: `a2e16f26c9b0b83ec93e2983bf4073d829f105a7`. File:line anchors below refer to that checkout. Mapped evidence means source assertions inspected, never rerun/qualified evidence. The proposed independent denominator is **216**, with **49 mapped existing shapes and 167 requiring new scenario assertions**. The earned, executed B2 denominator remains **0**.

## 1. Threat model, pass rule and frozen boundaries

One local stdio process binds one immutable trusted synthetic Patient A and one literal-loopback FHIR source. B and C are foreign synthetic patients. The upstream grant deliberately includes A/B/C so backend ACLs cannot conceal gateway defects. A second independently bound process provides cross-store challenges; this is not a multipatient gateway. Attackers control model arguments and malicious source resources, metadata, errors, links and response scheduling, but not trusted configuration or the verifier. The local OS user replacing the binary/reading memory is outside scope.

Only implemented `fhir_capabilities`, `fhir_search`, `fhir_read`, `fhir_page`, `fhir_result` are exposed. Qualification targets schema 0.2 after S5, over actual SDK stdio in both `2026-07-28` and `2025-11-25`; core observations supplement it. Unsupported history/operations/remote HTTP/SSE/SMART are denied surfaces, not compatibility claims.

**Pass rule unchanged:** at least 200 meaningful, manifested, executed applicable independent attack/control cases; zero detected prohibited disclosures or clinical mutations; every required authorized control passes; every designated critical guard mutant validly killed; every applicable matrix cell covered; no unresolved applicable high/critical defect. Failures, pending, skipped, crashed, unsupported or inconclusive cases remain visible and cannot be dropped to get 200 green cases. A first slice or mapped test inventory never passes B2.

### Decidable disclosure and revocation classes

A prohibited disclosure identifies, locates or distinguishes protected B/C data outside the frozen authorized boundary, or exposes a credential, payload or capability link forbidden by the contract. Structured foreign identity is prohibited in resources, References, Identifiers, HumanNames/displays associated with a foreign identity, metadata, errors, provenance, omission paths and locators. This is a known-fixture structured-identity/canary oracle, not a general semantic identity detector.

Also prohibited: **evidence fetched under, or retained from, an invalidated credential/policy generation that is delivered, retained or audited as allowed after invalidation**. Cancelled/closed/expired authority likewise must not produce a late commitment where the contract requires invalidation. Mere loss of fresh work or duplicate fetch without disclosure is B3/robustness, not B2. This distinction removes additional weak round-1 rows below.

| Channel | Decision rule |
| --- | --- |
| MCP output | Scan raw frames, all text/content items, structured content, errors and metadata. Unexpected embedded resources, resource links or extra items fail. Bind facts/citations and controls to the exact response, including retained follow-ups. |
| Operational logs | stdout contains protocol frames only. stderr/console/SDK/startup/crash logs contain no bodies, patient IDs (A included), query text, notes, credentials or capability URLs. Reports use marker IDs, never matched values. |
| Restricted local audit | Metadata-only bounded local audit; fixed fields/codes, no bodies/IDs/query/prose/secrets. No tool returns audit. Undelivered/cancelled work cannot be audited allowed. No remote/durable ledger claim. |
| State and locators | No forbidden material in deliverable snapshots, blobs, overlays, discovery caches or pending/reserved commitments; no cross-store/kind/context/epoch recovery or resurrection. Transient parser buffers are not retained results. No OS-memory secrecy claim. |
| Errors/repairs | Fixed safe shapes. Pre-authorization direct-read failures obey NOT_FOUND uniformity, including subsequent state/work. Malformed arguments may differ; timeouts/5xx retain contracted differences. |
| Counts/relationships | Delivered-only counts; no raw upstream totals, suppressed counts/IDs or suppression-dependent caveats. Twins vary only protected evidence while A data and declared page mechanics stay fixed. |
| Timing | Excluded: wall-clock latency, elapsed_ms, scheduling and timeout timing. Record descriptively. Deterministic call counts, destinations, order and post-invalidation commitments remain decidable and required. |

Twin normalization permits only consistent symbolic replacement of random request/handle IDs, timestamps/elapsed_ms and byte differences caused solely by random lengths. Verify real byte ceilings first. Never normalize counts, error classes, reasons, context, calls, expiry duration, cursor presence, citations or query evidence. A hostile source can vary page topology or byte volume by foreign population: these are declared residual signals with honest partialness tests, not an indistinguishability claim.

### D1 — Prose/shared policy: adopted, with explicit field boundaries

A-linked free text (notes, conclusions, CodeableConcept.text, dosage text, Patient.contact prose) is A's authorized record content. Family-history mentions and injection-shaped canaries there are **positive controls**, preserved except existing narrative, URL and payload rules. Structured foreign identity is still prohibited; a label saying “A-linked” does not authorize a Reference to Patient/B. No serving code may match synthetic canary values or silently semantically redact ordinary A prose.

Shared records require the versioned structural policy, configured patient-identifier-system denial and no Patient/RelatedPerson references. The fixed additional omission list is `Organization.alias`, `Location.alias`, `Location.description`, `Location.availabilityExceptions`, `Medication.code.text`. Withhold these with labelled omissions even for benign prose. CodeSystem/ValueSet source documentation is governed by D2. These are proposed privacy-owner changes, not implemented guarantees.

The frozen **operator-attested directory residual field list** is: `Organization.{name,type.text,type.coding.display,telecom,address}`, `Practitioner.{name,telecom,address,gender,birthDate,qualification,communication}`, `Location.{name,address,telecom,hoursOfOperation,type.text,type.coding.display,physicalType.text,physicalType.coding.display}`, `Medication.{code.coding.display,form,ingredient.itemCodeableConcept}` and catalog `CodeSystem.concept.display`, `ValueSet.{compose.include.concept.display,expansion.contains.display}`. Only their structurally permitted scalar content is residual; any nested Reference/Identifier and source documentation remains subject to the structural/D2 rules. All other unclassified fields are denied or withheld, not implicitly attested. Semantic privacy of these listed fields is not claimed.

Withhold `display` and `identifier` on **every Patient-typed reference**, including A; the literal verified A reference may remain. REF-11 merges both companion vectors into one mask decision. The authorized Patient read supplies A identity. Until implemented, these are visible expected failures, not residual waivers.

### D2 — Source documentation: adopted globally

Source-authored documentation/description/comment/purpose/copyright/publisher contact must never be emitted or stored, including logs, cached metadata, snapshots, direct reads and repairs. Temporary ingress buffers are not retained metadata. Echoed search names use `^_?[A-Za-z][A-Za-z0-9_-]{0,79}$`; echoed interactions must be R4 restful-interaction codes. Drop invalid strings without echo and report only safe counts/causes.

Direct read/search of CapabilityStatement, SearchParameter, OperationDefinition and StructureDefinition is decided against in patient-bound mode (`UNSUPPORTED_RESOURCE`, support-matrix row). Local reviewed schema/parameter discovery remains available. CodeSystem/ValueSet stay structurally shared with source prose withheld and labelled. Normalized revision is S2; MET-10 is not counted toward B2.

### D3 — Opaque continuation: adopted

HAPI root `_getpages` is the only opaque exception. Pre-send confinement covers every gateway-constructed ordinary request; opaque query binding belongs to the source, and confidentiality rests on per-resource reauthorization. Origin/base/userinfo/fragment checks and explicit-pair conflict checks still apply. Non-root `_getpages`, ct/_page_token/pageContext and other opaque forms are non-continuable without a separately tested adapter.

CNT-22 requires zero B output/retention under hostile token rebinding, delivered-only counts, `CONTINUATION_QUERY_UNVERIFIED` on **every** opaque page, and never `complete_for_query`, even at termination. CNT-23 checks explicit conflict refusal before send. A token ledger is an independent fixture oracle, not a claim the gateway decoded the token. Do not claim a visible patient pair on every opaque request. Binding this exception to a tested closed HAPI identity is optional later hardening, not widened generic support.

### Independence and near-twin controls

The signature is `(primary decision point, adversarial goal, protected element class, state transition)`. A distinct row needs a different reachable branch, parser stage, **specific policy-table entry**, or state transition and a plausible single-point weakening that discriminates it from siblings. A table-row obligation also needs a type-specific trap. Renaming types/fields, encodings, patients, projection, era, profile, retry or budget alone does not count. Every row below names its decision/attack and control; executable expansion must bind the signature to source anchors and a fault intent. Collisions fail loading unless a reviewer documents a distinct decision and discriminating witness. A new runtime policy rule is a proposed decision, never evidence that it already exists or is killable.

Controls keep the same tool, metadata/source state, pair structure, encoding, framing and structural feature wherever supported; swap only protected target/system or the minimal invalid feature. Unsupported surfaces use a supported neighboring operation **plus** a symmetric benign unsupported vector, never invent success on unimplemented history/contained types. Nontrivial A facts/citations/counts are required. A deny-all stub must fail; strengthened guards that block all params/percent signs/commas/backslashes/next links/shared records must each fail relevant controls. The exact generic-r4 HbA1c query remains an admitted control with unknown filter/order execution, not a proof-based refusal.

## 2. Frozen v1 catalogue (design freeze, not executable acceptance)

IDs are immutable within this revision. `*` marks a mapped existing assertion shape, with limitations in §3; unstarred means a new scenario assertion is required, not that no related test exists. Format/era/profile/tool-route variants are cells of one case. All cases use independent oracle O: raw target and ordered-pair/destination/method/credential-fingerprint recorder, entire output/log/audit scans, structural retained-state observation and clinical mutation journal/digest. It imports no gateway policy/sanitizer/query/projection helpers. Every off-origin or /admin target is an instrumented loopback sink. Every refusal separates metadata/auth work from zero clinical work.

Common outcomes are exact schema-pinned pre-send refusal (no clinical request/commit), uniform NOT_FOUND, authorized-only suppression with fixed caveat, safe-prefix non-continuable partial, or unavailable locator. Freeze exact expected codes/0.2 fields after S5; arbitrary errors do not count as security success. Every table control must deliver its stated useful evidence or prove its supported-neighbor/symmetric-refusal obligation. No rows below are tests run in this round.

### SEL (33 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| SEL-01* | patient selector conflicts with trusted A; patient-confinement decision | same patient parameter=A; append trusted pair anyway |
| SEL-02* | subject-only source selector conflicts; subject-confinement decision | subject=A on the same source |
| SEL-03* | Patient _id=B or A,B; Patient target decision | unfiltered Patient search; generated _id=A |
| SEL-04* | bare foreign ID on Patient-capable performer; typed-reference lexical admission | explicit permitted Practitioner/p1 with same parameter |
| SEL-05* | Patient.link bare foreign ID; R4 target-resolution table entry | same link parameter with explicit Patient/A |
| SEL-06* | OR overflow or foreign last admitted alternative; bounded split result | 33 bound-only alternatives, same parameter |
| SEL-08 | Patient reference on code token; token/reference type distinction | valid token on same code parameter, same escape grammar |
| SEL-09 | polymorphic Group/Patient selector cannot select a different compartment | explicit permitted target on same polymorphic parameter |
| SEL-10 | same-source absolute Patient/B; absolute-reference identity | same absolute base with Patient/A |
| SEL-11 | bound ID on foreign origin; origin comparison | same reference with configured origin |
| SEL-12 | same-origin Patient/A outside FHIR base; base containment | same origin and reference inside configured base |
| SEL-13 | versioned foreign Patient selector; selector version parsing | Patient/A/_history/1 where typed selector support permits it, otherwise paired explicit A plus symmetric unsupported-version check |
| SEL-14 | source target/type conflicts with pinned Patient target; resolved target authority | identical canonical and value with nonconflicting target declaration |
| SEL-15 | conditional Patient?identifier target; conditional-reference rejection | explicit local Patient/A; preserve conditional punctuation in a separate permitted token control |
| SEL-16 | encoded Patient type hidden by decoding; decoding boundary | same encoding depth in a non-reference literal token, plus explicit A reference |
| SEL-18 | encoded comma must not become a second foreign alternative; URL/list boundary | encoded literal comma in a permitted token arrives once, byte-exact |
| SEL-19 | escaped comma versus OR; token escape parser | same token with legal escaped comma, exact outbound pair |
| SEL-20 | lone/trailing escape must not turn failed parsing into empty alternatives | same token with completed legal escape |
| SEL-21 | Patient path case variant cannot bypass patient identity | case-exact Patient/A; same ID |
| SEL-22 | hostile source advertises case-alias selector name; exact-name policy | reviewed exact name, same bound value |
| SEL-23 | source-declared reverse chain including Practitioner relationship inference | ordinary declared parameter on same shared type, same pair envelope |
| SEL-24 | source-declared forward chain; chain syntax decision | unchained reviewed reference parameter, same authorized target |
| SEL-25 | source-declared include/revinclude family; join admission | ordinary declared pair on same type, no join |
| SEL-27 | source-declared _contained; resource-expansion control decision | same search without expansion, contained-free authorized match |
| SEL-29 | source-declared :identifier modifier; logical Patient target | unmodified typed bound reference |
| SEL-30 | source-declared _query (and _type vector); named/control search decision | ordinary reviewed parameter, same resource type |
| SEL-31 | conflicting duplicate definitions cannot create executable Patient selector | same two declarations made identical, typed A target |
| SEL-32 | same-name caller pair cannot replace gateway confinement; ownership latch | caller A pair retained plus separately appended trusted pair |
| SEL-33 | source-declared _filter hides foreign predicate in opaque expression | reviewed ordinary code filter with same encoded punctuation as a literal token |
| SEL-34 | source-declared _list uses a foreign clinical List membership test | ordinary reviewed directory/patient parameter on same type; no list evaluation |
| SEL-35 | unresolved reference canonical with bare B target; resolution-failure admission | pinned resolved canonical and explicit permitted target |
| SEL-36 | two canonical definitions disagree on reference targets; canonical conflict gate | two identical definitions and same authorized reference |
| SEL-37 | invalid source type must not downgrade reference checks to untyped token | valid reference declaration and explicit authorized target |

### PTH (7 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| PTH-01* | literal . or .. passes ID grammar but must not become a route | legal dotted obs-a.1-x; zero clinical work for dot-only ID |
| PTH-02* | encoded separators/dots/backslash in transport self link; URL validator | same self link with normal in-base path and exact pairs |
| PTH-03* | source alias substitution, including URL-looking alias | configured alias across the same three tools |
| PTH-07 | read-ID grammar rejects delimiter, slash, comma and authority vectors | same call with legal dotted/hyphenated ID |
| PTH-09 | resource-type grammar rejects URL/route as type | same call with supported Observation |
| PTH-11 | strict unknown-key rule: url/headers/method/path/body | identical call with only unknown keys removed |
| PTH-16 | unknown ingestion/write tool dispatch; no clinical mutation | advertised read tool; backend journal live |

### CNT (15 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| CNT-01* | foreign-origin next, relative/protocol-relative vectors; destination guard | same page and in-base next; instrumented second origin |
| CNT-02* | next drops trusted patient constraint; missing constraint gate | only _count/_offset changes |
| CNT-05* | unrecognized opaque paging forms cannot replace visible confinement | same resource-path continuation retaining all pairs |
| CNT-06* | Patient next drops _id; Patient confinement entry | same next retaining _id=A |
| CNT-09 | next substitutes trusted patient value; constraint multiset equality | same next retaining A |
| CNT-10 | next introduces patient-bearing material selector | same next with only a paging mechanic added |
| CNT-11 | next changes resource endpoint or uses _history/non-root opaque route | same resource endpoint, exact pairs |
| CNT-12 | same-origin sibling-base next targets /admin; base predicate | same next under configured base |
| CNT-14 | next embeds userinfo or fragment; credential/fragment predicate | same URL with offending components removed |
| CNT-16 | next fetch responds 302/307/308; redirect handling before credential forwarding | same page 2 without redirect; sink receives liveness-only probe |
| CNT-18 | multiple competing next relations; cardinality decision | exactly one usable next with same authorized suffix |
| CNT-19 | one case-insensitive next relation has empty/unusable URL; usable-value decision | same relation spelling, usable in-base URL |
| CNT-21 | _cursor token cannot omit patient-bearing original pair | same token and all material pairs |
| CNT-22 | root HAPI token rebound to B; per-record authorization and unverified execution | honest A-bound opaque chain; never complete_for_query |
| CNT-23 | root HAPI opaque link carries explicit conflicting pair | same opaque link with matching explicit A pair |

### CUR (8 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| CUR-01* | expired clinical cur_ lookup cannot return retained evidence | same cursor immediately before absolute expiry |
| CUR-03* | discovery cursor binding/topic/epoch substitution | unchanged topic and binding, same live cursor |
| CUR-04 | cross-store clinical cur_ replay, including tampered missing key | same-store replay; no extra upstream work |
| CUR-06 | fhir_page added source/type/params/patient; page schema boundary | same cursor and output, added keys removed |
| CUR-08 | valid cursor with forged context; context decision | same cursor with own context (and omission control) |
| CUR-09 | discovery cur_ into clinical page; clinical namespace tag | clinical cur_ into same tool |
| CUR-10 | clinical cur_ into discovery; discovery namespace tag | same-kind discovery locator, same topic |
| CUR-13* | replay/page mint must not renew original expiry | identical replay sequence completed before original expiry |

### HND (6 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| HND-01* | other store's res_ cannot authorize inspect/project/page | own store's handle, exact citation and no fetch |
| HND-03 | kind/prefix swap including discovery/res confusion; result-kind gate | correct locator kind, same operation |
| HND-06 | retained backing cannot expose suppressed B resources | same page with only A; nontrivial retained inspect |
| HND-07 | retained projection cannot restore withheld reference companions | same projected paths on permitted Practitioner companion |
| HND-09 | blob deduplication cannot share authority across independently bound stores | byte-identical authorized content in one store, correct overlay |
| HND-12 | expired result handle cannot project data | same projection before absolute expiry |

### CLS (23 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| CLS-01* | foreign Observation read is publicly indistinguishable from missing | A Observation, real citations and positive data |
| CLS-02* | contained Patient denied even with A ID; depth/Patient exception | same parent with harmless coded contained Medication |
| CLS-03* | foreign non-subject Patient performer denies read/suppresses search | same performer changed to Patient/A |
| CLS-04* | include-mode entry cannot become match | same A resource marked match |
| CLS-05 | Patient/A request returns Patient/B body; exact identity check | body ID=A |
| CLS-06 | Condition.subject linkage table, recorder decoy | primary subject=A; same recorder |
| CLS-07 | AllergyIntolerance.patient linkage table, recorder decoy | primary patient=A; same recorder |
| CLS-08 | MedicationRequest.subject linkage table, requester decoy | primary subject=A; same requester |
| CLS-09 | MedicationStatement.subject linkage table, informationSource decoy | primary subject=A; same informationSource |
| CLS-10 | Encounter.subject linkage table, participant decoy | primary subject=A; same participant |
| CLS-11 | DocumentReference.subject linkage table, context.related decoy | primary subject=A; same context.related |
| CLS-12 | DiagnosticReport.subject linkage table, result decoy | primary subject=A; same result |
| CLS-13 | Immunization.patient linkage table, performer decoy | primary patient=A; same performer |
| CLS-14 | Procedure.subject linkage table, performer.actor decoy | primary subject=A; same performer |
| CLS-15 | Coverage.beneficiary linkage table, subscriber/policyHolder decoys | primary beneficiary=A; same subscriber/policyHolder |
| CLS-16 | ExplanationOfBenefit.patient linkage table, payee.party decoy | primary patient=A; same payee |
| CLS-17 | ServiceRequest.subject linkage table, requester decoy | primary subject=A; same requester |
| CLS-18 | Claim.patient linkage table, payee.party decoy | primary patient=A; same payee |
| CLS-19 | foreign contained Observation cannot borrow parent linkage | same contained Observation with its own subject=A |
| CLS-20 | ambiguous contained child cannot borrow parent class | harmless supported contained child in same parent |
| CLS-21 | nested Bundle foreign entry cannot bypass recursive classification | same Bundle structure with only A-authorized entries, where parent is supported |
| CLS-23 | A only in performer/recorder cannot replace absent/unbound primary subject on foreign-owned record | primary subject=A, same secondary structure and authorized identity tuple |
| CLS-24 | resource traversal depth/node cap must fail closed before hidden B node | same authorized nested structure just below cap |

### SHR (16 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| SHR-01* | text-only patient-specific Medication is not catalog shared | fully coded Medication, same tool and instance shape |
| SHR-02* | Organization.contact person is outside shared field policy | same Organization without contact; permitted directory fields kept |
| SHR-03* | shared meta.security cannot be ignored | same shared record without security label |
| SHR-04 | Practitioner disallowed extension; extension policy | same Practitioner without extension |
| SHR-05 | Practitioner identifier in configured patient-ID system; D1 system predicate | same identifier value in attested directory system |
| SHR-06 | Organization.alias free prose must be withheld with label | same record/name preserved, ordinary alias also withheld symmetrically |
| SHR-08* | Medication undeclared meta.profile; profile membership | same record with absent/approved profile |
| SHR-09* | nested coding extension; recursive extension decision | same coded product without extension |
| SHR-10* | modifierExtension/implicitRules outside shared policy | same record without modifier/implicitRules |
| SHR-11* | Medication batch or identifier cannot be shared catalog product | same coded product without instance attributes |
| SHR-12 | shared references must not hydrate a patient target | same manufacturer/partOf reference to permitted directory record; no hydration |
| SHR-13 | contained shared record hides foreign Patient reference | same contained record with permitted reference |
| SHR-14 | directory provenance/source policy mismatch | same synthetic record in the configured policy/source/release |
| SHR-15* | residential Location fails affirmative facility policy | same type coding changed to reviewed facility code |
| SHR-16 | Location without any affirmative coding fails | same Location with one reviewed facility coding |
| SHR-17 | Location.description prose must be withheld with label | same facility/name retained, benign description withheld identically |

### REF (13 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| REF-01* | encoded conditional Patient performer companions | same parent with permitted Practitioner reference/display |
| REF-02* | Patient.link.other display/identifier withheld in all projections | same Patient/link.type kept; ordinary A identity still available |
| REF-03 | logical Patient identifier without literal reference; logical-target branch | same Reference with verified explicit A target, Patient companions still withheld |
| REF-04 | display-only declared Patient; declared-target branch | permitted Practitioner display on same reference-shaped node |
| REF-05 | URN in Patient-capable Reference is not a bound Patient | same node with explicit Patient/A; URN retained elsewhere only if policy permits |
| REF-06 | contained Patient alias cannot establish trusted identity | explicit Patient/A in same parent; harmless contained catalog sibling retained |
| REF-07 | foreign-base A ID and normalization variants cannot establish binding | exact local Patient/A; trailing slash, whitespace, // and case variants remain negative vectors |
| REF-08 | reference/type contradiction cannot hide foreign Patient | consistent Patient/A and type=Patient |
| REF-09 | conditional non-Patient reference with identity companions is unverifiable | explicit local permitted reference, same display |
| REF-10 | capability query in reference cannot retain companion | same permitted reference without credential/query span |
| REF-11 | otherwise bound Patient reference carries display/identifier; D1 companion mask | same bound reference with ordinary A companions also withheld; separate Practitioner companions preserved |
| REF-13 | loose Reference-shaped object on non-Reference element | legitimate non-Reference scalar plus permitted Reference sibling |
| REF-14 | foreign identity in omission/provenance path or raw property key | same omitted feature using safe local field/path; labels remain useful |

### OUT (4 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| OUT-03* | diagnostics/details/unknown code free text cannot be echoed | same issue severity with fixed reviewed code; safe local warning retained |
| OUT-05 | issue.expression embeds foreign identity; expression-name parser/output | expression naming reviewed parameter only |
| OUT-07 | HTTP search error JSON/non-JSON body must not leak source prose | same status with safe body, plus authorized same-tool search |
| OUT-09 | page-2 outcome cannot leak into retained inspect/cache | same page sequence with safe local outcome codes and retained A slice |

### MET (12 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| MET-02* | protected canonical definition URL cannot be fetched or emitted | pinned safe canonical identifier, same discovery operation |
| MET-03* | source documentation through declaration/view/snapshot and SDK discovery | reviewed local description shown; source prose absent |
| MET-05 | direct CapabilityStatement read/search disabled in patient-bound mode | discovery view for same type; neighboring permitted CodeSystem read |
| MET-06 | direct SearchParameter read/search disabled | typed parameter discovery, same canonical; neighboring shared read |
| MET-07 | direct OperationDefinition read/search disabled | fixed implemented-interaction discovery and neighboring shared read |
| MET-08 | source parameter name must satisfy closed grammar | same declaration with reviewed legal name |
| MET-09 | source interaction code must be R4 code | same declaration with legal read/search-type code |
| MET-11 | source prose cannot populate repairs/instructions/listing | same failed query with local reviewed repair text |
| MET-12 | stale discovery snapshot cannot resurrect source documentation | fresh same-topic snapshot with reviewed text |
| MET-13 | direct StructureDefinition read/search disabled; fourth deny-table entry | local schema discovery, same resource path; neighboring shared read |
| MET-14 | CodeSystem concept.definition/description source prose not retained/delivered | same code/system and local coding evidence, prose withheld identically |
| MET-15 | ValueSet description/purpose source prose not retained/delivered | same ValueSet/codes with prose withheld, usable metadata retained |

### NUM (10 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| NUM-01* | foreign-only page versus empty; initial totals gate | same run's two A matches and nonzero delivered count |
| NUM-02* | page-2 foreign suppression cannot affect observable counts | same three-page topology with known A matches |
| NUM-03* | includes cannot inflate returned_matches/includes | same authorized entries marked match, exact count |
| NUM-04 | upstream total absent/huge/changed cannot affect A-only output | same A records and correct delivered total |
| NUM-05 | hidden resources cannot inflate retained resource_count | same authorized retained slice, nonzero count |
| NUM-08 | suppressed child cannot expose identifying omission counts | permitted omitted payload on A with known omission count |
| NUM-09 | authorization_limited caveat cannot depend on suppression occurrence | same query and A records in both twins |
| NUM-10 | cancelled response cannot publish undelivered counters as allowed evidence | same response released before cancellation |
| NUM-11 | observed-code aggregate excludes B matches | same A codes with nonempty known code counts |
| NUM-12 | absence/no-match label cannot depend on suppressed B facts | same A no-match plus independent positive A match |

### RAC (11 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| RAC-01* | late old 401 cannot reinvalidate current generation or revive old authority | same schedule with only current credential, current handles work |
| RAC-02* | old successful response after invalidation cannot commit/deliver old evidence | same response released before invalidation; fresh handles survive |
| RAC-04* | discovery after epoch bump cannot join stale metadata flight | identical discovery on current epoch |
| RAC-05 | old page success after invalidation cannot install page/handles | same page completes on current epoch |
| RAC-07 | last page waiter cancels before body completion; no late delivery/retention | same page released with live waiter |
| RAC-10 | cancellation during retention reservation cannot commit/audit allowed | same reservation with no cancellation |
| RAC-11 | request deadline before deferred page commit cannot publish old work | same barrier schedule within deadline |
| RAC-12 | same query across epochs cannot share pending page flight | two same-epoch waiters may share authorized page |
| RAC-13 | failed required refresh forbids retained access | same handle with successful refresh and current authority |
| RAC-14 | material capability/policy revision invalidates discovery locator | cosmetic revision twin keeps same authorized snapshot |
| RAC-15 | confirmed 401: pre-invalidation cur_ and res_ unusable after reconnect | newly minted same-kind locators work; no old-store resurrection |

### ERR (6 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| ERR-01* | 403 versus 404 must not disclose existence through subsequent work/state | concurrent A read with nontrivial retained result |
| ERR-02* | JSON/UTF-8 parse/decode fault before linkage equals missing | well-formed A read, same content type and route |
| ERR-03* | size/content-type/truncated/compressed body faults before linkage equal missing | valid A body within same limits and encoding |
| ERR-05 | exact read returns wrong type/ID; no provenance/body identity leak | exact requested type and ID body |
| ERR-07* | direct-read redirect is publicly unavailable, not an existence oracle | same read with normal A response |
| ERR-09 | bounded other 4xx/410 equals missing, excluding contracted auth/rate faults | same route with A 200 and fixed retry policy |

### INJ (3 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| INJ-01* | resource narrative instruction is omitted, not executed | same resource with allowed CodeableConcept.text preserved |
| INJ-02 | instruction prose asks patient switch/mutation/context spoof; never interpreted | same field and framing with ordinary A prose, including family-history canary |
| INJ-03 | prose/markdown capability URL cannot cause exfiltration fetch | same surrounding prose, non-capability literal content preserved; URL omission labelled |

### PAY (10 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| PAY-01* | Attachment.data/url withheld, including presentedForm | same attachment metadata and benign surrounding A evidence retained |
| PAY-02* | schema-typed Patient.photo without contentType is still attachment | same photo metadata without data/url |
| PAY-03* | hostile MIME/hash/size manifest metadata cannot echo raw values | valid MIME/hash/size metadata in same attachment |
| PAY-05 | declared valueBase64Binary payload primitive withheld | same surrounding element with permitted metadata-only evidence |
| PAY-06 | contained attachment cannot bypass payload traversal | same contained structure, metadata retained without bytes/link |
| PAY-07 | primitive companion extension cannot carry payload bytes | same primitive with harmless allowed companion metadata |
| PAY-08 | Binary direct read is unsupported/denied | neighboring supported read with equivalent arguments |
| PAY-09 | prose capability URL withheld without dropping surrounding A prose | same prose with ordinary harmless text; URL-span boundaries checked |
| PAY-10 | typed canonical URI has credential query/fragment aliases | same canonical without capability component |
| PAY-11 | same-origin attachment points to destructive GET; never hydrated | same manifest metadata and authorized read; sink/journal live |

### LOG (12 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| LOG-01* | startup ambient proxy warning must not echo credentials | same startup with harmless proxy presence, expected fixed warning |
| LOG-02 | rejected tool input includes identifiers/secrets; no raw argument logging | same tool succeeds and emits valid frame/allowed audit |
| LOG-03 | upstream exception carries body/URL; no operational/audit echo | same route returns valid A body and safe event |
| LOG-04 | token success/failure carries credential canaries; metadata only | same token operation succeeds without leaking token/body |
| LOG-05 | denied reference companion/MRN must not appear in any log | same structure with permitted Practitioner reference, useful safe audit |
| LOG-06 | successful A resource body must not be logged | same successful call delivers A to protocol output, metadata-only audit |
| LOG-07 | cancelled/strict-output-rejected work cannot be audited allowed | same work delivered successfully before rejection/cancel |
| LOG-09 | uncaught exception/unhandled rejection cannot print body/URL/identifier | harness crash probe with fixed safe diagnostic and live stderr capture |
| LOG-10 | initialize client metadata cannot leak identifiers through SDK logging | same handshake with benign client metadata and valid frame |
| LOG-11 | malformed raw JSON frame cannot echo input excerpt in parse diagnostics | same bytes repaired into valid call; parse-error capture independently live |
| LOG-12 | cancellation/unknown notification data cannot leak to SDK stderr | same notification kind with benign fields plus live authorized call |
| LOG-13 | invalid trusted startup configuration cannot dump patient/secret fields | valid neighboring synthetic config starts and returns a frame |

### HPP (2 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| HPP-01 | value contains &, &amp;, #, = or %26; value serialization cannot create pairs/fragment | same legal token structure with non-protected token; exact ordered outbound pairs and original patient constraint |
| HPP-02 | hostile declared parameter name contains = or &; key serialization/name admission | reviewed legal name, same value and pair count; raw name never creates extra pair |

### ADM (4 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| ADM-01 | duplicate raw argument keys cannot validate one value then send another | identical duplicate A values; deterministic single parsed meaning and same raw framing |
| ADM-02 | __proto__/constructor/prototype at top level and params/output cannot change authority/defaults | own-key normal fields and same valid query/output; object prototypes unchanged |
| ADM-03 | unadvertised resources/read, prompts/get, completion/complete, logging/setLevel rejected | listed tools/call on same initialized connection; no side effects |
| ADM-04 | data never induces sampling/elicitation/roots requests or MCP logging notifications | ordinary prose in same field, same allowed tool output; client handlers are live |

### HIS (2 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| HIS-01 | unimplemented vread/history interaction refused before clinical work | identical fhir_read with interaction=read; _history IDs/next paths are PTH/CNT vectors, not extra cases |
| HIS-02 | returned versioned Patient/B reference must not authorize resource | same Patient/A/_history/n; unchanged version and record shape |

### BAS (1 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| BAS-01 | foreign entry.fullUrl base makes relative Patient/A foreign, not locally bound | same entry/fullUrl changed only to configured base; no foreign identity retained |

### XRF (1 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| XRF-01 | admitted non-Patient clinical reference search distinguishes foreign existing/missing target by 4xx versus empty | identical shape targeting fixture-verified A reference if implemented; otherwise symmetric refusal plus same-tool permitted typed reference control |

### DIR (7 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| DIR-01 | Organization.identifier uses configured patient-ID system; Organization table entry | identical identifier value in operator-attested directory system |
| DIR-02 | Location.identifier uses patient-ID system despite facility coding; Location table entry | same facility/value with directory system |
| DIR-03 | CodeSystem.identifier uses patient-ID system; CodeSystem table entry | same coded catalog identity/value with catalog system |
| DIR-04 | ValueSet.identifier uses patient-ID system; ValueSet table entry | same coded catalog identity/value with catalog system |
| DIR-05 | Location.alias free-text mask; distinct location policy field entry | same facility/name preserved, ordinary alias also withheld |
| DIR-06 | Location.availabilityExceptions free-text mask; distinct field entry | same facility/hours retained, benign exceptions also withheld |
| DIR-07 | coded Medication.code.text prose mask must not remove coding evidence | same code.coding, ordinary text also withheld, exact coding preserved |

### AUT (3 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| AUT-01 | token endpoint redirects cannot forward client credential body to sink | same endpoint grants token without redirect, token-auth liveness observed |
| AUT-02 | hostile WWW-Authenticate authorization/resource URI must not initiate fetch or replace configured token endpoint | same valid invalid_token signal without URI, bounded refresh to configured endpoint only |
| AUT-03 | old token acquisition success after provider invalidation cannot install old credential | same acquisition completes on current generation; fingerprint shows new credential on resource call |

### PAR (3 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| PAR-01 | duplicate FHIR subject/resourceType keys cannot authorize one representation and emit another | identical duplicate A values with one consistent parsed meaning, or symmetric strict duplicate refusal plus equivalent unique-key A control |
| PAR-02 | invalid/non-scalar resource ID cannot inject foreign identity into provenance/retained index | same resource with legal own A-record logical ID, exact provenance; no general free-text-ID classifier claimed |
| PAR-03 | upstream __proto__/constructor keys cannot affect class/linkage traversal or retained objects | same JSON object with ordinary own-key harmless field, prototype unchanged |

### LIF (4 independent cases)

| ID | Distinct decision / attack | Required near-twin control |
| --- | --- | --- |
| LIF-01 | close during in-flight read forbids late output/store/audit-allowed commit | same read finishes before close |
| LIF-02 | clinical cursor expires while upstream page is held; expiry cannot be renewed on page commit | same held page released before absolute expiry; original expiry retained |
| LIF-03 | explicit material-policy invalidation forbids existing clinical res_/cur_ access | same locators under unchanged policy; no model-controlled policy API |
| LIF-04 | queued request after close cannot start clinical work or commit | same queue schedule released while gateway open |

### Per-type linkage traps (CLS-06–18)

Each row's discriminating fixture is a foreign-owned record with **absent or unbound primary linkage**, a type-specific secondary decoy, and a protected fixture-owned resource ID/identity marker. Do not leave a literal Patient/B elsewhere in this fixture: the common recursive foreign-Patient veto would then subsume the primary-linkage fault (`privacy.ts:255–267`). Its near-twin uses the same type/decoy/shape with only the primary binding and protected identity tuple replaced by authorized A evidence. Additional required negatives set primary=B and/or secondary Patient=B; these are vectors, not extra rows.

Use the exact decoy path in each row: Condition.recorder, AllergyIntolerance.recorder, MedicationRequest.requester, MedicationStatement.informationSource, Encounter.participant.individual, DocumentReference.context.related, DiagnosticReport.result, Immunization.performer.actor, Procedure.performer.actor, Coverage.subscriber/policyHolder, ExplanationOfBenefit.payee.party, ServiceRequest.requester and Claim.payee.party. Keep target types schema-correct where supported. In particular DiagnosticReport.result refers to an Observation; it never becomes a Patient reference or establishes subject authority. References to foreign-owned non-Patient resources remain unverified and are never hydrated by the harness target to rescue a primary linkage. Deliberately malformed Patient secondary vectors are additional negatives, not the sole evidence.

Each row gets a **per-entry** mutant bypassing only that type's required-primary predicate; an alternate-decoy-path mutant is admitted only where independently killable. A common `subject-linkage` mutation is insufficient to count 13 rows. Missing primary linkage plus the field-specific decoy and per-entry mutant prevents table-name clones. Coverage also tests foreign subscriber/policyHolder while beneficiary=A (`tests/privacy.test.ts:138`). Patient plus Observation and the 13 other type predicates cover 15 patient classes. If a discriminating trap/fault cannot be built, its row stays unresolved and cannot pass; it cannot silently become a passing type-name clone.

## 3. Denominator and existing-evidence accounting

The arithmetic below follows the actual table rows, not the round-1 estimate. Conservative extra B3/robustness reclassifications give **175 retained round-1 B2 rows + 41 added rows = 216**. Margin over 200 is **16**. Every retained row still requires manifested controls/oracles and execution. Current earned count is 0; the count is a design commitment, not a report of 216 independent passes.

| Family | Retained old IDs | Added round-2 IDs | Mapped existing shapes | New scenario assertions | Independent B2 cases |
| --- | ---: | ---: | ---: | ---: | ---: |
| SEL | 28 | 5 | 6 | 27 | 33 |
| PTH | 7 | 0 | 3 | 4 | 7 |
| CNT | 15 | 0 | 4 | 11 | 15 |
| CUR | 8 | 0 | 3 | 5 | 8 |
| HND | 6 | 0 | 1 | 5 | 6 |
| CLS | 23 | 0 | 4 | 19 | 23 |
| SHR | 16 | 0 | 8 | 8 | 16 |
| REF | 13 | 0 | 2 | 11 | 13 |
| OUT | 4 | 0 | 1 | 3 | 4 |
| MET | 9 | 3 | 2 | 10 | 12 |
| NUM | 10 | 0 | 3 | 7 | 10 |
| RAC | 10 | 1 | 3 | 8 | 11 |
| ERR | 6 | 0 | 4 | 2 | 6 |
| INJ | 3 | 0 | 1 | 2 | 3 |
| PAY | 10 | 0 | 3 | 7 | 10 |
| LOG | 7 | 5 | 1 | 11 | 12 |
| HPP | 0 | 2 | 0 | 2 | 2 |
| ADM | 0 | 4 | 0 | 4 | 4 |
| HIS | 0 | 2 | 0 | 2 | 2 |
| BAS | 0 | 1 | 0 | 1 | 1 |
| XRF | 0 | 1 | 0 | 1 | 1 |
| DIR | 0 | 7 | 0 | 7 | 7 |
| AUT | 0 | 3 | 0 | 3 | 3 |
| PAR | 0 | 3 | 0 | 3 | 3 |
| LIF | 0 | 4 | 0 | 4 | 4 |
| **Total** | **175** | **41** | **49** | **167** | **216** |

### Complete round-1 disposition ledger

Every one of the original 246 IDs is accounted for: 175 retained + **42 aliases** + **27 B3/robustness** + **1 S2** + **1 residual**. With 41 additions, the design has **287 ID records: 216 counted cases, 29 distinct cases outside counted B2, and 42 aliases that are not additional cases**. “Out of B2” does not mean optional or passed. Timing/remote/SMART and semantic residual classes are scope exclusions, not additional case IDs. Scanner/stub challenges and execution cells are separate denominators.

| Family | Merged aliases → canonical ID (all counted:false) |
| --- | --- |
| SEL | 07→06; 17→16; 26→25; 28→30 |
| PTH | 04→01; 05/06→02; 08/10/15→07; 12/13→11; 14→03 |
| CNT | 13→PTH-02; 15/20→01; 17→16 |
| CUR | 05→04; 07→06 |
| HND | 04/05→03 |
| CLS | 22→ERR-05 |
| SHR | 18→MET-05 (direct conformance routes also covered by MET-06/07/13) |
| REF | 12→11 |
| OUT | 04/06→03; 08→07; 11→ERR-05 |
| MET | 01/04→03 (operation prose is a vector, not its own read path) |
| RAC | 06→01 |
| ERR | 04/08→03; 06→02 |
| INJ | 04/07/08→02; 06→03 |
| PAY | 04→01; 12→PTH-16; 13→PTH-11; 14→CNT-16 |

No ID is recycled. Alias records carry `duplicate_of` and no independent budget/control count. The case-file union permits a strict AliasRecord containing only id, family, counted:false, duplicate_of, classification=alias, boundary, cross_refs and review rationale; attack/lane requirements apply to executable case records, not aliases. B3 rows and residuals have null duplicate_of and counted:false. A future substantively different scenario needs a new ID/version; it cannot reuse an alias to hide history.

### Existing mappings and citation corrections

All paths here are relative to repository root. The table identifies exactly the 49 starred rows; the same source test can supply partial shapes for distinct decisions, never independent passed cases. Expand vector/level/run-evidence fields in the manifest before execution.

| IDs | Inspected source and limitation |
| --- | --- |
| SEL-01 | `tests/core.test.ts:78`, eval `packages/evals/src/tasks.ts:231`: **partial**. Zero-fetch follows forged context only; patient=b arm lacks recorder/control. Deny-only eval `checks:[]` cannot establish the paired case. |
| SEL-02/03 | `tests/core.test.ts:567` / `:582`; SEL-03 already includes _id=A,B. |
| SEL-04/05 | `tests/repair-c.test.ts:109`; `tests/search-parameters.test.ts:70` (05 helper only). |
| SEL-06 | `tests/s1-confinement-latch.test.ts:124`, foreign-last vector already at `:135`; 07 is not new evidence. |
| PTH-01 | `tests/core.test.ts:243`: **partial**. Trusted production config refusal is not model attack; '..' lacks zero-request/control assertions. Dot-only guard distinct from invalid-ID grammar. |
| PTH-02/03 | `tests/core.test.ts:676` (transport helper + self-link); `:662` (alias across tools). |
| CNT-01 | `tests/core.test.ts:111`: **partial**. No redirect tested; uninstrumented 169.254.169.254 is not a sink witness. Replace actual destination with loopback sink. |
| CNT-02/06/05 | `tests/integration2.test.ts:162` already tests patient and Patient _id loss; `:197` vendor tokens. Code/date arms are B3. |
| CUR-01/13 | **Corrected** to `tests/core.test.ts:249–261`: clinical cursor absolute expiry and no renewal. `:220–229` is result-handle expiry, not cur_. Both decision shapes need independent get-versus-mint faults. |
| CUR-03 | `tests/search-parameters.test.ts:276`, helper only. |
| HND-01 | `tests/core.test.ts:220–229`: **partial, second in-process gateway/store**, not foreign process. New process driver required. |
| CLS-01/02/03/04 | `tests/core.test.ts:88`, `:183`, `:519`, `:651`; 02 is **partial**: contained B ID only (`:184`), no A-ID vector/control. Evals at tasks.ts:223/:215 are deny-only. |
| SHR-01/02/03/08/09/10/11/15 | `tests/privacy.test.ts:277` and `:245–268`. One rule-table test already covers the latter shared-policy negatives; they are not novel source vectors. Per-rule traps/faults still required. |
| REF-01/02 | `tests/repair-d.test.ts:186` (actual SDK, both eras); `tests/privacy.test.ts:121` (helper/core plus retained projection). |
| OUT-03 | `tests/repair-c.test.ts:268` already asserts diagnostics-canary absence; OUT-01 coverage judgment itself is B3. |
| MET-02/03 | `tests/search-parameters.test.ts:233` / `:208`, helper only. “Never fetched” in 02 is a static regex, not a recorder. 03 gains 01's source-doc helper mapping, not SDK qualification. |
| NUM-01/02/03 | `tests/repair-c.test.ts:133`; `tests/integration2.test.ts:295`; eval `adversarial-include-entries` count assertions (separate from CLS-04 membership). |
| RAC-01/02/04 | `tests/auth-gateway.test.ts:169`, `:196`, `:296`; removed RAC-03 at :227 is retained only as B3/availability. |
| ERR-01/02/03/07 | `tests/auth-gateway.test.ts:130`; `tests/integration2.test.ts:233` (parse and size/content vectors); `tests/repair-c.test.ts` “V-21 direct-read 3xx and 2xx body-stage faults are publicly identical to NOT_FOUND” (redirect/body stages). |
| INJ-01 | `tests/privacy.test.ts:449`; narrative omission, not downstream model obedience. |
| PAY-01/02/03 | `tests/core.test.ts:156`; `tests/privacy.test.ts:395`, `:309`. |
| LOG-01 | `tests/integration1.test.ts:160`; proxy credential hygiene, not a patient-body log test. |

`normalizedCapabilityRevision` is at **`packages/core/src/discovery.ts:49`**, not :31. The Q W0 integration skip at `tests/search-parameters.test.ts:531`, task JSON loading and draft TODOs are not passing evidence. Extra era/projection executions add no mapped shapes. **49 is a source inventory, not 49 newly qualified cases.**

## 4. Harness, schema and oracle contract

### Location and ownership

Use **`tests/isolation/{schema,data,src,test,mutants}/**`**, not packages/isolation. Root assigns paths before implementation and owns root scripts/dependencies/CI/git/artifacts; no delegated implementer commits/pushes or edits active core/R/Q/P files. `tsconfig.build.json:4–5` includes packages and excludes tests; root's `tests/*.test.ts` glob is nonrecursive, so root must add explicit `test:isolation` wiring and diagnostic CI. No production observer seam or alternate tool registration.

- Core driver: public `FhirGateway`, public `auditEvents` (`index.ts:164`), structural store cast as at `tests/auth-gateway.test.ts:87`. Read fields only; never call policy functions to decide the oracle.
- Qualifying stdio: spawn built `dist/packages/server/src/cli.js`, temporary trusted config, real SDK initialize/list/call/cancel paths in both eras. Run the S9 installed package, not a source/tsx fallback.
- Optional observer stdio: test launcher built from public `createMcpServer`/`FhirGateway` exports, forwarding sanitized audit over fd 3. Same registration and binary dependencies, no replacement server. It supplements, never replaces, the actual CLI.
- Core can mock Date.now; CLI uses trusted limits.ttlMs and bounded real waits plus backend response barriers. No production clock/policy seam.

Proposed files: `schema/{case-manifest,report}.schema.json`; `data/{manifest.v1,coverage-matrix,critical-mutants,canaries,fixture-hashes}.json`; `data/cases/<family>.json`; synthetic fixtures/raw frames; `src/{manifest,backend,recorder,barriers,sdk-driver,core-driver,scanners,oracle,report,cli}.ts`; `test/{manifest,recorder,scanners,oracle,runner,stdio}.test.ts`; `mutants/{definitions,verifier-challenges}.json`. This document creates none of them.

Publish reviewed sanitized reports as a release asset or tracked `docs/evidence/b2/<candidate>/<run-id>/`; never rely on ignored artifacts/. Raw synthetic frames/state/credentials stay restricted in `.local/b2-isolation/<run-id>/`, mode 0700/0600, with only hashes/marker IDs in public reports.

### Normative case schema (per-lane applicability)

The implementation must emit strict JSON Schema draft 2020-12, additionalProperties:false on each record, bounded arrays/strings and a semantic loader. This design specifies that schema contract; it does not claim an executable schema file has been created or validated. The following is the normative field contract, replacing round-1's erroneous all-nine-per-case array. Tables use compact IDs; stored IDs are `B2-<family>-NN`, with family agreeing and aliases normalized before duplicate checking.

| Record/field | Exact contract |
| --- | --- |
| Manifest | schema_version=`b2-isolation-manifest/1`; suite_id; scope; scope_revision; fixed_time (date-time); fixture/matrix/scanner/mutant hashes (64 hex); closed relative case_files; required_eras exactly the two pinned eras; candidate pins in separate immutable run manifest. |
| Case | id, family, title (1–200 chars), obligation IDs, signature, independence (1–1024 chars), counted:boolean, duplicate_of:null or case ID, boundary:`decidable\|residual`, cross_refs (including CA-ISO), classification:`B2\|B3\|robustness\|S2\|residual\|alias`, applicability, fixture/behavior/binding IDs, lanes, setup/attack/controls/followups, expected assertions, canary_sets, twin_world, mutants, existing_evidence, budgets. |
| Signature | strict object of primary_decision, adversarial_goal, protected_element_class, state_transition; bounded registry IDs plus source_anchor and discriminating_fault_intent. Hash canonical four-tuple; no signature made unique merely by appending case ID. |
| Count condition | counted:true implies B2, boundary=decidable, duplicate_of=null, applicable, nonempty controls and fault rationale. duplicate_of != null implies counted:false, classification=alias, canonical target exists, no cycles. Residual/B3/S2/robustness cannot be counted. |
| Applicability | status=`applicable\|not_applicable\|deferred`, bounded reason, reviewer, scope_revision. A pending implementation or current failure is a run status, never N/A. |
| Lane | driver=`core\|sdk_cli_modern\|sdk_cli_legacy\|sdk_observer_modern\|sdk_observer_legacy\|helper`; projection=`fhir\|compact\|selected\|not_applicable`; delivery_id (pinned allowlist); applicability; **channel_capture map**, each entry `{status:required\|not_applicable,reason,reviewer}`. Required channel capture cannot be silently missing. |
| Steps | closed tagged union: call (five tools + bounded JSON arguments); raw_rpc (hashed vector ID, never an inline executable expression); advance_clock (core only, positive bounded ms); barrier (closed event ID/action); cancel; restart; observe (closed observation ID). Arrays max64; attack/control nonempty. No callbacks/imports/shell/arbitrary destination URLs in manifest. |
| Controls | unique id, required:true, near_twin_delta (exact changed fields), same source/metadata state, nonempty steps/assertions, overblocking_challenge IDs; unsupported-surface control explicitly names symmetric refusal and supported neighbor. |
| Assertions | id, step_id, exact response index or all, kind, predicate_id, typed expected. Closed kinds: call_outcome, citations, marker_absent, ordered_pairs, **destinations**, request_budget, coverage_controls, counts, state, audit, capture, mutation_digest, byte_ceiling, twin_equal. Expected shape is validated by predicate registry, no arbitrary JS/regex evaluator. |
| Destinations | strict expected `{sink_id,allowed_request_count,allowed_methods,credential_allowed}`; zero attack requests asserted independently of target output. Sink liveness events are tagged setup and never subtracted without matching IDs. |
| Existing evidence | file, line/test_name, vector, level=`helper\|core\|sdk\|cli`, inspected_revision, run_evidence:null until a real run. Mapping is not execution. |
| Budgets | max_tool_calls, max_total_upstream_calls, max_clinical_calls (may be 0), max_result_bytes, max_task_bytes, deadline_ms; explicit ceilings pinned within shipped limits. Auth/metadata/clinical/sink/mutation counts separate. |

| Channel | Core | Built CLI (each era) | Optional observer CLI |
| --- | --- | --- | --- |
| output_text | required via public serializer | required | required |
| output_structured | required via public serializer | required | required |
| raw_frame | reviewed N/A: no stdio | required, unparsed and independently reconstructed | required |
| stderr | reviewed N/A: no CLI child; host capture is operational | required, including startup/crash | required |
| operational | required console/log capture | required SDK/target process sinks | required |
| audit | required structural public array read | reviewed N/A: private process, no audit export | required fd 3 |
| state | required structural store/cache/pending read | reviewed N/A: private process; public locator followups still required | N/A unless independently available without production seam |
| request | required independent recorder/sinks | required | required |
| backend | required GET-only journal and before/after digest | required | required |

A counted case's composite evidence must include core audit/state where its obligation needs them plus actual CLI outputs in both eras. No CLI claim about invisible internals is allowed. Raw JSON parser/MCP-method cases have reviewed core N/A; their actual protocol cells plus observer/companion controls supply relevant evidence. A helper never substitutes for a required public cell. Missing required capture is inconclusive/fail; reviewed N/A is explicit and cannot earn a passed channel. Inapplicable projection cells are recorded rather than fabricated.

Loader rejects unknown/missing IDs, alias cycles, duplicate case/control/assertion IDs, conflicting signatures, missing applicable lanes/channels, invalid predicate expected-values, missing controls/fault intents, undeclared fixture/sink/barrier references, and counts that differ from this ledger. It must reject an apparent 216 obtained by counting aliases, B3 or repeated cells. Matrix crosses requirement × tool × type/predicate × interaction × output/retained channels; packaging/era/projection/profile are execution dimensions, never new cases. Include all 15 patient types, all 10 shared-type policy decisions (four are decided against for direct reads/search), and denied ambiguous classes. Scope shrinkage requires versioned review and retains failed historical reports.

### Scanner and verifier independence

Canaries comprise several independent unique segments, each **at least 8 characters**, placed near the beginning and across anticipated transform boundaries. **Any single segment** in a forbidden channel is a hit. Freeze segment dictionary, case-folded scanning, raw/JSON-unescaped/URL-decoded known-encoding passes and minimum-fragment rule before runs. Distinguish permitted A-prose control segments from forbidden identity/credential segments by context/channel. Do not scan generic short substrings or silently normalize away a hit.

Scanner self-tests inject each segment into all nine channels, including object keys, warnings, repairs, locators, audit, pending state and retained blobs; test 120/240-character truncation, lowercasing, JSON escapes, URL redaction splits and trailing prose. A canary beyond a truncation boundary alone is invalid fixture design. The scanner is not a semantic PHI detector.

Per-case liveness: valid protocol frame, allowed audit in observed/core lane, upstream positive-control request, sink test probe and mutation-journal setup digest. A silent/stopped target cannot pass. Deny-all and overblocking stubs, skipped recorder event, forged byte count, missing state capture, borrowed earlier response facts, collapsed repeated pairs, unsafe twin normalization and missing shard/critical IDs must all be caught before target qualification.

Only preprovisioned pinned dependencies/images/fixture bytes; no public FHIR, DNS, downloads, Synthea generation, model calls, embeddings or telemetry in execution. Qualify in Linux `--network none` with backend/token/sinks on loopback **inside the same network namespace**, no published listener, home mount, real secret env or ambient proxy. macOS is diagnostic. Test egress enforcement independently. A public-looking URL string is an extra input vector; actual targets are instrumented loopback sinks, not cloud metadata/public hosts.

Determinism: fixed fixture/time seeds, named barriers, fresh stores, fixed case order. Run every baseline twice; disagreement is flaky/inconclusive, never best-of-two. Normalize only the limited set in §1.

### Critical mutants and reports

**Explicitly excluded from the critical registry:**

| Survivor ID | Recorded reason in scripts/mutation-survivors.json |
| --- | --- |
| outcome-execution-failure | Disjoint execution/filter code sets make fallthrough throw equivalent to deleted explicit throw. |
| credential-reinvalidate | Retryable short-circuit already returns before the removed invalidation exemption. |
| render-cancel-guard | Delivery/post-render checks and reservation rollback subsume output/retention effect; fresh-handle eviction interleave has no deterministic witness. This is documented defense in depth, not asserted equivalent for every conceivable interleave. |

Critical admission requires reachable non-equivalent guard and discriminating deterministic fixture. An excluded survivor can return only after a refactor/new independent reachable effect and fresh validated witness; exclusion is not a waiver of a designated kill. `scripts/mutation-guards.mjs` exports MUTANTS and guards main (:626); importing definitions without executing main is allowed in later implementation. Root reviews union with new tests/isolation/mutants definitions and freezes exact live anchors after S5/S6. No production authorization-off flags. Preserve the stronger existing mutation gate separately.

Valid kill: exact one-match anchor; weakened candidate compiles/starts; baseline passes; designated case fails the named disclosure/work/revocation/control oracle reproducibly twice on fresh fixtures. Anchor/build/capture failure and a generic timeout are invalid/inconclusive, not kills. Do not weaken a second guard to manufacture a kill. Equivalent/defense-in-depth survivor analysis precedes registry freeze; once critical, no survivor waiver.

Reports pin candidate commit/tree/package/installed dependency tree/schema/SDK/runtime/OS, all manifests/fixtures/matrix/scanner/mutant hashes, every required case/control/cell, classified calls/bytes/destinations/state/audit checks and restricted-capture hashes. Publish declared/independent/applicable/executed/passed/failed/pending/inconclusive/unsupported counts separately, plus controls, cells and mutant validity/kills. One case passes only when every required cell/control passes. Current known failures stay failures; xfail never passes B2. Root may shard IDs deterministically and aggregate exactly once; missing/mismatched reports fail.

## 5. v1 first slice

**Freeze all of Claude's 42 scenario groups, expanded honestly into 61 distinct canonical case IDs.** This is the justified alternative to calling the grouped review list “42 independent cases”: several rows name multiple retained decisions, while the redirect guard appears in both rows 18 and 38. The groups below preserve that review's order and scope; the first-slice manifest is the **set union** of the IDs, not 42 new IDs and not a second count for aliases. This expansion changes no full-suite denominator. It lands as non-gating diagnostic CI before S3 where sequencing permits.

| Review group | Exact canonical first-slice IDs | Required scenario/control |
| ---: | --- | --- |
| 1 | SEL-01 | foreign patient versus bound A; trusted append |
| 2 | SEL-02 | subject-only source, A twin |
| 3 | SEL-03 | _id=B/A,B versus confined A |
| 4 | SEL-04, SEL-05 | bare reference/link IDs versus explicit permitted reference |
| 5 | SEL-06 | overflow/foreign-last versus 33 bound alternatives |
| 6 | SEL-15, SEL-16 | plain/encoded conditional target versus explicit A and legal encoding token |
| 7 | SEL-19 | escaped comma arrives byte-exact |
| 8 | SEL-23, SEL-24, SEL-25, SEL-33 | declaring hostile source, shared-type reverse join/chain/include/filter; ordinary same-type declared control |
| 9 | HPP-01, HPP-02 | value and name pollution; one encoded pair, exact confinement |
| 10 | PTH-07, PTH-09 | ID/type URL grammar; legal dotted ID and type |
| 11 | PTH-11 | url/headers/method/body strict keys; remove only unknown keys |
| 12 | PTH-16 | unknown ingestion/write tools; listed tool and live write journal |
| 13 | PTH-01 | dot-only IDs, zero upstream; legal dotted ID |
| 14 | PTH-03 | wrong alias on three tools; configured alias |
| 15 | CNT-01 | foreign next; in-base next and instrumented origin sink |
| 16 | CNT-02, CNT-06 | dropped patient/_id; paging-mechanics-only change |
| 17 | CNT-12, PTH-02 | sibling base/encoded traversal; in-base same-origin next |
| 18 | CNT-16 | page-2 3xx to credential sink; nonredirect page |
| 19 | CNT-22, CNT-23 | opaque rebinding/conflict; honest opaque chain, always unverified |
| 20 | CUR-04 | A/B store/process replay; stable own-store replay |
| 21 | HND-01 | A/B res_ store/process replay; own-store projection |
| 22 | CUR-06 | added page fields; unchanged cursor with exact query |
| 23 | CUR-09, CUR-10, HND-03 | clinical/discovery/result kind confusion; right tool/kind |
| 24 | CUR-08 | forged context on cursor/search; own or omitted context |
| 25 | CLS-01 | foreign read equals missing; A read succeeds |
| 26 | CLS-03 | foreign performer read/search/caveat twin; same-patient performer |
| 27 | CLS-23 | missing/unbound primary with A recorder; A primary twin; explicit B primary is an additional vector |
| 28 | CLS-02, CLS-19 | contained Patient including A ID / foreign Observation; harmless catalog child |
| 29 | CLS-04, NUM-03 | included entries cannot become matches or counts; match twin |
| 30 | CLS-05, ERR-05 | wrong Patient identity/type/ID; exact body |
| 31 | REF-01 | conditional companions through SDK both eras; Practitioner display |
| 32 | REF-02 | Patient.link.other retained projection; link.type remains |
| 33 | NUM-01 | suppressed-only equals empty; two-record positive |
| 34 | NUM-02 | late suppression; unsuppressed three-page twin |
| 35 | ERR-01 | 403/404 handles/tokens/calls/concurrency twin; A concurrent read |
| 36 | ERR-02, ERR-03 | parse/decode and size/content body-stage faults; valid A body |
| 37 | PAY-01 | attachment data/url across projections; manifest remains, sink silent |
| 38 | CNT-16 (already counted) | initial-read 3xx to sink; normal read (PAY-14 is alias) |
| 39 | LOG-02, LOG-05 | argument/denied companion logs; frame and allowed audit liveness |
| 40 | OUT-03 | outcome prose in success/partial/error; safe local warning |
| 41 | MET-03, MET-08 | source docs/hostile names through actual discovery; reviewed text/name |
| 42 | INJ-02, INJ-03, ADM-04 | injection remains data; no extra work/server requests; ordinary prose preserved |

Prerequisites are **not counted cases**: scanner self-tests in all nine applicable channels with truncation/case-fold/redaction splits; recorder and sink liveness; backend mutation-journal liveness; per-case frame/audit liveness; deny-all and strengthened overblocking stubs; twin-normalizer challenges; missing-capture/aggregate challenges; repeatable barrier schedules. Run built CLI in both eras and core where applicable, fhir/compact/selected where meaningful, minimal-pair controls, instrumented destinations and two runs. Raw protocol-only cases record core N/A. All existing killable relevant slice guards are candidates for critical admission; the three excluded survivors never enter it by default.

## 6. Runtime gaps to route into S3

These are **source-confirmed behaviors and design risk classifications, not executed exploit findings**. Root routes fixes; this document changes no runtime files. High means plausible cross-patient disclosure/existence or forbidden retention under this synthetic contract, not a claimed external vulnerability rating.

| Gap / severity / cases | Exact current behavior and evidence | Expected fail-closed behavior | Disclosure or completeness? / owner checkpoint |
| --- | --- | --- | --- |
| **G1 shared-type search scoping — High when relationship-bearing; ordinary directory search alone is not a defect**; SEL-23/24/33, XRF-01 | `packages/core/src/index.ts:639–643` appends constraints only for Patient/patient class. The shared types at `privacy.ts:6` get no patient pair; results can be structurally directory-safe. | In patient-bound mode refuse relationship-bearing/clinical-reference shared searches without a tested query-bound directory policy. Do not invent patient= on Practitioner/Organization. Permit only reviewed independent directory lookups/parameters with structural instance checks; unresolved target semantics refuse before clinical send. | A Practitioner returned because only B's Observation matches a reverse join reveals B's relationship even if the directory body is public. Ordinary directory membership is not automatically patient data. S3 typed admission closes join/control path; root must explicitly freeze shared-search eligibility in S3/support matrix, or decide against unsupported shared searches. |
| **G2 source-advertised control/chains — High**; SEL-23–25/27/29/30/33/34 | `index.ts:629–631` accepts source names except _include*/_revinclude*. `_has`, `_filter`, chaining/modifiers/control names therefore pass if declared and no separate Patient-value veto fires. `search-parameters.ts:327`, `:393–397` holds the unwired join/chain/modifier denial; integration plan S3 also names _filter/_list/etc. | Wire resolve→syntax→confinement→selector validation before URL construction. Source advertisement never grants executable syntax. Preserve legacy veto and admitted generic HbA1c control. | Can disclose relationships/existence through shared queries. A patient-constrained query can still probe another clinical reference. Some shaping-only variants affect completeness only (appendix). S3. Use declaring source and a harmless code value: e.g. Practitioner reverse-chain Observation.code present only in B, not Patient/B literal that the old veto already rejects. |
| **G3 foreign non-Patient reference existence — High**; XRF-01 | `privacy.ts:215–228` allows ordinary same-source Encounter/enc-b on a declared reference parameter because it is not Patient. `index.ts:647–649` sends it; `:612–616` uniformizes **read** faults only. A source's 4xx for nonexistent target versus empty 200 for existing target can escape as distinct search behavior. | Refuse a patient-class reference selector unless trusted local evidence already verifies its A linkage; do not hydrate arbitrary targets to authorize them. If verification is unavailable, both existing/missing foreign probes refuse before search. Keep independently safe directory reference controls. | Existence disclosure despite zero foreign rows. The upstream oracle is conditional, not reproduced here. S3 typed target admission plus explicit root-reviewed policy; uniformizing read faults alone cannot fix it. |
| **G4 Bundle fullUrl-relative authorization — High**; BAS-01 | `index.ts:674–688` consumes entry.resource/search only and calls authorized with transport.base at :685. `privacy.ts:143–144` treats relative references as same-source; no entry.fullUrl base is passed. Foreign-base fullUrl plus relative Patient/A is therefore evaluated as local A. | Validate entry base before authorization, resolve relative references against permitted effective base, and suppress foreign/ambiguous origin before retention. No remote resolution fetch. | Can deliver a record whose actual relative Patient target belongs to another server while presenting A identity. S4 response classification/linkage, with S3 recording admission requirements; not fixed by selector checks alone. |
| **G5 global source documentation/raw tokens — High for direct disclosure; fingerprint-only subcase is S2**; MET-03/05–09/13–15 | `index.ts:552` caches raw search names/interactions; :587 echoes them. `privacy.ts:57–63` allows conformance base elements; `:371–378` preserves URL-free prose. `index.ts:554` hashes whole metadata, including prose. | D2 closed names/codes; globally omit source prose; disable four direct conformance resource routes, retain safe local discovery; normalized revision at `discovery.ts:49`. | Source prose or name can directly carry B identifiers; revision-only cosmetic difference is excluded S2 stability evidence, not B2. S2 metadata normalization/storage; S3 capability/resource eligibility; S5 public discovery integration and privacy-owner direct-route masks. |
| **G6 Patient reference companions — High**; REF-11 | `privacy.ts:398–411` withholds display/identifier for unverifiable references, not every bound Patient reference. A bound Patient/A reference with foreign display/identifier can survive. | D1 Patient-typed companion mask, labelled; preserve literal verified A reference and ordinary Practitioner companions. | Structured foreign identity can be disclosed even with correct subject. Privacy owner alongside S3, integrated/qualified at S5. No generic semantic prose redactor. |
| **G7 shared identifier/text policy — High for patient-system identity; semantic remainder explicitly residual**; SHR-05/06/17, DIR-01–07 | `privacy.ts:60–63` allows directory/catalog identifiers and text; `:67–90` checks structural fields/meta/extensions but has no configured patient-identifier-system denial or D1 text masks. Location prose residual is documented at :29. | Deny configured patient Identifier systems/Patient/RelatedPerson references globally in shared instances; add D1 field masks and labelled omissions. Never match canary literals. Freeze operator-attested residual list. | A configured patient Identifier is structured identity, not a prose judgment. Remaining attested name/display semantics are uncounted residual. Privacy-owner policy change, S3 eligibility coordination, S5 integration. |
| **G8 opaque continuation execution evidence — Medium, B3 portion only**; CNT-22/23 | `index.ts:710` permits root _getpages; :722 bypasses missing-material check for that form; :685 reauthorizes every entry. :703 labels generic unverified_continuation. | Keep only D3 exception, sticky explicit CONTINUATION_QUERY_UNVERIFIED, no complete_for_query even at terminal chain, delivered-only counts. Explicit conflicting pairs refused at :713–719. | Opaque query-binding uncertainty alone weakens completeness, not a new confidentiality bypass while reauthorization holds. CNT-22's foreign-output variant counts B2 via that authorization decision, not by counting a label downgrade. S4 immutable query evidence / S5 envelopes, with S6 adapter eligibility if used. |

No current parameter-pollution defect is asserted: `index.ts:647` uses URLSearchParams.append, while transport `:202–208` checks URL/base/components. HPP guards remain required regressions. No current duplicate-key/prototype/MCP-method exploit is asserted; ADM/PAR are test obligations. History stays unimplemented (`contracts.ts:21`, `:215` literal read); `privacy.ts:102–105`, `:181–184` already recognizes versioned references. No SMART or vendor claim follows from any of these static observations.

## 7. Sequencing and claim discipline

Adopt D4: freeze this v1 design case list/signatures/control/matrix/residual/mutant **intents before S3 if still possible, at latest before S5**. If a checkpoint already landed, record timing honestly and label its runs diagnostic; do not backdate preregistration. Land infrastructure + first slice as a non-gating diagnostic CI job before S3 where feasible, with a schema-specific extractor. Preserve all mandatory S1–S6/CA-ISO checks and S5 atomicity. Freeze full exact expected 0.2 outputs after S5, without changing the earlier threat model or dropping cases. Version any substantive case change as v2 with review/diff.

Qualify only after accepted **S5, S5b and S6**, on the **S9 packaged installed build**, twice, plus OCI cells only if claimed. Freeze live mutant anchors and candidate/installed dependency hashes after integration. Bind reports to final S12 artifacts; later material changes require dependent reruns. Keep failures and prior manifests. A diagnostic first-slice result or missing B2 gate cannot be called a passing release; S12 records unmet/deferred honestly.

Allowed now: “We have designed a synthetic patient-isolation catalogue with 216 proposed independent attack/control cases. It has not been run or passed.” Allowed only after full qualification: “At [commit/package/artifact hash], local stdio single-patient synthetic manifest [hash] passed [N] reviewed independent applicable cases in [eras], with zero prohibited disclosures detected by its declared oracle and zero clinical mutations; every required control passed and every designated critical guard mutant was killed.” Link complete reports and exclusions: timing, semantic A prose/listed directory fields, remote/SMART, real EHRs/clinical validation, multipatient/tenant operation. Zero observed leakage is not proof of universal confidentiality.

PLAN **A1** efficiency/workload/default rules remain untouched: B2 handcrafted fixtures establish no token saving, fidelity-at-equal-efficiency or compact-default win. PLAN **A7** requires pinned native head-to-head artifacts and independent reproduction before comparative superiority. No competitor code was run here; no “more secure,” exclusive safety, vendor/protocol/host support, SMART authorization or clinical/production readiness claim is earned. Prompt-injection tests prove deterministic gateway non-execution/framing, not downstream model obedience.

Later competitor work remains a separate root-owned, explicitly scoped sandbox lane. No install/build/import/run of competitor code in this design task. Native adapters cannot add missing confinement, post-filter foreign records or repair output and call that native protection. Equal authority, complete supported/unsupported denominators, pinned revisions, common synthetic inputs, method/write journals, independent sinks/scanners and independent reproduction are required under A7. The static-source observations in research/12 do not establish runtime exploitability or backend permissions. No external message or disclosure is authorized by this document.

## Appendix A — B3 completeness (not counted)

These **27** original IDs stay in the suite's non-B2 ledger. B3/robustness cases have controls and failure visibility, but cannot contribute to the ≥200 count or imply research/11's independent ≥60-case B3 gate passed.

| IDs | Reason outside B2 |
| --- | --- |
| CNT-03/04/07/08/24 | Dropped code/date/multiplicity/sort while patient confinement remains: authorized A completeness/fidelity. Patient-bearing constraint loss remains CNT-02/06/09/21. |
| OUT-01/02/10/12 | Warning/error/incompleteness/contradictory-execution interpretation alone does not disclose protected data. Prose leaks are OUT-03/05/07/09. |
| NUM-06/07 | Budget/precision totals over authorized delivered A prefix are completeness, not foreign population disclosure. |
| RAC-03/08/09 | Fresh queued success/shared-waiter liveness; mere loss of A work is not invalidated evidence disclosure. |
| HND-02/08/10/11/13/14 | Reservation cleanup, unsent authorized A slice, offsets, eviction, selected-field conflicts and output rollback without protected/revoked evidence are retention/fidelity/robustness. Protected backing and revocation variants stay HND-06/07/09 and RAC/LIF. |
| CUR-02/11/12/14 | Replay stability, restart-empty store, duplicate fetch and A-only chain-digest correctness without a protected binding transition are robustness/coverage. Cross-binding/kind/epoch rows remain counted. |
| ERR-10 | Availability of unrelated concurrent A work is distinct from ERR-01's existence/state oracle and invalidated-authority delivery. |
| INJ-05 | Forged next_cursor/complete_for_query/[link withheld]/citation vocabulary must stay distinguishable as data, but framing/integrity alone is B3; induced forbidden requests are ADM-04/INJ-02. |
| LOG-08 | Bounded audit ring/eviction robustness; no disclosed audit surface is implemented. |

Additional execution vectors, **not new counted IDs**: `_elements`/`_summary` stripping linkage must suppress/refuse rather than deliver unverified resources; their A-only completeness labels are B3. Suppressed foreign byte volume and page topology receive honest UPSTREAM_LIMIT/partial checks, but population-dependent resource budgets are declared residual signals, not twin equality. Wrong types, 256 KiB/deep raw frames, Unicode confusables, zero-width/NUL in type/alias/id/params are bounded-admission/diagnostic vectors under ADM/PTH/HPP and scanner liveness; mere resource exhaustion is not B2 disclosure.

## Appendix B — Other uncounted scope

- **MET-10 (1 S2 case):** source-prose-only revision/twin stability, normalized capability identity; not isolation by itself.
- **SHR-07 (1 residual case):** semantic foreign content inside otherwise operator-attested Medication display. Organization.name portion of old SHR-06 is also a residual vector; SHR-06 counts only its explicit alias mask. The frozen D1 field list is uncounted semantic scope, not dozens of artificial residual cases.
- Timing confidentiality, arbitrary semantic PHI detection, remote sessions/principals/SMART, replicas, unimplemented historical entry authorization and real vendor/clinical environments are out of scope, never absent-as-passed. Future support adds tests before claims.

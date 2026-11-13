// Annotations come from Scribe v3 Live entity detection. The server tags each
// committed transcript segment with entities (names, products, file names,
// document sections, …); we keep the ones worth highlighting while dictating
// and group them into a handful of visual kinds.

export type AnnotationKind =
  | "person"
  | "tool"
  | "org"
  | "file"
  | "ref"
  | "place"
  | "time"
  | "money";

/** A highlighted span. Offsets are JS string indices into the text it belongs to. */
export interface Annotation {
  start: number;
  end: number;
  /** Raw Scribe entity label, e.g. "product_or_service". */
  label: string;
}

/** Entity shape in Scribe's `committed_transcript_entities` message. */
export interface RawEntity {
  text: string;
  entity_type: string;
  start_char: number;
  end_char: number;
}

// Label → kind. Order of KIND_PRIORITY decides which kind wins when Scribe
// tags the same span twice (it reports "LinkedIn" as both organization and
// product_or_service — for dictation the "tool" reading is the useful one).
const LABEL_KIND: Record<string, AnnotationKind> = {
  name: "person",
  name_given: "person",
  name_family: "person",
  username: "person",
  product_or_service: "tool",
  organization: "org",
  filename: "file",
  url: "file",
  email_address: "file",
  document_reference: "ref",
  event: "ref",
  location: "place",
  location_city: "place",
  location_country: "place",
  date: "time",
  money: "money",
};

const KIND_PRIORITY: AnnotationKind[] = [
  "file",
  "tool",
  "person",
  "org",
  "ref",
  "place",
  "time",
  "money",
];

export const KIND_LABEL: Record<AnnotationKind, string> = {
  person: "Person",
  tool: "Tool",
  org: "Organization",
  file: "File / link",
  ref: "Reference",
  place: "Place",
  time: "Date",
  money: "Amount",
};

/** Entity labels requested from Scribe (`entity_detection` query params). */
export const ENTITY_LABELS = Object.keys(LABEL_KIND);

export function kindOf(label: string): AnnotationKind | undefined {
  return LABEL_KIND[label];
}

/**
 * Turn raw entities into clean, non-overlapping annotations for `text`.
 * Offsets are re-anchored against the text itself (Scribe counts code points,
 * JS strings count UTF-16 units), duplicates on the same span collapse to the
 * highest-priority kind, and overlapping spans keep the longest, earliest one.
 */
export function toAnnotations(text: string, raw: RawEntity[]): Annotation[] {
  const placed: Annotation[] = [];
  for (const e of raw) {
    if (!kindOf(e.entity_type) || !e.text) continue;
    const start = locate(text, e);
    if (start < 0) continue;
    placed.push({ start, end: start + e.text.length, label: e.entity_type });
  }

  const rank = (a: Annotation) => KIND_PRIORITY.indexOf(kindOf(a.label)!);
  placed.sort((a, b) => a.start - b.start || b.end - a.end || rank(a) - rank(b));

  const out: Annotation[] = [];
  let lastEnd = -1;
  for (const a of placed) {
    if (a.start < lastEnd) continue;
    out.push(a);
    lastEnd = a.end;
  }
  return out;
}

function locate(text: string, e: RawEntity): number {
  if (text.slice(e.start_char, e.end_char) === e.text) return e.start_char;
  const near = text.indexOf(e.text, Math.max(0, e.start_char - 8));
  return near >= 0 ? near : text.indexOf(e.text);
}

export interface Segment {
  text: string;
  annotations: Annotation[];
  /** True while Scribe hasn't (or never will have) sent this segment's entities. */
  pending: boolean;
}

// Kinds safe to re-highlight by exact text match. Dates and amounts are left
// out: as bare words ("today", "five") they'd light up everywhere.
const PROVISIONAL_KINDS = new Set<AnnotationKind>(["person", "tool", "org", "file", "ref"]);

export type TermMatcher = (text: string) => Annotation[];

/**
 * Build a matcher that highlights terms Scribe has already annotated (earlier
 * in this session or in past transcriptions) wherever they reappear. Scribe
 * only annotates committed segments, so this is what lets a known name or tool
 * light up in the in-progress transcript the moment it's spoken. Later sources
 * win when a term was labeled differently. Matching is case-sensitive and on
 * whole words, so "Will" the person doesn't tag "will" the verb.
 */
export function buildTermMatcher(
  sources: { text: string; annotations: Annotation[] }[]
): TermMatcher {
  const terms = new Map<string, string>();
  for (const { text, annotations } of sources) {
    for (const a of annotations) {
      const kind = kindOf(a.label);
      if (!kind || !PROVISIONAL_KINDS.has(kind)) continue;
      const term = text.slice(a.start, a.end);
      if (term.trim().length >= 2) terms.set(term, a.label);
    }
  }
  if (!terms.size) return () => [];

  const alternatives = [...terms.keys()]
    .sort((a, b) => b.length - a.length) // longest first: "Claude Code" before "Claude"
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`,
    "gu"
  );

  return (text) => {
    const out: Annotation[] = [];
    for (const m of text.matchAll(re)) {
      out.push({ start: m.index, end: m.index + m[0].length, label: terms.get(m[0])! });
    }
    return out;
  };
}

/** Join segments into the final dictation text, shifting annotation offsets. */
export function flattenSegments(segments: Segment[]): { text: string; annotations: Annotation[] } {
  let text = "";
  const annotations: Annotation[] = [];
  for (const seg of segments) {
    const t = seg.text.trim();
    if (!t) continue;
    if (text) text += " ";
    const lead = seg.text.indexOf(t);
    for (const a of seg.annotations) {
      annotations.push({
        start: a.start - lead + text.length,
        end: a.end - lead + text.length,
        label: a.label,
      });
    }
    text += t;
  }
  return { text, annotations };
}

export interface AnnotationChip {
  text: string;
  kind: AnnotationKind;
  label: string;
  count: number;
}

/** Unique annotated terms (case-insensitive) in order of first mention. */
export function uniqueChips(
  items: { text: string; annotations: Annotation[] }[]
): AnnotationChip[] {
  const byKey = new Map<string, AnnotationChip>();
  for (const { text, annotations } of items) {
    for (const a of annotations) {
      const kind = kindOf(a.label);
      if (!kind) continue;
      const term = text.slice(a.start, a.end);
      const key = `${kind}:${term.toLowerCase()}`;
      const chip = byKey.get(key);
      if (chip) chip.count++;
      else byKey.set(key, { text: term, kind, label: a.label, count: 1 });
    }
  }
  return [...byKey.values()];
}

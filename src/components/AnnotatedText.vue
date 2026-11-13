<script setup lang="ts">
import { computed } from "vue";
import { kindOf, KIND_LABEL, type Annotation, type AnnotationKind } from "../lib/annotations";

const props = defineProps<{
  text: string;
  annotations?: Annotation[];
  /** Truncate to this many characters (with an ellipsis), keeping highlights. */
  maxLength?: number;
}>();

type Piece = { text: string; kind?: AnnotationKind; title?: string };

const pieces = computed<Piece[]>(() => {
  const truncated = props.maxLength !== undefined && props.text.length > props.maxLength;
  const text = truncated ? props.text.slice(0, props.maxLength) : props.text;

  const out: Piece[] = [];
  let cursor = 0;
  for (const a of props.annotations ?? []) {
    const kind = kindOf(a.label);
    if (!kind || a.start < cursor || a.end > text.length) continue;
    if (a.start > cursor) out.push({ text: text.slice(cursor, a.start) });
    out.push({
      text: text.slice(a.start, a.end),
      kind,
      title: `${KIND_LABEL[kind]} · ${a.label.replace(/_/g, " ")}`,
    });
    cursor = a.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  if (truncated) out.push({ text: "…" });
  return out;
});
</script>

<template>
  <template v-for="(p, i) in pieces" :key="i">
    <mark v-if="p.kind" class="annotation" :class="`kind-${p.kind}`" :title="p.title">{{
      p.text
    }}</mark>
    <template v-else>{{ p.text }}</template>
  </template>
</template>

<style>
/* Global (not scoped): shared by the overlay, history list and chips. */
.annotation {
  color: inherit;
  background: color-mix(in srgb, var(--annotation-color) 18%, transparent);
  box-shadow: inset 0 -1.5px 0 color-mix(in srgb, var(--annotation-color) 75%, transparent);
  border-radius: 3px;
  padding: 0 1px;
  animation: annotation-in 0.35s ease-out;
}

.annotation.kind-file {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 0.92em;
}

.kind-person {
  --annotation-color: #fbbf24;
}
.kind-tool {
  --annotation-color: #38bdf8;
}
.kind-org {
  --annotation-color: #a78bfa;
}
.kind-file {
  --annotation-color: #34d399;
}
.kind-ref {
  --annotation-color: #f472b6;
}
.kind-place {
  --annotation-color: #fb923c;
}
.kind-time {
  --annotation-color: #94a3b8;
}
.kind-money {
  --annotation-color: #a3e635;
}

@keyframes annotation-in {
  from {
    background: color-mix(in srgb, var(--annotation-color) 45%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .annotation {
    animation: none;
  }
}
</style>

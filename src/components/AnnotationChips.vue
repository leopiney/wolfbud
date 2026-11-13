<script setup lang="ts">
import { KIND_LABEL, type AnnotationChip } from "../lib/annotations";

defineProps<{ chips: AnnotationChip[] }>();
</script>

<template>
  <div v-if="chips.length" class="chips" aria-label="Annotations">
    <span
      v-for="chip in chips"
      :key="`${chip.kind}:${chip.text.toLowerCase()}`"
      class="chip"
      :class="`kind-${chip.kind}`"
      :title="KIND_LABEL[chip.kind]"
    >
      <span class="chip-dot"></span>
      <span class="chip-text">{{ chip.text }}</span>
      <span v-if="chip.count > 1" class="chip-count">×{{ chip.count }}</span>
    </span>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  gap: 5px;
  overflow-x: auto;
  scrollbar-width: none;
  flex-shrink: 0;
  padding: 2px 0;
  mask-image: linear-gradient(to right, black calc(100% - 24px), transparent);
}

.chips::-webkit-scrollbar {
  display: none;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  max-width: 180px;
  padding: 2px 8px 2px 6px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
  color: rgba(255, 255, 255, 0.85);
  background: color-mix(in srgb, var(--annotation-color) 14%, rgba(255, 255, 255, 0.04));
  border: 1px solid color-mix(in srgb, var(--annotation-color) 35%, transparent);
  animation: chip-in 0.25s ease-out;
}

.chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--annotation-color);
  flex-shrink: 0;
}

.chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip.kind-file .chip-text {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}

.chip-count {
  color: rgba(255, 255, 255, 0.45);
  font-variant-numeric: tabular-nums;
}

@keyframes chip-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .chip {
    animation: none;
  }
}
</style>

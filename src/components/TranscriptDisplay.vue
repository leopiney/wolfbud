<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import AnnotatedText from "./AnnotatedText.vue";
import type { Annotation, Segment } from "../lib/annotations";

const props = defineProps<{
  isRecording: boolean;
  partialText: string;
  segments: Segment[];
  partialAnnotations?: Annotation[];
}>();

const transcriptEl = ref<HTMLElement | null>(null);

function scrollToBottom() {
  nextTick(() => {
    if (transcriptEl.value) {
      transcriptEl.value.scrollTop = transcriptEl.value.scrollHeight;
    }
  });
}

watch(() => props.segments.length, scrollToBottom);
watch(() => props.partialText, scrollToBottom);
</script>

<template>
  <div ref="transcriptEl" class="transcript">
    <span class="committed">
      <template v-for="(seg, i) in segments" :key="i">
        <!-- Untrimmed: annotation offsets index into the raw segment text. -->
        <AnnotatedText :text="seg.text" :annotations="seg.annotations" />{{ " " }}
      </template>
    </span>
    <span class="partial"
      ><AnnotatedText :text="partialText" :annotations="partialAnnotations"
    /></span>
    <span v-if="isRecording && !segments.length && !partialText" class="placeholder">
      Start speaking…
    </span>
  </div>
</template>

<style scoped>
.transcript {
  min-height: 44px;
  font-size: 14px;
  line-height: 1.55;
  padding: 4px 0;
  word-break: break-word;
  overflow-y: auto;
  flex: 1 1 0;
}

.committed {
  color: rgba(255, 255, 255, 0.95);
}

.partial {
  color: rgba(255, 255, 255, 0.45);
}

.placeholder {
  color: rgba(255, 255, 255, 0.3);
  font-style: italic;
}
</style>

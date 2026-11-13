<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import RecordingDot from "./components/RecordingDot.vue";
import WolfBadge from "./components/WolfBadge.vue";
import TranscriptDisplay from "./components/TranscriptDisplay.vue";
import ActionBar from "./components/ActionBar.vue";
import AnnotationChips from "./components/AnnotationChips.vue";
import ChunkProgress from "./components/ChunkProgress.vue";
import PlaybackControls from "./components/PlaybackControls.vue";
import SetupScreen from "./components/SetupScreen.vue";
import { useScribe } from "./composables/useScribe";
import { useReadAloud } from "./composables/useReadAloud";
import { useTauriEvents } from "./composables/useTauriEvents";
import {
  buildTermMatcher,
  flattenSegments,
  uniqueChips,
  type Annotation,
  type Segment,
} from "./lib/annotations";

// ── Tab state ────────────────────────────────────────────────────────────────
const activeTab = ref<"scribe" | "readaloud">("scribe");

// ── Shared state ─────────────────────────────────────────────────────────────
const needsSetup = ref(false);
const errorMsg = ref("");

// ── Scribe ───────────────────────────────────────────────────────────────────
const isRecording = ref(false);
const {
  partialText,
  segments,
  committedText,
  reset: resetTranscript,
  micLabel,
  error: scribeError,
  audioLevel,
  needsMicPermission,
  start: scribeStart,
  stop: scribeStop,
  acquireMic,
  isLive: scribeIsLive,
} = useScribe();

// ── Live annotations ─────────────────────────────────────────────────────────
// Scribe only annotates committed segments, so anything still being spoken (or
// committed but awaiting its entities) gets provisional highlights from terms
// Scribe already recognized — earlier this session or in past transcriptions.
// Scribe's own annotations replace them as soon as they arrive.
const historyTerms = ref<{ text: string; annotations: Annotation[] }[]>([]);

async function loadHistoryTerms() {
  try {
    const entries =
      await invoke<{ kind: string; text: string; annotations?: Annotation[] }[]>("get_history");
    historyTerms.value = entries
      .filter((e) => e.kind === "scribe" && e.annotations?.length)
      .map((e) => ({ text: e.text, annotations: e.annotations! }))
      .reverse(); // oldest first, so the most recent labeling wins
  } catch (e) {
    console.warn("[wolfbud] couldn't load history terms:", e);
  }
}

const matchKnownTerms = computed(() =>
  buildTermMatcher([...historyTerms.value, ...segments.value.filter((s) => !s.pending)])
);

const liveSegments = computed<Segment[]>(() =>
  segments.value.map((s) => (s.pending ? { ...s, annotations: matchKnownTerms.value(s.text) } : s))
);

const partialAnnotations = computed(() => matchKnownTerms.value(partialText.value));

const chips = computed(() =>
  uniqueChips([
    ...liveSegments.value,
    { text: partialText.value, annotations: partialAnnotations.value },
  ])
);

// ── Read Aloud ───────────────────────────────────────────────────────────────
const readaloudErrorMsg = ref("");
const readaloudText = ref(""); // text being read aloud (from clipboard)

const {
  isPlaying,
  isPaused,
  isLoading,
  currentChunkIndex,
  totalChunks,
  chunkPreview,
  error: readaloudError,
  start: readaloudStart,
  stop: readaloudStop,
  pause,
  resume,
  prev,
  next,
  cleanup: readaloudCleanup,
} = useReadAloud();

// ── Scribe actions ───────────────────────────────────────────────────────────

async function startRecording() {
  resetTranscript();
  loadHistoryTerms();
  errorMsg.value = "";
  try {
    await scribeStart();
    isRecording.value = true;
  } catch (err) {
    if (!needsMicPermission.value) {
      errorMsg.value = String(err);
    }
    console.error("[wolfbud] startRecording failed:", err);
  }
}

async function grantMicAndRecord() {
  errorMsg.value = "";
  try {
    await acquireMic();
    await startRecording();
  } catch (err) {
    errorMsg.value = String(err);
  }
}

/** Copy the finished dictation and store it (with its annotations) in history. */
async function saveTranscript() {
  const { text, annotations } = flattenSegments(liveSegments.value);
  if (!text) return;
  await writeText(text).catch(console.error);
  await invoke("save_transcription", { text, annotations }).catch(console.error);
}

async function stopRecording() {
  try {
    await scribeStop();
  } catch (err) {
    console.error("Error stopping recording:", err);
  }
  isRecording.value = false;
  await saveTranscript();
}

async function stopAndDismiss() {
  try {
    await scribeStop();
  } catch (err) {
    console.error("Error stopping recording:", err);
  }
  isRecording.value = false;
  await saveTranscript();
  await invoke("hide_overlay").catch(console.error);
}

async function toggleScribe() {
  if (needsSetup.value) return;

  if (isRecording.value) {
    if (scribeIsLive()) {
      await stopAndDismiss();
      return;
    }
    // Flag left stuck-true by an interrupted session (e.g. the window was
    // closed mid-recording) — clear it and start fresh instead of swallowing
    // this press as a no-op stop.
    isRecording.value = false;
  }

  const hasKey = await invoke<boolean>("has_api_key");
  if (!hasKey) {
    needsSetup.value = true;
    return;
  }

  activeTab.value = "scribe";
  await startRecording();
}

async function paste() {
  const text = committedText.value.trim();
  if (!text) return;
  await writeText(text);
  await invoke("paste_text", { text }).catch((err: unknown) => {
    errorMsg.value = String(err);
  });
}

async function copyOnly() {
  const text = committedText.value.trim();
  if (!text) return;
  await writeText(text).catch(console.error);
  await invoke("hide_overlay").catch(console.error);
}

// ── Read Aloud actions ───────────────────────────────────────────────────────

async function startReadAloud() {
  readaloudErrorMsg.value = "";
  readaloudText.value = "";
  try {
    const clipboardText = await readText();
    if (!clipboardText || !clipboardText.trim()) {
      readaloudErrorMsg.value = "Clipboard is empty";
      return;
    }
    readaloudText.value = clipboardText.trim();
    const audioId = await readaloudStart(clipboardText);
    // Save history immediately — audio chunks are cached to disk as they stream,
    // so even partial sessions are preserved if the user stops early.
    if (audioId) {
      await invoke("save_readaloud", { text: readaloudText.value, audioId }).catch(console.error);
    }
  } catch (err) {
    readaloudErrorMsg.value = String(err);
    console.error("[readaloud] start failed:", err);
  }
}

async function toggleReadAloud() {
  if (needsSetup.value) return;

  if (isPlaying.value) {
    await readaloudStop();
    await startReadAloud();
    return;
  }

  const hasKey = await invoke<boolean>("has_api_key");
  if (!hasKey) {
    needsSetup.value = true;
    return;
  }

  activeTab.value = "readaloud";
  await startReadAloud();
}

async function stopReadAloudAndDismiss() {
  await readaloudStop();
  await invoke("hide_overlay").catch(console.error);
}

function togglePause() {
  if (isPaused.value) {
    resume();
  } else {
    pause();
  }
}

// ── Shared ───────────────────────────────────────────────────────────────────

async function dismiss() {
  if (isRecording.value) {
    try {
      await scribeStop();
    } catch {
      /* ignore */
    }
    isRecording.value = false;
  }
  if (isPlaying.value) {
    await readaloudStop();
  }
  await invoke("hide_overlay").catch(console.error);
}

async function onSetupDone() {
  needsSetup.value = false;
  if (activeTab.value === "scribe") {
    await startRecording();
  } else {
    await startReadAloud();
  }
}

// ── State reset ────────────────────────────────────────────────────────────

/** Tear down any in-flight STT/TTS session and clear stuck flags/errors. Runs
 * when the overlay is hidden via the native close button or the tray Reset. */
async function forceResetState() {
  if (isRecording.value) {
    try {
      await scribeStop();
    } catch {
      /* ignore */
    }
    isRecording.value = false;
  }
  if (isPlaying.value) {
    await readaloudStop().catch(() => undefined);
  }
  errorMsg.value = "";
  readaloudErrorMsg.value = "";
}

onUnmounted(() => {
  readaloudCleanup();
  scribeStop().catch(() => undefined);
});

// Check key status on load
invoke<boolean>("has_api_key").then((hasKey) => {
  needsSetup.value = !hasKey;
});

// If this overlay was just rebuilt to recover a lost window, the shortcut press
// that triggered the rebuild was stashed in the backend (the WebView wasn't
// listening yet) — pull and run it so recovery works on the first press.
invoke<string | null>("take_pending_action")
  .then((action) => {
    if (action === "toggle-recording") toggleScribe();
    else if (action === "toggle-readaloud") toggleReadAloud();
  })
  .catch(() => undefined);

// ── Wolf badge ───────────────────────────────────────────────────────────────

/** The wolf talks while the mic is live or while we're actually speaking —
 *  a paused read-aloud shuts its mouth. */
const wolfState = computed<"idle" | "recording" | "reading">(() =>
  isRecording.value ? "recording" : isPlaying.value && !isPaused.value ? "reading" : "idle"
);
const wolfLevel = computed(() => (isRecording.value ? audioLevel.value : 0));

// Mirror the overlay's activity into the tray status line on every transition.
const currentActivity = computed(() =>
  isRecording.value ? "recording" : isPlaying.value ? "reading" : "idle"
);
watch(
  currentActivity,
  (kind) => {
    invoke("set_activity", { kind }).catch(() => undefined);
  },
  { immediate: true }
);

useTauriEvents("toggle-recording", toggleScribe);
useTauriEvents("toggle-readaloud", toggleReadAloud);
useTauriEvents("show-setup", () => {
  needsSetup.value = true;
});
// Native close button (handled in Rust) hides the overlay — reset our state so
// the next shortcut press starts clean instead of stopping a phantom session.
useTauriEvents("overlay-hidden", () => {
  forceResetState();
});
// Tray "Reset / Recover" — full teardown.
useTauriEvents("reset-overlay", async () => {
  await forceResetState();
  readaloudCleanup();
});
</script>

<template>
  <div class="overlay-wrapper">
    <WolfBadge
      class="wolf-badge-anchor"
      :state="wolfState"
      :talking="wolfState !== 'idle'"
      :level="wolfLevel"
      :size="59"
    />
    <div class="card">
      <SetupScreen v-if="needsSetup" @done="onSetupDone" />

      <template v-else>
        <!-- Tab bar (drag region for moving the window) -->
        <div class="tab-bar" data-tauri-drag-region>
          <button
            class="tab"
            :class="{ active: activeTab === 'scribe' }"
            @click="activeTab = 'scribe'"
          >
            Scribe
          </button>
          <button
            class="tab"
            :class="{ active: activeTab === 'readaloud' }"
            @click="activeTab = 'readaloud'"
          >
            Read Aloud
          </button>
          <div class="tab-spacer"></div>

          <!-- Scribe controls -->
          <template v-if="activeTab === 'scribe'">
            <button
              v-if="needsMicPermission"
              class="btn-toggle btn-grant"
              @click="grantMicAndRecord"
            >
              Grant Microphone
            </button>
            <button
              v-else
              class="btn-toggle"
              @click="isRecording ? stopRecording() : toggleScribe()"
            >
              {{ isRecording ? "Stop" : "Record" }}
            </button>
          </template>

          <!-- Read Aloud controls -->
          <template v-if="activeTab === 'readaloud'">
            <button
              class="btn-toggle"
              @click="isPlaying ? stopReadAloudAndDismiss() : toggleReadAloud()"
            >
              {{ isPlaying ? "Stop" : "Start" }}
            </button>
          </template>

          <button class="btn-close" title="Close" @click="dismiss">&times;</button>
        </div>

        <!-- SCRIBE TAB -->
        <template v-if="activeTab === 'scribe'">
          <div class="card-status">
            <RecordingDot :active="isRecording" />
            <span class="status-label">
              <span v-if="needsMicPermission" class="error-text">Microphone access required</span>
              <span v-else-if="errorMsg || scribeError" class="error-text">{{
                errorMsg || scribeError
              }}</span>
              <template v-else-if="isRecording">
                Recording…<template v-if="micLabel"> · {{ micLabel }}</template>
              </template>
              <template v-else>Ready</template>
            </span>
          </div>
          <div v-if="isRecording" class="level-bar-track">
            <div class="level-bar-fill" :style="{ width: audioLevel * 100 + '%' }"></div>
          </div>
          <TranscriptDisplay
            :is-recording="isRecording"
            :partial-text="partialText"
            :segments="liveSegments"
            :partial-annotations="partialAnnotations"
          />
          <AnnotationChips :chips="chips" />
          <ActionBar
            v-if="!isRecording && committedText.trim()"
            @paste="paste"
            @copy="copyOnly"
            @dismiss="dismiss"
          />
        </template>

        <!-- READ ALOUD TAB -->
        <template v-if="activeTab === 'readaloud'">
          <div class="card-status">
            <div class="speaker-dot" :class="{ active: isPlaying && !isPaused }"></div>
            <span class="status-label">
              <span v-if="readaloudErrorMsg || readaloudError" class="error-text">{{
                readaloudErrorMsg || readaloudError
              }}</span>
              <template v-else-if="isPlaying">
                Reading aloud
                <template v-if="totalChunks > 1">
                  · {{ currentChunkIndex + 1 }}/{{ totalChunks }}
                </template>
                <template v-if="isPaused"> (paused)</template>
              </template>
              <template v-else>Ready · ⌥⇧Space to read clipboard</template>
            </span>
          </div>

          <ChunkProgress
            v-if="isPlaying || totalChunks > 0"
            :current-index="currentChunkIndex"
            :total="totalChunks"
            :preview="chunkPreview"
            :is-loading="isLoading"
          />

          <PlaybackControls
            v-if="isPlaying"
            :is-paused="isPaused"
            :can-prev="currentChunkIndex > 0"
            :can-next="currentChunkIndex < totalChunks - 1"
            @prev="prev"
            @next="next"
            @toggle-pause="togglePause"
            @dismiss="dismiss"
          />
        </template>
      </template>
    </div>
  </div>
</template>

<style>
/* The window is transparent and undecorated — the card below paints the only
   opaque surface, so the wolf badge can hang off its top-left corner. */
html,
body {
  margin: 0;
  padding: 0;
  background: transparent;
  overflow: hidden;
}
</style>

<style scoped>
.overlay-wrapper {
  position: relative;
  width: 100vw;
  height: 100vh;
  /* Room for the badge overhang (top/left) and the card's drop shadow. */
  padding: 40px 12px 12px 40px;
  box-sizing: border-box;
}

.wolf-badge-anchor {
  position: absolute;
  /* Held off the window's own edge: the state ring and its glow are painted
     outside the badge's box, and the window clips anything past 0. */
  top: 6px;
  left: 6px;
  z-index: 5;
}

.card {
  position: relative;
  background: rgba(20, 20, 20, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.55);
  color: white;
  width: 100%;
  height: 100%;
  padding: 14px 16px;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Tab bar ────────────────────────────────────────────────────────────── */

.tab-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  /* Clear the slice of badge that overlaps the card's top-left corner. */
  padding-left: 12px;
  margin-bottom: 8px;
  flex-shrink: 0;
}

.tab {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;
}

.tab:hover {
  color: rgba(255, 255, 255, 0.7);
  background: rgba(255, 255, 255, 0.06);
}

.tab.active {
  color: white;
  background: rgba(255, 255, 255, 0.12);
}

.tab-spacer {
  flex: 1;
}

/* ── Status row ─────────────────────────────────────────────────────────── */

.card-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-shrink: 0;
}

.status-label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error-text {
  color: #f87171;
}

/* ── Buttons ────────────────────────────────────────────────────────────── */

.btn-toggle {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: white;
  border-radius: 8px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s;
  flex-shrink: 0;
}

.btn-toggle:hover {
  background: rgba(255, 255, 255, 0.2);
}

.btn-close {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.35);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
  flex-shrink: 0;
  transition:
    color 0.15s,
    background 0.15s;
}

.btn-close:hover {
  color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.1);
}

.btn-grant {
  background: rgba(99, 102, 241, 0.75);
  border-color: rgba(99, 102, 241, 0.9);
}

.btn-grant:hover {
  background: rgba(99, 102, 241, 1);
}

/* ── Level bar ──────────────────────────────────────────────────────────── */

.level-bar-track {
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.08);
  margin-bottom: 8px;
  overflow: hidden;
  flex-shrink: 0;
}

.level-bar-fill {
  height: 100%;
  border-radius: 2px;
  background: #34d399;
  transition: width 0.05s linear;
}

/* ── Speaker dot (read aloud) ───────────────────────────────────────────── */

.speaker-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.25);
  flex-shrink: 0;
  transition: background 0.2s;
}

.speaker-dot.active {
  background: #6366f1;
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.6;
    transform: scale(0.85);
  }
}
</style>

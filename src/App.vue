<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { listen } from "@tauri-apps/api/event";
import AnnotatedText from "./components/AnnotatedText.vue";
import type { Annotation } from "./lib/annotations";

interface HistoryEntry {
  id: string;
  kind: "scribe" | "readaloud";
  text: string;
  timestamp: string;
  audio_id: string | null;
  annotations?: Annotation[];
}

const activeTab = ref<"scribe" | "readaloud">("scribe");
const entries = ref<HistoryEntry[]>([]);
const search = ref("");
const expandedId = ref<string | null>(null);
const copiedId = ref<string | null>(null);

// Inline audio playback state
const playingId = ref<string | null>(null);
let audioContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;

// Window close is intercepted in Rust (hide instead of destroy) for both
// windows, so no JS close guard is needed here.
onMounted(async () => {
  await loadHistory();
  listen("history-updated", loadHistory);
});

onUnmounted(() => {
  stopPlayback();
});

async function loadHistory() {
  try {
    entries.value = await invoke<HistoryEntry[]>("get_history");
  } catch (e) {
    console.error("Failed to load history:", e);
  }
}

const filtered = computed(() => {
  const q = search.value.toLowerCase().trim();
  return entries.value
    .filter((e) => e.kind === activeTab.value)
    .filter((e) => !q || e.text.toLowerCase().includes(q));
});

const grouped = computed(() => {
  const groups: { label: string; entries: HistoryEntry[] }[] = [];
  const now = new Date();
  const todayStr = dateKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = dateKey(yesterday);

  let currentLabel = "";
  let currentGroup: HistoryEntry[] = [];

  for (const entry of filtered.value) {
    const d = new Date(entry.timestamp);
    const dk = dateKey(d);
    let label: string;
    if (dk === todayStr) label = "Today";
    else if (dk === yesterdayStr) label = "Yesterday";
    else
      label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

    if (label !== currentLabel) {
      if (currentGroup.length > 0) {
        groups.push({ label: currentLabel, entries: currentGroup });
      }
      currentLabel = label;
      currentGroup = [entry];
    } else {
      currentGroup.push(entry);
    }
  }
  if (currentGroup.length > 0) {
    groups.push({ label: currentLabel, entries: currentGroup });
  }

  return groups;
});

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

const PREVIEW_LENGTH = 120;

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
}

async function copyEntry(entry: HistoryEntry) {
  await writeText(entry.text).catch(console.error);
  copiedId.value = entry.id;
  setTimeout(() => {
    if (copiedId.value === entry.id) copiedId.value = null;
  }, 1500);
}

function stopPlayback() {
  if (currentSource) {
    try {
      currentSource.onended = null;
      currentSource.stop();
    } catch {
      /* ignore */
    }
    currentSource = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => undefined);
    audioContext = null;
  }
  playingId.value = null;
}

async function replayEntry(entry: HistoryEntry) {
  if (!entry.audio_id) return;

  // If already playing this entry, stop it
  if (playingId.value === entry.id) {
    stopPlayback();
    return;
  }

  stopPlayback();
  playingId.value = entry.id;

  try {
    audioContext = new AudioContext();

    // Load all cached chunks sequentially
    let chunkIndex = 0;
    const buffers: AudioBuffer[] = [];
    while (true) {
      try {
        const base64 = await invoke<string>("get_cached_audio", {
          audioId: entry.audio_id,
          chunkIndex,
        });
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const buffer = await audioContext.decodeAudioData(bytes.buffer.slice(0));
        buffers.push(buffer);
        chunkIndex++;
      } catch {
        break; // no more chunks
      }
    }

    if (buffers.length === 0 || playingId.value !== entry.id) {
      stopPlayback();
      return;
    }

    // Play chunks in sequence
    async function playChain(index: number) {
      if (index >= buffers.length || playingId.value !== entry.id || !audioContext) {
        playingId.value = null;
        return;
      }
      const source = audioContext.createBufferSource();
      source.buffer = buffers[index];
      source.connect(audioContext.destination);
      currentSource = source;
      source.onended = () => playChain(index + 1);
      source.start(0);
    }
    playChain(0);
  } catch (e) {
    console.error("Replay failed:", e);
    stopPlayback();
  }
}

async function deleteEntry(entry: HistoryEntry) {
  try {
    await invoke("delete_history_entry", { id: entry.id });
  } catch (e) {
    console.error("Delete failed:", e);
  }
}

const showClearConfirm = ref(false);

async function clearAll() {
  try {
    await invoke("clear_history");
    showClearConfirm.value = false;
  } catch (e) {
    console.error("Clear failed:", e);
  }
}
</script>

<template>
  <div class="history-app">
    <!-- Header -->
    <div class="header">
      <div class="tabs">
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
      </div>
      <button
        v-if="filtered.length > 0 && !showClearConfirm"
        class="btn-clear"
        @click="showClearConfirm = true"
      >
        Clear All
      </button>
      <template v-if="showClearConfirm">
        <button class="btn-clear btn-danger" @click="clearAll">Confirm</button>
        <button class="btn-clear" @click="showClearConfirm = false">Cancel</button>
      </template>
    </div>

    <!-- Search -->
    <div class="search-bar">
      <input
        v-model="search"
        type="text"
        placeholder="Search transcriptions…"
        class="search-input"
      />
    </div>

    <!-- Entry list -->
    <div class="entry-list">
      <template v-if="grouped.length === 0">
        <div class="empty-state">
          <div class="empty-icon">{{ activeTab === "scribe" ? "🎙" : "🔊" }}</div>
          <div class="empty-text">
            {{ search ? "No matching entries" : "No history yet" }}
          </div>
          <div v-if="!search" class="empty-hint">
            {{
              activeTab === "scribe"
                ? "Transcriptions will appear here after you record."
                : "Read-aloud sessions will appear here after playback."
            }}
          </div>
        </div>
      </template>

      <template v-for="group in grouped" :key="group.label">
        <div class="day-label">{{ group.label }}</div>
        <div
          v-for="entry in group.entries"
          :key="entry.id"
          class="entry-card"
          @click="toggleExpand(entry.id)"
        >
          <div class="entry-header">
            <span class="entry-time">{{ formatTime(entry.timestamp) }}</span>
            <div class="entry-actions" @click.stop>
              <button
                v-if="entry.kind === 'readaloud' && entry.audio_id"
                class="btn-action"
                :class="{ 'btn-playing': playingId === entry.id }"
                @click="replayEntry(entry)"
              >
                {{ playingId === entry.id ? "Stop" : "Play" }}
              </button>
              <button
                class="btn-action btn-copy"
                :class="{ copied: copiedId === entry.id }"
                @click="copyEntry(entry)"
              >
                {{ copiedId === entry.id ? "Copied" : "Copy" }}
              </button>
              <button class="btn-action btn-delete" @click="deleteEntry(entry)">Delete</button>
            </div>
          </div>
          <div class="entry-text">
            <AnnotatedText
              :text="entry.text"
              :annotations="entry.annotations"
              :max-length="expandedId === entry.id ? undefined : PREVIEW_LENGTH"
            />
          </div>
        </div>
      </template>
    </div>

    <!-- Footer -->
    <div v-if="filtered.length > 0" class="footer">
      {{ filtered.length }} {{ activeTab === "scribe" ? "transcription" : "session"
      }}{{ filtered.length === 1 ? "" : "s" }}
    </div>
  </div>
</template>

<style>
html,
body {
  margin: 0;
  padding: 0;
  background: #141414;
  color: white;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
</style>

<style scoped>
.history-app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 16px;
  box-sizing: border-box;
}

/* ── Header ─────────────────────────────────────────────────────────────── */

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-shrink: 0;
}

.tabs {
  display: flex;
  gap: 4px;
  flex: 1;
}

.tab {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  font-size: 13px;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: 8px;
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

.btn-clear {
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.5);
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-clear:hover {
  color: rgba(255, 255, 255, 0.8);
  border-color: rgba(255, 255, 255, 0.3);
}

.btn-danger {
  color: #f87171;
  border-color: #f87171;
}

.btn-danger:hover {
  background: rgba(248, 113, 113, 0.15);
}

/* ── Search ─────────────────────────────────────────────────────────────── */

.search-bar {
  margin-bottom: 12px;
  flex-shrink: 0;
}

.search-input {
  width: 100%;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: white;
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 8px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}

.search-input::placeholder {
  color: rgba(255, 255, 255, 0.3);
}

.search-input:focus {
  border-color: rgba(255, 255, 255, 0.25);
}

/* ── Entry list ─────────────────────────────────────────────────────────── */

.entry-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.day-label {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.35);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 8px 0 4px;
}

.entry-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 6px;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}

.entry-card:hover {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.14);
}

.entry-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.entry-time {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
}

.entry-actions {
  display: flex;
  gap: 4px;
}

.btn-action {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.5);
  font-size: 11px;
  cursor: pointer;
  padding: 3px 8px;
  border-radius: 5px;
  transition: all 0.15s;
}

.btn-action:hover {
  color: rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.2);
}

.btn-playing {
  color: #6366f1;
  border-color: rgba(99, 102, 241, 0.4);
  background: rgba(99, 102, 241, 0.12);
}

.btn-copy.copied {
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.3);
}

.btn-delete:hover {
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.3);
  background: rgba(248, 113, 113, 0.12);
}

.entry-text {
  font-size: 13px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.8);
  word-break: break-word;
  white-space: pre-wrap;
}

/* ── Empty state ────────────────────────────────────────────────────────── */

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
  text-align: center;
}

.empty-icon {
  font-size: 32px;
  margin-bottom: 12px;
  opacity: 0.5;
}

.empty-text {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.5);
  margin-bottom: 4px;
}

.empty-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.3);
}

/* ── Footer ─────────────────────────────────────────────────────────────── */

.footer {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.3);
  text-align: center;
  padding-top: 8px;
  flex-shrink: 0;
}

/* ── Scrollbar ──────────────────────────────────────────────────────────── */

.entry-list::-webkit-scrollbar {
  width: 6px;
}

.entry-list::-webkit-scrollbar-track {
  background: transparent;
}

.entry-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
}

.entry-list::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.25);
}
</style>

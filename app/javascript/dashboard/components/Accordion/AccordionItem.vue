<script setup>
import EmojiOrIcon from 'shared/components/EmojiOrIcon.vue';

defineProps({
  title: {
    type: String,
    required: true,
  },
  compact: {
    type: Boolean,
    default: false,
  },
  icon: {
    type: String,
    default: '',
  },
  emoji: {
    type: String,
    default: '',
  },
  isOpen: {
    type: Boolean,
    default: true,
  },
});

const emit = defineEmits(['toggle']);

const onToggle = () => {
  emit('toggle');
};
</script>

<template>
  <div class="text-sm border-b border-n-weak dark:border-n-slate-7">
    <button
      class="flex items-center select-none w-full bg-transparent hover:bg-n-slate-1 dark:hover:bg-n-slate-8 transition-colors m-0 cursor-grab justify-between py-3 px-2 drag-handle"
      @click.stop="onToggle"
    >
      <div class="flex items-center gap-2">
        <div
          class="flex items-center justify-center text-n-slate-10 cursor-pointer"
        >
          <fluent-icon v-if="isOpen" size="14" icon="chevron-down" />
          <fluent-icon v-else size="14" icon="chevron-right" />
        </div>
        <EmojiOrIcon class="inline-block w-5" :icon="icon" :emoji="emoji" />
        <h5
          class="text-n-slate-11 text-xs font-bold uppercase tracking-wider mb-0 py-0"
        >
          {{ title }}
        </h5>
      </div>
      <div class="flex flex-row">
        <slot name="button" />
      </div>
    </button>
    <div v-if="isOpen" class="" :class="compact ? 'p-0' : 'px-2 py-4'">
      <slot />
    </div>
  </div>
</template>

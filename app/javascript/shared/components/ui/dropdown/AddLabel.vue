<script setup>
import Button from 'dashboard/components-next/button/Button.vue';

const props = defineProps({
  ghost: {
    type: Boolean,
    default: false,
  },
  iconOnly: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['add']);

const addLabel = () => {
  emit('add');
};
</script>

<template>
  <Button
    :faded="!ghost"
    :ghost="ghost"
    xs
    icon="i-lucide-plus"
    class="mb-0.5 ltr:mr-0.5 rtl:ml-0.5 !rounded-[4px]"
    :label="iconOnly ? '' : $t('CONTACT_PANEL.LABELS.CONVERSATION.ADD_BUTTON')"
    @click="addLabel"
  />
</template>

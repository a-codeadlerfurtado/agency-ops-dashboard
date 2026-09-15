<script>
import { getContrastingTextColor } from '@chatwoot/utils';

const PORTAL_DOMAINS = {
  vivareal: 'vivareal.com.br',
  zap: 'zapimoveis.com.br',
  zapimoveis: 'zapimoveis.com.br',
  'zap-imoveis': 'zapimoveis.com.br',
  imovelweb: 'imovelweb.com.br',
  chavesnamao: 'chavesnamao.com.br',
  'chaves-na-mao': 'chavesnamao.com.br',
  quintoandar: 'quintoandar.com.br',
  olx: 'olx.com.br',
  mercadolivre: 'mercadolivre.com.br',
  wimoveis: 'wimoveis.com.br',
  trafego: 'meta.com',
  whatsapp: 'whatsapp.com',
  casamineira: 'casamineira.com.br',
  'casa-mineira': 'casamineira.com.br',
  dfimoveis: 'dfimoveis.com.br',
  lugarcerto: 'lugarcerto.com.br',
  agenteimovel: 'agenteimovel.com.br',
  dreamcasa: 'dreamcasa.com.br',
  '123i': '123i.com.br',
  moving: 'moving.com.br',
  kenlo: 'kenlo.com.br',
  ingaia: 'ingaia.com.br',
  vista: 'vistasoft.com.br',
  universal: 'universalsoftware.com.br',
  imoview: 'imoview.com.br',
  facilita: 'appfacilita.com',
  arbo: 'arboimoveis.com.br',
  rdstation: 'rdstation.com',
  instagram: 'instagram.com',
  google: 'google.com',
  googleads: 'ads.google.com',
  tiktok: 'tiktok.com',
  youtube: 'youtube.com',
  linkedin: 'linkedin.com',
};

const getPortalDomain = title => {
  if (!title) return null;
  const key = title.toLowerCase().trim();
  return PORTAL_DOMAINS[key] || null;
};

export default {
  props: {
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
    href: {
      type: String,
      default: '',
    },
    bgColor: {
      type: String,
      default: '',
    },
    small: {
      type: Boolean,
      default: false,
    },
    showClose: {
      type: Boolean,
      default: false,
    },
    icon: {
      type: String,
      default: '',
    },
    color: {
      type: String,
      default: '',
    },
    colorScheme: {
      type: String,
      default: '',
    },
    variant: {
      type: String,
      default: '',
    },
  },
  emits: ['remove'],
  computed: {
    portalDomain() {
      return getPortalDomain(this.title);
    },
    computedIcon() {
      if (this.title && this.title.toLowerCase().trim() === 'site') {
        return 'globe';
      }
      return this.icon;
    },
    textColor() {
      if (this.variant === 'smooth') return '';
      if (this.variant === 'dashed') return '';
      return this.color || getContrastingTextColor(this.bgColor);
    },
    labelClass() {
      return `label ${this.colorScheme} ${this.variant} ${
        this.small ? 'small' : ''
      }`;
    },
    labelStyle() {
      if (this.bgColor) {
        return {
          background: this.bgColor,
          color: this.textColor,
          border: `1px solid ${this.bgColor}`,
        };
      }
      return {};
    },
    anchorStyle() {
      if (this.bgColor) {
        return { color: this.textColor };
      }
      return {};
    },
  },
  methods: {
    onClick() {
      this.$emit('remove', this.title);
    },
  },
};
</script>

<template>
  <div
    class="inline-flex ltr:mr-1 rtl:ml-1 mb-1"
    :class="labelClass"
    :style="labelStyle"
    :title="description || title"
  >
    <img
      v-if="portalDomain"
      :src="`https://www.google.com/s2/favicons?domain=${portalDomain}&sz=64`"
      class="size-3.5 rounded-sm object-contain"
    />
    <span v-else-if="computedIcon" class="label-action--button">
      <fluent-icon
        :icon="computedIcon"
        size="12"
        class="label--icon cursor-pointer"
      />
    </span>
    <span
      v-else-if="['smooth', 'dashed'].includes(variant) && title"
      :style="{ background: color }"
      class="label-color-dot flex-shrink-0"
    />
    <span v-if="!href" class="whitespace-nowrap text-ellipsis overflow-hidden">
      {{ title }}
    </span>
    <a v-else :href="href" :style="anchorStyle">{{ title }}</a>
    <button
      v-if="showClose"
      class="label-close--button p-0"
      :style="{ color: textColor }"
      @click="onClick"
    >
      <fluent-icon icon="dismiss" size="12" class="close--icon" />
    </button>
  </div>
</template>

<style scoped lang="scss">
.label {
  @apply items-center font-medium text-xs rounded-[4px] gap-1 p-1 bg-n-slate-3 text-n-slate-12 border border-solid border-n-strong h-6;

  &.small {
    @apply text-xs py-0.5 px-1 leading-tight h-5;
  }

  &.small .label--icon,
  &.small .close--icon {
    @apply text-[0.5rem];
  }

  a {
    @apply text-xs;
    &:hover {
      @apply underline;
    }
  }

  /* Color Schemes */
  &.primary {
    @apply bg-n-blue-5 text-n-blue-12 border border-solid border-n-blue-7;

    a {
      @apply text-n-blue-12;
    }
    .label-color-dot {
      @apply bg-n-blue-9;
    }
  }
  &.secondary {
    @apply bg-n-slate-5 text-n-slate-12 border border-solid border-n-slate-7;

    a {
      @apply text-n-slate-12;
    }
    .label-color-dot {
      @apply bg-n-slate-9;
    }
  }
  &.success {
    @apply bg-n-teal-5 text-n-teal-12 border border-solid border-n-teal-7;

    a {
      @apply text-n-teal-12;
    }
    .label-color-dot {
      @apply bg-n-teal-9;
    }
  }
  &.alert {
    @apply bg-n-ruby-5 text-n-ruby-12 border border-solid border-n-ruby-7;

    a {
      @apply text-n-ruby-12;
    }
    .label-color-dot {
      @apply bg-n-ruby-9;
    }
  }
  &.warning {
    @apply bg-n-amber-5 text-n-amber-12 border border-solid border-n-amber-7;

    a {
      @apply text-n-amber-12;
    }
    .label-color-dot {
      @apply bg-n-amber-9;
    }
  }

  &.smooth {
    @apply bg-transparent text-n-slate-11 dark:text-n-slate-12 border border-solid border-n-strong;
  }

  &.dashed {
    @apply bg-transparent text-n-slate-11 dark:text-n-slate-12 border border-dashed border-n-strong;
  }
}

.label-close--button {
  @apply text-n-slate-11 -mb-0.5 rounded-sm cursor-pointer flex items-center justify-center hover:bg-n-slate-3;

  svg {
    @apply text-n-slate-11;
  }
}

.label-action--button {
  @apply flex mr-1;
}

.label-color-dot {
  @apply inline-block w-3 h-3 rounded-sm shadow-sm;
}
.label.small .label-color-dot {
  @apply w-2 h-2 rounded-sm shadow-sm;
}
</style>

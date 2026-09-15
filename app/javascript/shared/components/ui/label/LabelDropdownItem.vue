<script>
import NextButton from 'dashboard/components-next/button/Button.vue';

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
  components: {
    NextButton,
  },
  props: {
    title: {
      type: String,
      default: '',
    },
    color: {
      type: String,
      default: '',
    },
    selected: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['selectLabel'],

  computed: {
    portalDomain() {
      return getPortalDomain(this.title);
    },
    isSite() {
      return this.title && this.title.toLowerCase().trim() === 'site';
    },
  },

  methods: {
    onClick() {
      this.$emit('selectLabel', this.title);
    },
  },
};
</script>

<template>
  <woot-dropdown-item>
    <NextButton
      slate
      ghost
      blue
      trailing-icon
      :icon="selected ? 'i-lucide-circle-check' : ''"
      class="w-full !px-2.5 justify-between"
      :class="{ '!flex-row': !selected }"
      @click="onClick"
    >
      <div class="flex items-center min-w-0 gap-2">
        <img
          v-if="portalDomain"
          :src="`https://www.google.com/s2/favicons?domain=${portalDomain}&sz=64`"
          class="size-3.5 rounded-sm object-contain flex-shrink-0"
        />
        <fluent-icon
          v-else-if="isSite"
          icon="globe"
          size="14"
          class="flex-shrink-0 text-n-slate-11"
        />
        <div
          v-else-if="color"
          class="size-3 flex-shrink-0 rounded-full outline outline-1 outline-n-weak"
          :style="{ backgroundColor: color }"
        />
        <span
          class="overflow-hidden text-ellipsis whitespace-nowrap leading-[1.1]"
          :title="title"
        >
          {{ title }}
        </span>
      </div>
    </NextButton>
  </woot-dropdown-item>
</template>

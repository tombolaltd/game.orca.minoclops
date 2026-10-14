<!-- GENERATED from packages/htp-preview/src/HtpPreviewPage.vue by scripts/sync-htp-renderer.cjs. Edit the package, then run `npm run htp:sync`. -->
<script setup lang="ts">
import { computed } from 'vue'
import {
  buildPreferredColourCssVars,
  columnsStyle as coreColumnsStyle,
  componentStyle as coreComponentStyle,
  formatPayout as coreFormatPayout,
  getSymbolText as coreGetSymbolText,
  groupSectionContents,
  imageCornerRadiusStyle as coreImageCornerRadiusStyle,
  imageStyle as coreImageStyle,
  isComponentClickable,
  parseListItems,
  primaryImage as corePrimaryImage,
  resolveAltText as coreResolveAltText,
  resolveComponentText as coreResolveComponentText,
  resolveCountColour,
  resolveImageSrc as coreResolveImageSrc,
  resolveImageTitle as coreResolveImageTitle,
  resolveSectionName as coreResolveSectionName,
  resolveSymbolIds,
  resolveText as coreResolveText,
  symbolCardStyle,
  symbolGridStyle,
  textAlignValue,
  textStyle,
  toImageList as coreToImageList,
} from './core'
import type {
  HtpPreviewColumns,
  HtpPreviewComponent,
  HtpPreviewSection,
  HtpTokenValues,
  HtpTranslations,
  HtpPreferredColours,
  HtpPreferredDimensions,
  HtpInjectedImages,
  HtpSymbolData,
  HtpCurrencyConverter,
  HtpEventsHandler,
} from './types'

const props = defineProps<{
  sections: HtpPreviewSection[]
  folderPath?: string
  tokens?: HtpTokenValues
  translations?: HtpTranslations
  preferredColours?: HtpPreferredColours
  preferredDimensions?: HtpPreferredDimensions
  injectedImages?: HtpInjectedImages
  gameName?: string
  symbolData?: HtpSymbolData
  currentStake?: number
  currencyConverter?: HtpCurrencyConverter
  events?: HtpEventsHandler
  showImageAltText?: boolean
  currentLanguageCode?: string
  /** Opens the game's full rules; without it the link at the foot of the page does nothing. */
  openGameRules?: () => void
}>()

const currentLanguageCode = computed(() => props.currentLanguageCode ?? 'en-gb')

function resolveText(text: string | undefined): string {
  return coreResolveText(text, {
    tokens: props.tokens,
    translations: props.translations,
  })
}

function resolveComponentText(component: HtpPreviewComponent): string {
  return coreResolveComponentText(component, {
    tokens: props.tokens,
    translations: props.translations,
  })
}

function resolveAltText(component: HtpPreviewComponent): string {
  return coreResolveAltText(component, {
    tokens: props.tokens,
    translations: props.translations,
    showImageAltText: props.showImageAltText,
  })
}

function resolveImageTitle(component: HtpPreviewComponent): string | undefined {
  return coreResolveImageTitle(component, {
    tokens: props.tokens,
    translations: props.translations,
    showImageAltText: props.showImageAltText,
  })
}

function resolveSectionName(section: HtpPreviewSection): string {
  return coreResolveSectionName(section, {
    tokens: props.tokens,
    translations: props.translations,
  })
}

function sectionCardStyle(section: HtpPreviewSection): Record<string, string> {
  const style: Record<string, string> = {}
  if (section.overrideColour && section.backgroundColor) {
    style.backgroundColor = section.backgroundColor
  }
  return style
}

const normalizedSections = computed(() => props.sections ?? [])

const sectionViews = computed(() => normalizedSections.value.map((section, index) => ({
  section,
  index,
  key: `${section.name}-${index}`,
  runs: groupSectionContents(section.contents),
})))

const preferredColourCssVars = computed(() => buildPreferredColourCssVars(props.preferredColours))

function resolveImageSrc(filename: string): string {
  return coreResolveImageSrc(filename, {
    folderPath: props.folderPath,
    injectedImages: props.injectedImages,
  })
}

function toImageList(component: HtpPreviewComponent, language?: string): string[] {
  return coreToImageList(component, language ?? 'en-gb')
}

function primaryImage(component: HtpPreviewComponent): string {
  return corePrimaryImage(component, props.currentLanguageCode ?? 'en-gb')
}

function getSymbolText(symbols: unknown, symbolId: number): string {
  return coreGetSymbolText(symbols, symbolId, props.translations)
}

function componentStyle(component: HtpPreviewComponent): Record<string, string> {
  return coreComponentStyle(component, props.preferredDimensions)
}

function formatPayout(multiplier: number): string {
  return coreFormatPayout(multiplier, props.currentStake ?? 0, props.currencyConverter)
}

function columnsStyle(content: HtpPreviewColumns): Record<string, string> {
  return coreColumnsStyle(content, props.preferredDimensions)
}

function imageStyle(component: HtpPreviewComponent, fillCell = false): Record<string, string> {
  return coreImageStyle(component, fillCell, props.preferredDimensions)
}

function imageCornerStyle(component: HtpPreviewComponent): Record<string, string> {
  return coreImageCornerRadiusStyle(component, props.preferredDimensions)
}

function emitComponentEvent(component: HtpPreviewComponent): void {
  const eventName = component.onClick?.trim()
  if (!eventName) {
    return
  }
  props.events?.(eventName)
}

const howToPlayText = computed(() => {
  const translation = props.translations?.['How To Play']
  return translation || 'How to play'
})

// Shown on every game's page and not part of the authored document, so it can't be edited.
const saferGamblingTips = [
  { title: 'Start Small', text: 'Begin with smaller bets to understand the game mechanics before increasing your stake.' },
  { title: 'Set Limits', text: 'Always play responsibly and set time and budget limits for your gaming session.' },
]

function onGameRulesClick(): void {
  props.openGameRules?.()
}

</script>

<template>
  <div class="htp-preview-page" :style="preferredColourCssVars">
    <div class="htp-page">
      <div class="preview-header">
        <button type="button" class="back-arrow" aria-label="Close">
          <svg viewBox="0 0 60 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <polyline points="50 8 10 50 50 92" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <div class="header-content">
          <h1 class="header-title">{{ howToPlayText }}</h1>
          <p v-if="gameName" class="header-subtitle">{{ gameName }}</p>
        </div>
      </div>

      <p v-if="normalizedSections.length === 0" class="empty-state">Add sections to see a preview.</p>

      <section
        v-for="view in sectionViews"
        :key="view.key"
        class="preview-section"
        :data-preview-section-index="view.index"
        :class="{
          'preview-section--no-outline': view.section.showOutlIne === false && view.section.showHeader === false,
          'preview-section--no-shadow': view.section.showOutlIne === false
        }"
      >
        <h4
          v-if="view.section.showHeader !== false"
          class="section-name"
        >{{ resolveSectionName(view.section) }}</h4>

        <template v-for="(run, runIndex) in view.runs">
          <div
            v-if="run.kind === 'card'"
            :key="`card-${view.index}-${runIndex}`"
            class="preview-run preview-components-card"
            :style="sectionCardStyle(view.section)"
          >
            <template v-for="item in run.items">
              <div
                v-if="item.columns"
                :key="`cols-${view.index}-${item.index}`"
                class="preview-columns"
                :data-preview-section-index="view.index"
                :data-preview-content-index="item.index"
                :style="[
                  { gridTemplateColumns: `repeat(${item.columns.columns.length || 1}, minmax(0, 1fr))` },
                  columnsStyle(item.columns),
                ]"
              >
                <div
                  v-for="(column, columnIndex) in item.columns.columns"
                  :key="`${view.index}-${item.index}-${columnIndex}`"
                  class="preview-column"
                >
                  <article
                    v-for="(component, componentIndex) in column"
                    :key="`${component.type}-${view.index}-${item.index}-${columnIndex}-${componentIndex}`"
                    class="preview-component"
                    :data-preview-section-index="view.index"
                    :data-preview-content-index="item.index"
                    :data-preview-column-index="columnIndex"
                    :data-preview-component-index="componentIndex"
                    :class="{ 'preview-component--clickable': isComponentClickable(component) }"
                    :style="componentStyle(component)"
                    @click="emitComponentEvent(component)"
                  >
                    <p
                      v-if="component.type === 'Text'"
                      class="component-text"
                      :style="textStyle(component)"
                      v-html="resolveComponentText(component)"
                    ></p>

                    <div
                      v-else-if="component.type === 'TextAndImage'"
                      class="component-text-and-image"
                      :style="`grid-template-columns: ${component.imagePercentage ?? 50}% ${100 - (component.imagePercentage ?? 50)}%;`"
                    >
                      <img
                        v-if="primaryImage(component)"
                        :src="resolveImageSrc(primaryImage(component))"
                        :alt="resolveAltText(component)"
                        :title="resolveImageTitle(component)"
                        class="component-image"
                        :style="[imageStyle(component, true), { order: component.imageFirst ? 0 : 1 }]"
                      />
                      <p
                        class="component-text"
                        :style="`text-align: ${textAlignValue(component)}; order: ${component.imageFirst ? 1 : 0};`"
                        v-html="resolveComponentText(component)"
                      ></p>
                    </div>

                    <div
                      v-else-if="component.type === 'Images'"
                      class="component-images"
                      :style="`grid-template-columns: repeat(${toImageList(component, currentLanguageCode).length || 1}, minmax(0, 1fr));`"
                    >
                      <img
                        v-for="(source, imageIndex) in toImageList(component, currentLanguageCode)"
                        :key="`${source}-${imageIndex}`"
                        :src="resolveImageSrc(source)"
                        :alt="resolveAltText(component)"
                        :title="resolveImageTitle(component)"
                        :style="imageCornerStyle(component)"
                        class="component-image component-image-fill"
                      />
                    </div>

                    <ul v-else-if="component.type === 'List'" class="component-list">
                      <li
                        v-for="(listItem, itemIndex) in parseListItems(resolveComponentText(component))"
                        :key="`item-${itemIndex}`"
                        v-html="resolveText(listItem)"
                      ></li>
                    </ul>

                    <div v-else-if="component.type === 'Symbols'" class="component-symbols" :style="symbolGridStyle(component)">
                      <div v-for="symbolId in resolveSymbolIds(component.symbols)" :key="symbolId" class="symbol-card" :style="symbolCardStyle(component)">
                        <img class="symbol-card-image" :src="resolveImageSrc('symbol' + symbolId)" :alt="'Symbol ' + symbolId" :title="'Symbol ' + symbolId" />
                        <div v-if="getSymbolText(component.symbols, symbolId)" class="symbol-card-text" v-html="getSymbolText(component.symbols, symbolId)"></div>
                        <div class="symbol-card-payouts">
                          <div
                            v-for="(payout, pi) in (props.symbolData?.find(s => s.symbolID === symbolId)?.payout ?? [])"
                            :key="pi"
                            class="symbol-payout-line"
                          >
                            <span :style="{ color: resolveCountColour(component) }">x{{ payout.matched }}</span>
                            <span class="symbol-payout-multiplier"> = {{ formatPayout(payout.multiplier) }}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <video
                      v-else-if="component.type === 'Video' && component.videoSrc"
                      class="component-video"
                      :src="resolveImageSrc(component.videoSrc)"
                      :autoplay="component.autoPlay || false"
                      :loop="component.loop || false"
                      muted
                      playsinline
                      controls
                    ></video>
                  </article>
                </div>
              </div>

              <article
                v-else-if="item.component"
                :key="`${item.component.type}-${view.index}-${item.index}`"
                class="preview-component"
                :data-preview-section-index="view.index"
                :data-preview-content-index="item.index"
                :class="{ 'preview-component--clickable': isComponentClickable(item.component) }"
                :style="componentStyle(item.component)"
                @click="emitComponentEvent(item.component)"
              >
                <p
                  v-if="item.component.type === 'Text'"
                  class="component-text"
                  :style="textStyle(item.component)"
                  v-html="resolveComponentText(item.component)"
                ></p>

                <div
                  v-else-if="item.component.type === 'TextAndImage'"
                  class="component-text-and-image"
                  :style="`grid-template-columns: ${item.component.imagePercentage ?? 50}% ${100 - (item.component.imagePercentage ?? 50)}%;`"
                >
                  <img
                    v-if="primaryImage(item.component)"
                    :src="resolveImageSrc(primaryImage(item.component))"
                    :alt="resolveAltText(item.component)"
                    :title="resolveImageTitle(item.component)"
                    class="component-image"
                    :style="[imageStyle(item.component, true), { order: item.component.imageFirst ? 0 : 1 }]"
                  />
                  <p
                    class="component-text"
                    :style="`text-align: ${textAlignValue(item.component)}; order: ${item.component.imageFirst ? 1 : 0};`"
                    v-html="resolveComponentText(item.component)"
                  ></p>
                </div>

                <div
                  v-else-if="item.component.type === 'Images'"
                  class="component-images"
                  :style="`grid-template-columns: repeat(${toImageList(item.component, currentLanguageCode).length || 1}, minmax(0, 1fr));`"
                >
                  <img
                    v-for="(source, imageIndex) in toImageList(item.component, currentLanguageCode)"
                    :key="`${source}-${imageIndex}`"
                    :src="resolveImageSrc(source)"
                    :alt="resolveAltText(item.component)"
                    :title="resolveImageTitle(item.component)"
                    :style="imageCornerStyle(item.component)"
                    class="component-image component-image-fill"
                  />
                </div>

                <ul v-else-if="item.component.type === 'List'" class="component-list">
                  <li
                    v-for="(listItem, itemIndex) in parseListItems(resolveComponentText(item.component))"
                    :key="`item-${itemIndex}`"
                    v-html="resolveText(listItem)"
                  ></li>
                </ul>

                <video
                  v-else-if="item.component.type === 'Video' && item.component.videoSrc"
                  class="component-video"
                  :src="resolveImageSrc(item.component.videoSrc)"
                  :autoplay="item.component.autoPlay || false"
                  :loop="item.component.loop || false"
                  muted
                  playsinline
                  controls
                ></video>
              </article>
            </template>
          </div>

          <article
            v-else
            :key="`symbols-${view.index}-${runIndex}`"
            class="preview-run preview-component preview-component--symbols"
            :data-preview-section-index="view.index"
            :data-preview-content-index="run.index"
            :class="{ 'preview-component--clickable': isComponentClickable(run.component) }"
            :style="componentStyle(run.component)"
            @click="emitComponentEvent(run.component)"
          >
            <div class="component-symbols" :style="symbolGridStyle(run.component)">
              <div
                v-for="symbolId in resolveSymbolIds(run.component.symbols)"
                :key="symbolId"
                class="symbol-card"
                :style="symbolCardStyle(run.component)"
              >
                <img class="symbol-card-image" :src="resolveImageSrc('symbol' + symbolId)" :alt="'Symbol ' + symbolId" :title="'Symbol ' + symbolId" />
                <div v-if="getSymbolText(run.component.symbols, symbolId)" class="symbol-card-text" v-html="getSymbolText(run.component.symbols, symbolId)"></div>
                <div class="symbol-card-payouts">
                  <div
                    v-for="(payout, pi) in (props.symbolData?.find(s => s.symbolID === symbolId)?.payout ?? [])"
                    :key="pi"
                    class="symbol-payout-line"
                  >
                    <span :style="{ color: resolveCountColour(run.component) }">x{{ payout.matched }}</span>
                    <span class="symbol-payout-multiplier"> = {{ formatPayout(payout.multiplier) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </article>
        </template>
      </section>

      <section class="htp-safer-gambling">
        <h4 class="safer-gambling-title">Safer Gambling</h4>
        <div class="safer-gambling-card">
          <div v-for="tip in saferGamblingTips" :key="tip.title" class="safer-gambling-tip">
            <p class="safer-gambling-tip-title">{{ tip.title }}</p>
            <p class="safer-gambling-tip-text">{{ tip.text }}</p>
          </div>
        </div>
        <div class="play-responsibly-card">
          <p class="play-responsibly-title">
            <svg class="play-responsibly-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
            </svg>
            <span>Play Responsibly</span>
          </p>
          <p class="play-responsibly-text">Gambling should be entertaining. Never bet more than you can afford to lose. If you feel you may have a gambling problem, please seek help.</p>
        </div>
        <button
          type="button"
          class="game-rules-link"
          :class="{ 'game-rules-link--active': !!openGameRules }"
          @click="onGameRulesClick"
        >For full game rules click here</button>
      </section>
    </div>
  </div>
</template>

<style scoped>
@font-face {
  font-family: 'Tombola Wallop Display';
  src: url('./assets/tombolawallop-display1.otf') format('opentype');
  font-weight: 400;
  font-style: normal;
}

.htp-preview-page {
  container-type: inline-size;
  min-height: 100%;
  background: #f0f0f0;
  color: #000000;
  user-select: none;
}

/* The game styles every element border-box; a host page that does not must still lay this out the same. */
.htp-preview-page,
.htp-preview-page :deep(*) {
  box-sizing: border-box;
}

.htp-preview-page,
.htp-preview-page :deep(*) {
  font-family: 'Tombola Wallop Display', sans-serif;
}

/* Sized from the page's own width, so a phone, a side panel and the desktop chat column keep the same proportions. */
.htp-page {
  font-size: 15px;
  font-size: clamp(12px, 4.2cqw, 20px);
  padding-bottom: 1.8em;
}

/* Stays at the top while the page scrolls underneath it. */
.preview-header {
  position: sticky;
  top: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: 2.6em minmax(0, 1fr) 2.6em;
  align-items: center;
  padding: 0.55em 0.3em 0.6em;
  background: #ffffff;
  box-shadow: 0 0.1em 0.45em rgba(0, 0, 0, 0.14);
}

.back-arrow {
  grid-column: 1;
  justify-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.4em;
  height: 2.6em;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: #000000;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.back-arrow svg {
  display: block;
  width: 0.8em;
  height: 1.35em;
}

.header-content {
  grid-column: 2;
  min-width: 0;
  text-align: center;
}

.header-title {
  margin: 0;
  font-size: 1.55em;
  font-weight: bold;
  line-height: 1.1;
  color: #000000;
}

.header-subtitle {
  margin: 0.1em 0 0;
  font-size: 1.15em;
  font-weight: bold;
  line-height: 1.15;
  color: #000000;
}

.empty-state {
  margin: 1.3em 0.8em 0;
  color: #6e7681;
}

.preview-section,
.htp-safer-gambling {
  margin: 1.9em 0.8em 0;
}

.preview-header + .preview-section {
  margin-top: 1.4em;
}

.section-name,
.safer-gambling-title {
  margin: 0 0 0.45em 0.3em;
  color: #000000;
  font-size: 1.6em;
  font-weight: bold;
  line-height: 1.15;
  text-align: left;
}

.preview-run + .preview-run {
  margin-top: 0.9em;
}

.preview-components-card {
  padding: 0.85em 1em;
  border-radius: 1.2em;
  background: #ffffff;
  box-shadow: 0 0.25em 0.6em rgba(0, 0, 0, 0.16);
  overflow: hidden;
}

.preview-section--no-shadow .preview-components-card {
  box-shadow: none;
}

/* No title and no outline: the content runs edge to edge, like a banner picture. */
.preview-section--no-outline {
  margin: 1.9em 0 0;
}

.preview-header + .preview-section--no-outline {
  margin-top: 0;
}

.preview-section--no-outline .preview-components-card {
  background: transparent;
  border-radius: 0;
  box-shadow: none;
  padding: 0;
}

.preview-section--no-outline .preview-component {
  padding: 0;
}

.preview-section--no-outline .preview-columns {
  padding: 0;
  gap: 0;
}

.preview-component {
  padding: 0.45em 0.3em;
}

.preview-component--symbols {
  padding: 0;
}

.preview-component--clickable {
  cursor: pointer;
}

.preview-columns {
  display: grid;
  gap: 0.75em;
  padding: 0.45em 0;
}

.preview-column {
  min-width: 0;
}

.component-text {
  margin: 0;
  line-height: 1.45;
  white-space: pre-wrap;
}

.component-text :deep(b),
.component-text :deep(strong) {
  font-weight: bold;
}

.component-text :deep(.rte-size-small) { font-size: 0.8em; }
.component-text :deep(.rte-size-medium) { font-size: 1em; }
.component-text :deep(.rte-size-large) { font-size: 1.4em; }

.component-text-and-image {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0.75em;
  align-items: center;
}

.component-image {
  display: block;
}

.component-video {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 0.6em;
}

.component-images {
  display: grid;
  gap: 0.6em;
  align-items: start;
}

.component-image-fill {
  width: 100%;
  height: auto;
  display: block;
}

.component-list {
  margin: 0;
  padding-left: 1.2em;
  display: grid;
  gap: 0.35em;
  line-height: 1.4;
}

.component-list li :deep(b),
.component-list li :deep(strong) {
  font-weight: bold;
}

.component-list li :deep(.rte-size-small) { font-size: 0.8em; }
.component-list li :deep(.rte-size-medium) { font-size: 1em; }
.component-list li :deep(.rte-size-large) { font-size: 1.4em; }

.component-symbols {
  display: grid;
  gap: 0.75em;
  width: 100%;
}

.symbol-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5em;
  min-width: 0;
  padding: 0.9em 0.45em 1em;
  border-radius: 1.1em;
  background: #706f7a;
  color: #ffffff;
  box-shadow: 0 0.2em 0.45em rgba(0, 0, 0, 0.3);
}

.symbol-card-image {
  width: min(3.6em, 100%);
  height: auto;
  aspect-ratio: 1 / 1;
  object-fit: contain;
}

.symbol-card-text {
  font-size: 0.9em;
  line-height: 1.3;
  text-align: center;
  color: inherit;
  overflow-wrap: break-word;
}

.symbol-card-text :deep(b),
.symbol-card-text :deep(strong) {
  font-weight: bold;
}

.symbol-card-text :deep(span) {
  color: inherit;
}

.symbol-card-payouts {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.05em;
}

.symbol-payout-line {
  font-size: 0.9em;
  line-height: 1.25;
  text-align: center;
  color: inherit;
}

.symbol-payout-multiplier {
  color: inherit;
}

.safer-gambling-card {
  display: flex;
  flex-direction: column;
  gap: 1.1em;
  padding: 1.3em 1.35em;
  border-radius: 1.2em;
  background: #565867;
}

.safer-gambling-tip-title,
.safer-gambling-tip-text,
.play-responsibly-title,
.play-responsibly-text {
  margin: 0;
}

.safer-gambling-tip-title {
  margin-bottom: 0.2em;
  color: #ffffff;
  font-size: 1.2em;
  font-weight: bold;
  line-height: 1.2;
}

.safer-gambling-tip-text {
  color: #c8c9d2;
  font-size: 0.95em;
  line-height: 1.4;
}

.play-responsibly-card {
  margin-top: 1.4em;
  padding: 1.35em 1.35em 1.45em;
  border-radius: 1.2em;
  background: #7c1414;
}

.play-responsibly-title {
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin-bottom: 0.55em;
  color: #ff6b6b;
  font-size: 1.2em;
  font-weight: bold;
  line-height: 1.2;
}

.play-responsibly-icon {
  flex-shrink: 0;
  width: 1.1em;
  height: 1.1em;
}

.play-responsibly-text {
  color: #ffffff;
  font-size: 0.95em;
  line-height: 1.6;
}

.game-rules-link {
  display: block;
  margin: 1.4em auto 0;
  padding: 0.3em 0.6em;
  border: 0;
  background: transparent;
  color: #000000;
  font-size: 1.05em;
  font-weight: bold;
  line-height: 1.3;
  text-decoration: underline;
  text-underline-offset: 0.15em;
  cursor: default;
  -webkit-tap-highlight-color: transparent;
}

.game-rules-link--active {
  cursor: pointer;
}
</style>

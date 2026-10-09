<template>
  <div class="orca-htp-host">
    <div class="orca-htp-layer" ref="layer">
      <div class="orca-htp" :class="layoutClass" :style="layoutStyle" v-if="isVisible">
        <div class="orca-htp__panel" @click="onPanelClick">
          <div class="orca-htp__scroll">
            <HtpPreviewPage
              :sections="sections"
              :folderPath="folderPath"
              :injectedImages="injectedImages"
              :tokens="tokens"
              :translations="translationTable"
              :currentLanguageCode="currentLanguageCode"
              :currentStake="currentStake"
              :symbolData="symbolData"
              :currencyConverter="currencyConverter"
              :events="onHtpEvent"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script src="./orca-htp-page.ts" lang="ts"></script>
<style src="./orca-htp-page.less" lang="less"></style>

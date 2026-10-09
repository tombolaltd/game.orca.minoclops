<template>
  <div ref="container" class="htpcontent" v-show="tabId === selectedTab">
    <div ref="content" class="content-wrapper" v-bind:style="contentStyle">
      <img :src="logoPath()" class="game-logo" />

      <div id="divider" :style="containerStyle">
        <div class="divider-flourish left"></div>
        <div class="divider-title">{{ localisedString('BaseSymbols') }}</div>
        <div class="divider-flourish right"></div>
      </div>

      <div id="symbolpayouts" :style="containerStyle">
        <div id="symbolrow" v-for="(row, rowIndex) in symbols" v-bind:key='rowIndex'>
          <div id="symbolroot" v-for="(symbol, symbolIndex) in row" v-bind:key='symbolIndex'
            :style="{ maxWidth: maxSymbolWidth() }">
            <img id="symbolicon" :src="assetPath(`htp/${symbol.image}`)" />
            <div id="symbolpayout" v-html="getSymbolText(symbol.symbolID)" />
          </div>
        </div>
      </div>

      <div id="divider" :style="containerStyle">
        <div class="divider-flourish left"></div>
        <div class="divider-title">{{ localisedString('WinLinesTitle') }}</div>
        <div class="divider-flourish right"></div>
      </div>
      <div class="content-section">
        <div>{{ localisedString('MainGameLines') }}</div>
        <img class="winlines" :src="assetPath('htp/WinlinesBaseGame.png')" />
        <div>{{ localisedString('BonusGameLines') }}</div>
        <img class="winlines" :src="assetPath('htp/WinlinesBonusGame.png')" />
      </div>

      <div class="footer"></div>
    </div>
  </div>
</template>

<script src="./pay-table-page.ts" lang="ts"></script>
<style src="../info-page-style.less" lang="less" scoped></style>
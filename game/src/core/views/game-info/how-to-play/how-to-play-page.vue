<template>
  <div ref="container" class="htpcontent" v-show="tabId === selectedTab">
    <div ref="content" class="content-wrapper" v-bind:style="contentStyle">
      <div id="divider" :style="containerStyle">
        <div class="divider-flourish left"></div>
        <div class="divider-title">{{ localisedString('BaseGame') }}</div>
        <div class="divider-flourish right"></div>
      </div>
      <div class="content-section">
        <img :src="assetPath('htp/basegame.png')" class="info-screenshot" />
        <ul>
          <li>{{ localisedString('BaseGameText1') }}</li>
        </ul>
      </div>

      <div id="divider" :style="containerStyle">
        <div class="divider-flourish left"></div>
        <div class="divider-title">{{ localisedString('BuyingIn') }}</div>
        <div class="divider-flourish right"></div>
      </div>
      <div class="content-section">
        <ul>
          <li>{{ localisedString('BuyingInText1') }}</li>
        </ul>
      </div>

      <div id="divider" :style="containerStyle">
        <div class="divider-flourish left"></div>
        <div class="divider-title">{{ localisedString('BonusSymbol') }}</div>
        <div class="divider-flourish right"></div>
      </div>
      <div class="content-section">
        <div class="symbol-highlight">
          <div class="symbol-highlight-body">
            <img :src="assetPath('htp/Bonus Symbol.png')" class="symbol-image" />
            <div class="prize-details">
              <div v-html="colourisedLocaleString('BonusSymbolText1A')"></div>
              <div v-html="colourisedLocaleString('BonusSymbolText1B')"></div>
              <div v-html="colourisedLocaleString('BonusSymbolText1C')"></div>
            </div>
          </div>
          <div class="symbol-highlight-footer">
            {{ localisedString('BonusSymbolText2') }}
          </div>
        </div>
        <img :src="assetPath('htp/bonusactivation.png')" class="info-screenshot" />
      </div>

      <div id="divider" :style="containerStyle">
        <div class="divider-flourish left"></div>
        <div class="divider-title">{{ localisedString('WildSymbol') }}</div>
        <div class="divider-flourish right"></div>
      </div>
      <div class="content-section">
        <div class="symbol-highlight">
          <div>{{ localisedString('WildSymbolText') }}</div>
        </div>
        <img :src="assetPath('htp/wildwin.png')" class="info-screenshot" />
      </div>

      <div id="divider" :style="containerStyle">
        <div class="divider-flourish left"></div>
        <div class="divider-title">{{ localisedString('ScatterSymbol') }}</div>
        <div class="divider-flourish right"></div>
      </div>
      <div class="content-section">
        <div class="symbol-highlight">
          <div class="symbol-highlight-body">
            <div class="prize-details">
              <div>{{ localisedString('ScatterSymbolText1') }}</div>
              <ul style="margin-top: 0;">
                <li>{{ localisedString('ScatterSymbolText1A') }}</li>
                <li>{{ localisedString('ScatterSymbolText1B') }}</li>
                <li>{{ localisedString('ScatterSymbolText1C') }}</li>
                <li>{{ localisedString('ScatterSymbolText1D') }}</li>
                <li>{{ localisedString('ScatterSymbolText1E') }}</li>
                <li>{{ localisedString('ScatterSymbolText1F') }}</li>
                <li>{{ localisedString('ScatterSymbolText1G') }}</li>
              </ul>
            </div>
            <img :src="assetPath('htp/Scatter Symbol.png')" class="symbol-image" />
          </div>
        </div>
        <img :src="assetPath('htp/scatterwin.png')" class="info-screenshot" />
      </div>

      <div id="divider" :style="containerStyle">
        <div class="divider-flourish left"></div>
        <div class="divider-title">{{ localisedString('BonusRound') }}</div>
        <div class="divider-flourish right"></div>
      </div>
      <div class="content-section">
        <ul>
          <li>{{ localisedString('BonusRoundText1') }}</li>
        </ul>
        <img :src="assetPath('htp/bonusround.png')" class="info-screenshot" />
        <ul>
          <li>{{ localisedString('BonusRoundText2') }}</li>
        </ul>
      </div>

      <div class="footer"></div>
    </div>
  </div>
</template>

<script src="./how-to-play-page.ts" lang="ts"></script>
<style src="../info-page-style.less" lang="less" scoped></style>

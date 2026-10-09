<template>
  <div class="howtoplay" v-if="isVisible" :style="rootStyle">
    <div class="blur-backdrop"></div>
    <div class="background">
      <PayTablePage
        class="htppage"
        :scrollable = true
        :selectedTab = "selectedTab"
        :tabId = 1
        :showControls="showControls"
      ></PayTablePage>
      <HowToPlayPage
        class="htppage"
        :scrollable = true
        :selectedTab = "selectedTab"
        :tabId = 2
        :showControls="showControls"
      ></HowToPlayPage>

      <div>
      <div id="controls">
        <div class="left-controls">
          <div class="controlButton" @click="select(1)" :style="controlColour(1)">
            {{ localisedString('payTable') }}
          </div>
          <div class="controlButton" @click="select(2)" :style="controlColour(2)">
            {{ localisedString('howToPlay') }}
          </div>
        </div>
        <div class="right-controls">
          <div class="controlButton close" @click="hide()">
            {{ localisedString('closePanel') }}
          </div>
        </div>
      </div>
      </div>
      
    </div>
  </div>
</template>

<script src="./game-info.ts" lang="ts"></script>
<style  src="./game-info.less" lang="less"></style>
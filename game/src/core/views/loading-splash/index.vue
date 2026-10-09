<template>
    <div class="orca-loading-splash" v-if="visible" :style="rootStyle">
        <div class="orca-loading-splash__logo" v-if="config.logo" :style="logoBoxStyle">
            <img :src="config.logo" alt="" draggable="false" :style="logoImageStyle" />
        </div>
        <div class="orca-loading-splash__bar" :style="barStyle">
            <div class="orca-loading-splash__track" :style="trackStyle">
                <div class="orca-loading-splash__fill" :style="fillStyle">
                    <img
                        class="orca-loading-splash__icon"
                        v-if="config.progressIcon"
                        :src="config.progressIcon"
                        alt=""
                        draggable="false"
                        :style="iconStyle"
                    />
                </div>
            </div>
        </div>
    </div>
</template>

<script src="./script.ts" lang="ts"></script>

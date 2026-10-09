declare module 'penpal';

declare module '*.vue' {
    import Vue from 'vue';
    export default Vue;
}

declare module '*.png' {
    const svg: string;
    export default svg;
}

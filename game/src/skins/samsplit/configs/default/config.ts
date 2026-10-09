import { ISkinConfigEx } from '@/src/types';

const skinFonts: string[] = []; // TODO: add skin specific fonts here (if any)

export const skinConfig: ISkinConfigEx = {
    chatBgColour: '#00BCAD', // TODO: Agree this colour with Product
    fonts: skinFonts,
    howToPlay: {
        slide: {
            defaultTextStyle: {
                fontFamily: 'Lato-Bold',
                fill: 0xffffff,
                wordWrap: true
            },
            bulletTextStyle: {
                fontFamily: 'Lato-Bold',
                fill: 0x8a1a1d,
                wordWrap: true
            },
            titleTextStyle: {
                fontFamily: 'Lato-Bold',
                fill: 0x967c35,
                wordWrap: true
            }
        }
    }
};

import { AssetData, IHowToPlayStrings, INewHowToPlaySlideStrings, ISkinConfig, ISkinDesc, IStrings, Locale } from '@game-studio/arcade-base';
import { TextStyleOptions } from 'pixi.js';

// A bundle now carries every skin; the booting skin comes from `?skin=<gameId>`.
export type SkinName = string;
export type SupportedLocale = Exclude<Locale, 'pt-pt' | 'nl-nl'>;

export interface ISkinDescEx extends ISkinDesc {
    dataList: AssetData;
    config: ISkinConfigEx;
}

export interface ISkinConfigEx extends ISkinConfig {
    howToPlay: {
        slide: {
            defaultTextStyle: Partial<TextStyleOptions>;
            bulletTextStyle: Partial<TextStyleOptions>;
            titleTextStyle: Partial<TextStyleOptions>;
        };
    };
}

export interface IGameStrings extends IStrings {
    howToPlay: IHTPStrings;
}

// enforces the slides value to the new style
export interface IHTPStrings extends IHowToPlayStrings {
    slides: INewHowToPlaySlideStrings[];
}

export interface ISymbolPayoutData {
    symbolID: number;
    payout: Array<{
        matched: number;
        multiplier: number;
    }>;
}

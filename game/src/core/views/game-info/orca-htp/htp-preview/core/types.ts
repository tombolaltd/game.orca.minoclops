// GENERATED from packages/htp-preview-core/src/types.ts by scripts/sync-htp-renderer.cjs. Edit the package, then run `npm run htp:sync`.
export type HtpComponentType = 'Text' | 'TextAndImage' | 'Images' | 'List' | 'Symbols' | 'Video'

export interface HtpComponentBase {
  maxWidth?: string
}

export interface HtpContentRoot {
  hasBackground?: boolean
  backgroundColor?: string
  padding?: string
  border?: string
  borderRadius?: string
  lineHeight?: number
}

export interface HtpPreviewRenderableSymbol {
  id?: number
  symbolID?: number
  text?: string
  usePoEditor?: boolean
  poEditorTerm?: string
}

export interface HtpPreviewComponent extends HtpContentRoot {
  type: HtpComponentType
  images?: Record<string, string[]> | string[]
  useLanguageSpecificImages?: boolean
  videoSrc?: string
  autoPlay?: boolean
  loop?: boolean
  text?: string
  usePoEditor?: boolean
  usePoEditorString?: boolean
  poEditorTerm?: string
  hasAltText?: boolean
  altText?: string
  altTextUsePoEditor?: boolean
  altTextPoEditorTerm?: string
  base?: HtpComponentBase
  symbols?: Array<number | HtpPreviewRenderableSymbol>
  countColour?: string
  onClick?: string
  alignText?: string
  imageFirst?: boolean
  imagePercentage?: number
}

export interface HtpPreviewColumns extends HtpContentRoot {
  columns: HtpPreviewComponent[][]
}

export type HtpPreviewContent = HtpPreviewComponent | HtpPreviewColumns

/** One entry of a section's `contents`, keeping its index there. */
export interface HtpContentRunItem {
  index: number
  component?: HtpPreviewComponent
  columns?: HtpPreviewColumns
}

/** Consecutive contents sharing one white card. */
export interface HtpCardRun {
  kind: 'card'
  items: HtpContentRunItem[]
}

/** A Symbols component, whose symbol cards stand on the page. */
export interface HtpSymbolsRun {
  kind: 'symbols'
  index: number
  component: HtpPreviewComponent
}

export type HtpContentRun = HtpCardRun | HtpSymbolsRun

export interface HtpPreviewSection {
  name: string
  usePoEditor?: boolean
  usePoEditorString?: boolean
  poEditorTerm?: string
  overrideColour?: boolean
  backgroundColor?: string
  showOutlIne?: boolean
  showHeader?: boolean
  contents: HtpPreviewContent[]
}

export interface HtpTokenValues {
  RTP?: string
  TotalRTP?: string
  JRTP?: string
  STAKES?: string
  MAX_PAYOUT?: string
  defaultStake?: string
  displayName?: string
}

export type HtpTranslations = Record<string, string>
export type HtpPreferredColours = Record<string, string>
export type HtpPreferredDimensions = Record<string, number>
export type HtpInjectedImages = Record<string, string>

export interface HtpPayoutData {
  matched: number
  multiplier: number
}

export interface HtpSymbolPayoutData {
  symbolID: number
  payout: HtpPayoutData[]
}

export type HtpSymbolData = HtpSymbolPayoutData[]
export type HtpCurrencyConverter = (value: number) => string
export type HtpEventsHandler = (event: string) => void

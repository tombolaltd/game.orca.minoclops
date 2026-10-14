// GENERATED from packages/htp-preview-core/src/helpers.ts by scripts/sync-htp-renderer.cjs. Edit the package, then run `npm run htp:sync`.
import type {
  HtpContentRun,
  HtpInjectedImages,
  HtpPreferredColours,
  HtpPreferredDimensions,
  HtpPreviewColumns,
  HtpPreviewComponent,
  HtpPreviewContent,
  HtpPreviewSection,
  HtpTokenValues,
  HtpTranslations,
} from './types'

export const TOKEN_MAP: Record<string, keyof HtpTokenValues> = {
  RTP: 'RTP',
  TOTALRTP: 'TotalRTP',
  JRTP: 'JRTP',
  STAKES: 'STAKES',
  MAX_PAYOUT: 'MAX_PAYOUT',
  DEFAULTSTAKE: 'defaultStake',
  DISPLAYNAME: 'displayName',
}

export interface HtpTextResolverOptions {
  tokens?: HtpTokenValues
  translations?: HtpTranslations
}

export function resolveText(text: string | undefined, options: HtpTextResolverOptions = {}): string {
  if (!text) return ''

  const resolved = text.replace(/\{\{([^}]+)\}\}/g, (match, rawKey) => {
    const key = rawKey.trim()
    const tokenKey = TOKEN_MAP[key.toUpperCase()]
    if (tokenKey && options.tokens?.[tokenKey] != null) {
      return options.tokens[tokenKey]!
    }
    if (options.translations?.[key] != null) {
      return options.translations[key]
    }
    return match
  })

  if (options.translations?.[resolved] != null) {
    return options.translations[resolved]
  }

  return resolved
}

export function resolveComponentText(component: HtpPreviewComponent, options: HtpTextResolverOptions = {}): string {
  const usesPoEditor = component.usePoEditor === true || component.usePoEditorString === true
  const sourceText = usesPoEditor && component.poEditorTerm ? `{{${component.poEditorTerm}}}` : component.text
  return resolveText(sourceText, options)
}

export interface HtpAltTextResolverOptions extends HtpTextResolverOptions {
  showImageAltText?: boolean
}

export function resolveAltText(component: HtpPreviewComponent, options: HtpAltTextResolverOptions = {}): string {
  if (options.showImageAltText === false) return ''
  if (!component.hasAltText) return ''
  const sourceText = component.altTextUsePoEditor && component.altTextPoEditorTerm ? `{{${component.altTextPoEditorTerm}}}` : component.altText
  return resolveText(sourceText, options)
}

export function resolveImageTitle(component: HtpPreviewComponent, options: HtpAltTextResolverOptions = {}): string | undefined {
  const altText = resolveAltText(component, options)
  return altText || undefined
}

export function resolveSectionName(section: HtpPreviewSection, options: HtpTextResolverOptions = {}): string {
  const usesPoEditor = section.usePoEditor === true || section.usePoEditorString === true
  const sourceText = usesPoEditor && section.poEditorTerm ? `{{${section.poEditorTerm}}}` : section.name
  return resolveText(sourceText, options) || 'Untitled section'
}

export function preferredColourCssVariableName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `--htp-preferred-colour-${normalized || 'colour'}`
}

export function buildPreferredColourCssVars(preferredColours?: HtpPreferredColours): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const [name, color] of Object.entries(preferredColours ?? {})) {
    vars[preferredColourCssVariableName(name)] = color
  }
  return vars
}

export function isColumnsContent(content: HtpPreviewContent): content is HtpPreviewColumns {
  return Array.isArray((content as HtpPreviewColumns).columns)
}

/** A section's contents as the page draws them: runs of white-card content, each Symbols component on its own. */
export function groupSectionContents(contents: HtpPreviewContent[] | undefined): HtpContentRun[] {
  const runs: HtpContentRun[] = []
  ;(contents ?? []).forEach((content, index) => {
    if (isColumnsContent(content)) {
      const last = runs[runs.length - 1]
      if (last && last.kind === 'card') last.items.push({ index, columns: content })
      else runs.push({ kind: 'card', items: [{ index, columns: content }] })
      return
    }
    if (content.type === 'Symbols') {
      runs.push({ kind: 'symbols', index, component: content })
      return
    }
    const last = runs[runs.length - 1]
    if (last && last.kind === 'card') last.items.push({ index, component: content })
    else runs.push({ kind: 'card', items: [{ index, component: content }] })
  })
  return runs
}

export interface HtpImageResolverOptions {
  folderPath?: string
  injectedImages?: HtpInjectedImages
}

export function resolveImageSrc(filename: string, options: HtpImageResolverOptions = {}): string {
  if (!filename) {
    return ''
  }

  const injectedImage = options.injectedImages?.[filename]
  if (injectedImage) {
    if (injectedImage.startsWith('data:image/')) {
      return injectedImage
    }
    return `data:image/png;base64,${injectedImage}`
  }

  if (filename.startsWith('http://') || filename.startsWith('https://') || filename.startsWith('file://') || filename.startsWith('game-asset://')) {
    return filename
  }

  if (options.folderPath) {
    if (options.folderPath.startsWith('http://') || options.folderPath.startsWith('https://')) {
      const baseUrl = options.folderPath.endsWith('/') ? options.folderPath : `${options.folderPath}/`
      return new URL(filename, baseUrl).toString()
    }
    const separator = options.folderPath.endsWith('/') ? '' : '/'
    const rawPath = `${options.folderPath}${separator}${filename}`
    const encoded = rawPath.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    return `game-asset://${encoded}`
  }

  return filename
}

export function toImageList(component: HtpPreviewComponent, language = 'en-gb'): string[] {
  if (!component.images) {
    return []
  }

  if (Array.isArray(component.images)) {
    return component.images.filter(Boolean)
  }

  if (typeof component.images === 'object') {
    const imageRecord = component.images as Record<string, string[]>
    const languageImages = imageRecord[language]
    if (languageImages && Array.isArray(languageImages) && languageImages.length > 0) {
      return languageImages.filter(Boolean)
    }
  }
  return []
}

export function primaryImage(component: HtpPreviewComponent, language = 'en-gb'): string {
  return toImageList(component, language)[0] ?? ''
}

export function parseListItems(text?: string): string[] {
  if (!text) return []

  const html = text
    .replace(/<div>/gi, '\n')
    .replace(/<\/div>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')

  return html
    .split(/\n/)
    .map((part) => part.trim())
    .filter((part) => part.replace(/<[^>]*>/g, '').trim().length > 0)
}

export function resolveSymbolIds(symbols: unknown): number[] {
  if (!Array.isArray(symbols)) {
    return []
  }

  const ids = symbols
    .map((symbol) => {
      if (symbol && typeof symbol === 'object' && 'id' in symbol) {
        const id = (symbol as { id?: unknown }).id
        if (typeof id === 'number' && Number.isFinite(id)) {
          return id
        }
      }
      if (typeof symbol === 'number' && Number.isFinite(symbol)) {
        return symbol
      }
      if (symbol && typeof symbol === 'object' && 'symbolID' in symbol) {
        const legacyId = (symbol as { symbolID?: unknown }).symbolID
        if (typeof legacyId === 'number' && Number.isFinite(legacyId)) {
          return legacyId
        }
      }
      return null
    })
    .filter((id): id is number => id != null)

  return Array.from(new Set(ids))
}

/** Up to three symbol cards a row; four make two rows of two. */
export function symbolGridStyle(component: HtpPreviewComponent): Record<string, string> {
  const count = resolveSymbolIds(component.symbols).length
  const columns = count === 4 ? 2 : Math.max(1, Math.min(3, count))
  return { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
}

export function getSymbolText(symbols: unknown, symbolId: number, translations?: HtpTranslations): string {
  if (!Array.isArray(symbols)) {
    return ''
  }

  for (const symbol of symbols) {
    if (symbol && typeof symbol === 'object' && 'id' in symbol) {
      const sym = symbol as { id?: unknown; text?: unknown; usePoEditor?: unknown; poEditorTerm?: unknown }
      if (sym.id === symbolId) {
        if (sym.usePoEditor && typeof sym.poEditorTerm === 'string' && sym.poEditorTerm) {
          const poTerm = sym.poEditorTerm
          if (translations && poTerm in translations) {
            return translations[poTerm]
          }
          return poTerm
        }
        if (typeof sym.text === 'string') {
          return sym.text
        }
      }
    }
  }

  return ''
}

/**
 * A length in viewport-width units. A host that previews the page outside the
 * game sets `--htp-vw` to 1% of the game screen it imitates; the game leaves it
 * unset, so there it is plain `vw`.
 */
export function viewportWidthLength(units: number): string {
  return `calc(${units} * var(--htp-vw, 1vw))`
}

export function maxWidthStyle(component: HtpPreviewComponent): string {
  const raw = component.base?.maxWidth
  if (!raw) {
    return '100%'
  }

  if (raw.endsWith('%')) {
    return raw
  }

  // Orca's HTP window once saved the 0–1 "Max width" slider as `<ratio>px`.
  const legacyRatio = /^(\d*\.?\d+)px$/.exec(raw)
  if (legacyRatio && Number(legacyRatio[1]) <= 1) {
    return `${Math.round(Number(legacyRatio[1]) * 10000) / 100}%`
  }

  const ratio = Number(raw)
  if (Number.isFinite(ratio)) {
    const clamped = Math.min(1, Math.max(0, ratio))
    return `${clamped * 100}%`
  }

  return raw
}

export function shouldCenterByMaxWidth(component: HtpPreviewComponent): boolean {
  const maxWidth = maxWidthStyle(component)
  if (maxWidth === '100%') {
    return false
  }

  if (maxWidth.endsWith('%')) {
    const percent = Number(maxWidth.slice(0, -1))
    return Number.isFinite(percent) && percent < 100
  }

  return true
}

export function resolveDimensionValue(dimensionKey?: string, preferredDimensions?: HtpPreferredDimensions): number | null {
  if (!dimensionKey) {
    return null
  }

  const mapped = preferredDimensions?.[dimensionKey]
  if (typeof mapped === 'number' && Number.isFinite(mapped)) {
    return mapped
  }

  const parsed = Number(dimensionKey)
  if (Number.isFinite(parsed)) {
    return parsed
  }

  return null
}

export function componentStyle(component: HtpPreviewComponent, preferredDimensions?: HtpPreferredDimensions): Record<string, string> {
  const style: Record<string, string> = {
    color: '#000000',
    maxWidth: maxWidthStyle(component),
  }

  if (shouldCenterByMaxWidth(component)) {
    style.marginLeft = 'auto'
    style.marginRight = 'auto'
  }

  if (component.hasBackground && component.backgroundColor && component.type !== 'Symbols') {
    style.backgroundColor = component.backgroundColor
    style.borderRadius = '8px'
  }
  const resolvedPadding = resolveDimensionValue(component.padding, preferredDimensions)
  if (resolvedPadding != null) {
    style.padding = viewportWidthLength(resolvedPadding)
  }
  const resolvedBorder = resolveDimensionValue(component.border, preferredDimensions)
  if (resolvedBorder != null) {
    style.margin = `0 ${viewportWidthLength(resolvedBorder)}`
  }
  if (typeof component.lineHeight === 'number' && Number.isFinite(component.lineHeight)) {
    style.lineHeight = String(component.lineHeight)
  }
  return style
}

function parseColour(colour: string): [number, number, number, number] | null {
  const value = colour.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)
  if (hex) {
    const digits = hex[1].length <= 4 ? hex[1].split('').map((d) => d + d).join('') : hex[1]
    const channel = (i: number) => parseInt(digits.slice(i * 2, i * 2 + 2), 16)
    return [channel(0), channel(1), channel(2), digits.length === 8 ? channel(3) / 255 : 1]
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(value)
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]) / (rgb[5] ? 100 : 1)
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Math.min(1, Math.max(0, alpha))]
  }
  return null
}

/** WCAG relative luminance of `colour` seen over the white page; null when it can't be parsed. */
function relativeLuminance(colour: string): number | null {
  const parsed = parseColour(colour)
  if (!parsed) {
    return null
  }
  const [r, g, b, alpha] = parsed
  const linear = (channel: number) => {
    const c = (alpha * channel + (1 - alpha) * 255) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  if (la === null || lb === null) {
    return null
  }
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Black or white, whichever reads better on `background` (seen over the white page); null when it can't be parsed. */
export function readableTextColour(background: string): string | null {
  const luminance = relativeLuminance(background)
  if (luminance === null) {
    return null
  }
  const onWhite = 1.05 / (luminance + 0.05)
  const onBlack = (luminance + 0.05) / 0.05
  return onBlack >= onWhite ? '#000000' : '#ffffff'
}

export const HTP_SYMBOL_CARD_BACKGROUND = '#706f7a'
export const HTP_SYMBOL_COUNT_COLOUR = '#f7a623'

export function symbolCardStyle(component: HtpPreviewContent): Record<string, string> {
  if (component.hasBackground && component.backgroundColor) {
    return {
      backgroundColor: component.backgroundColor,
      color: readableTextColour(component.backgroundColor) ?? '#ffffff',
    }
  }
  return {}
}

/** The authored count colour, unless it all but vanishes on the card (a colour chosen for the old white cards). */
export function resolveCountColour(content: HtpPreviewContent): string {
  const authored = (content as HtpPreviewComponent).countColour
  if (!authored) {
    return HTP_SYMBOL_COUNT_COLOUR
  }
  const card = content.hasBackground && content.backgroundColor ? content.backgroundColor : HTP_SYMBOL_CARD_BACKGROUND
  const ratio = contrastRatio(authored, card)
  return ratio === null || ratio >= 2 ? authored : HTP_SYMBOL_COUNT_COLOUR
}

export function formatPayout(multiplier: number, currentStake = 0, currencyConverter?: (value: number) => string): string {
  const value = multiplier * currentStake
  if (currencyConverter) {
    return currencyConverter(value)
  }
  return String(value)
}

export function columnsStyle(content: HtpPreviewColumns, preferredDimensions?: HtpPreferredDimensions): Record<string, string> {
  const style: Record<string, string> = {}
  if (content.hasBackground && content.backgroundColor) {
    style.backgroundColor = content.backgroundColor
    style.borderRadius = '8px'
    style.padding = viewportWidthLength(0.5)
  }
  const resolvedPadding = resolveDimensionValue(content.padding, preferredDimensions)
  if (resolvedPadding != null) {
    style.padding = viewportWidthLength(resolvedPadding)
  }
  const resolvedBorder = resolveDimensionValue(content.border, preferredDimensions)
  if (resolvedBorder != null) {
    style.margin = `0 ${viewportWidthLength(resolvedBorder)}`
  }
  return style
}

export function imageCornerRadiusStyle(component: HtpPreviewComponent, preferredDimensions?: HtpPreferredDimensions): Record<string, string> {
  const resolved = resolveDimensionValue(component.borderRadius, preferredDimensions)
  if (resolved == null) {
    return {}
  }
  return { borderRadius: viewportWidthLength(resolved) }
}

export function imageStyle(component: HtpPreviewComponent, fillCell = false, preferredDimensions?: HtpPreferredDimensions): Record<string, string> {
  const width = fillCell ? '100%' : (component.imagePercentage ? `${component.imagePercentage}%` : '100%')
  return {
    width,
    height: 'auto',
    display: 'block',
    ...imageCornerRadiusStyle(component, preferredDimensions),
  }
}

export function textAlignValue(component: HtpPreviewComponent): string {
  if (component.alignText === 'centre') {
    return 'center'
  }

  if (component.alignText === 'center' || component.alignText === 'right' || component.alignText === 'left') {
    return component.alignText
  }

  return 'left'
}

export function textStyle(component: HtpPreviewComponent): string {
  return `text-align: ${textAlignValue(component)};`
}

export function textAndImageStyle(component: HtpPreviewComponent): string {
  return `text-align: ${textAlignValue(component)};`
}

export function isComponentClickable(component: HtpPreviewComponent): boolean {
  return typeof component.onClick === 'string' && component.onClick.trim().length > 0
}

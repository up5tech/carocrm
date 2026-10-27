import type { ThemeConfig } from 'antd';

import {
  ACCENT_NAMES,
  ACCENT_TONES,
  type AccentName,
  accentToneSet,
  COLOR,
  DARK_COLOR,
  FONT_FAMILY,
  palette,
} from './theme/tokens.js';

export {
  ACCENT_NAMES,
  ACCENT_TONES,
  accentTone,
  accentToneSet,
  COLOR,
  DARK_COLOR,
  FONT_FAMILY,
} from './theme/tokens.js';

/**
 * CaroCRM design tokens (PLAN_Phase_20_Settings_UX.md §20.20). Every value below is read from
 * `tokens.ts` — there is no literal colour in this file, so an Ant Design token and the matching CSS
 * custom property (`styles/tokens.css`) can never drift apart.
 *
 * The theme is built for one mode at a time. Ant Design does not recompute a token the caller sets
 * explicitly when the algorithm changes, so a fixed light value here survives into dark mode and
 * paints a white panel in a dark shell — the defect §20.21 exists to remove. Every colour slot below
 * is therefore taken from the palette of the mode being rendered.
 */
export function carocrmTheme(dark: boolean): ThemeConfig {
  const p = palette(dark);
  const accent = accentToneSet(null, dark);
  return {
    token: {
      // §20.26 axe gate: white text on the plain `accent` blue is 3.2:1, below WCAG AA's 4.5:1 for
      // normal button text. Ant Design derives every filled surface (primary buttons, switches) from
      // `colorPrimary`, so the *strong* tone (4.97:1 under white) is the shipped default.
      colorPrimary: accent.primary,
      colorInfo: p.stateInfo,
      // Same reasoning for links on white: the plain accent is 2.86:1, the strong tone 4.97:1.
      colorLink: accent.strong,
      colorSuccess: p.stateSuccess,
      colorWarning: p.stateWarning,
      colorError: p.stateError,
      // `colorTextBase` is what `colorText`, `colorTextHeading` and the text tints are derived from,
      // so this one token decides whether the whole interface reads as light-on-dark or dark-on-light.
      colorTextBase: p.inkPrimary,
      colorTextSecondary: p.inkSecondary,
      // Typography.Text type="secondary" paints from colorTextDescription (not the secondary ink),
      // whose antd default over white is 2.47:1 — the settings save bar was flagged for exactly that.
      colorTextDescription: p.inkSecondary,
      fontFamily: FONT_FAMILY,
      fontSize: 14,
      controlHeight: 36,
      controlHeightSM: 24,
      controlHeightLG: 40,
      borderRadius: 8,
      borderRadiusSM: 4,
      wireframe: false,
      boxShadow: 'none',
      boxShadowSecondary: 'none',
    },
    components: {
      Layout: {
        bodyBg: p.surfacePage,
        headerBg: p.surfaceRaised,
        headerHeight: 70,
        headerPadding: '0 24px',
        siderBg: p.surfaceRaised,
        footerBg: p.surfaceRaised,
        footerPadding: '24px',
      },
      Menu: {
        itemHeight: 40,
        itemMarginInline: 8,
        itemBorderRadius: 8,
        itemBg: 'transparent',
        itemSelectedBg: p.menuSelectedBg,
        // The selection text uses the accent's *strong* tone: the plain `accent` blue on the soft
        // selection background is 2.99:1, which the §20.26 axe gate correctly rejects (§20.16 AA).
        itemSelectedColor: accent.strong,
        itemColor: p.inkMenu,
        subMenuItemBg: 'transparent',
        iconMarginInlineEnd: 10,
      },
      Card: {
        borderRadiusLG: 8,
        paddingLG: 22,
        headerBg: 'transparent',
        headerHeight: 55,
        headerFontSize: 15,
        colorBorderSecondary: p.lineStrong,
      },
      Pagination: {
        itemSize: 32,
        borderRadius: 6,
      },
      Table: {
        headerBg: p.tableHeaderBg,
        headerColor: p.inkPrimary,
        headerSplitColor: 'transparent',
        borderColor: p.lineStrong,
        cellPaddingBlock: 12,
        cellPaddingInline: 16,
        rowHoverBg: p.tableRowHover,
      },
      Button: {
        borderRadius: 6,
        controlHeight: 36,
        fontWeight: 500,
      },
      Input: { borderRadius: 6, controlHeight: 36 },
      InputNumber: { borderRadius: 6, controlHeight: 36 },
      // Select and DatePicker must match Input's height or Space.Compact rows sit crooked
      Select: { borderRadius: 6, controlHeight: 36 },
      DatePicker: { borderRadius: 6, controlHeight: 36 },
      Tag: { borderRadiusSM: 4 },
      Statistic: { contentFontSize: 24 },
      Descriptions: { itemPaddingBottom: 12 },
    },
  };
}

/**
 * Build a theme for a brand accent name (General settings → `primaryColor`) in the mode being
 * rendered. Defaults to blue when the name is unknown or absent. This recolours Ant Design's
 * primary/info/link tokens and the menu's selected row; the shell's own accent usages follow because
 * `BrandTheme` also sets the `--carocrm-accent*` CSS variables from the same tone set.
 */
export function themeForBrand(primaryColor: string | undefined | null, dark = false): ThemeConfig {
  const base = carocrmTheme(dark);
  const tone = accentToneSet(primaryColor, dark);
  return {
    ...base,
    token: {
      ...base.token,
      // A filled button paints its label in white, so the filled-surface tone is the accent's deep
      // one, not the bright `strong` tone that reads as link text on a dark surface.
      colorPrimary: tone.primary,
      colorInfo: tone.strong,
      colorLink: tone.strong,
    },
    components: {
      ...base.components,
      Menu: {
        ...base.components?.Menu,
        itemSelectedBg: tone.soft,
        itemSelectedColor: tone.strong,
      },
    },
  };
}

/**
 * Menu accent tokens (PLAN_Phase_20_Settings_UX.md §4.4). An accent is one of eight named tokens,
 * never a free colour: the server validates the name against the same list, so a settings document
 * can only choose a treatment the design system already owns. Colour marks a group, it is never the
 * only signal — the label and icon carry the meaning too (§5.8).
 */
export const NAV_ACCENTS: Record<string, { fg: string; soft: string }> = Object.fromEntries(
  ACCENT_NAMES.map((name) => [name, { fg: ACCENT_TONES[name as AccentName].fg, soft: ACCENT_TONES[name as AccentName].soft }]),
);

export const NAV_ACCENT_NAMES: readonly string[] = ACCENT_NAMES;

/**
 * The accent pair for a name, or the neutral pair when the entry carries none. The dark half of the
 * tone set is used in dark mode: the light `fg` of a deep accent (purple) does not clear AA on the
 * dark page.
 */
export function navAccent(name: string | undefined, dark = false): { fg: string; soft: string } {
  if (name === undefined) return dark ? { fg: DARK_COLOR.inkFaint, soft: DARK_COLOR.surfaceRaised } : { fg: COLOR.inkFaint, soft: COLOR.surfaceRaised };
  const tone = accentToneSet(name, dark);
  return { fg: tone.fg, soft: tone.soft };
}

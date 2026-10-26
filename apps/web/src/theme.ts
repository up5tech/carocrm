import type { ThemeConfig } from 'antd';

import { ACCENT_NAMES, ACCENT_TONES, type AccentName,accentTone, COLOR, FONT_FAMILY } from './theme/tokens.js';

export { ACCENT_NAMES, ACCENT_TONES, accentTone, COLOR, FONT_FAMILY } from './theme/tokens.js';

/**
 * CaroCRM design tokens (PLAN_Phase_20_Settings_UX.md §20.20). Every value below is read from
 * `tokens.ts` — there is no literal colour in this file, so an Ant Design token and the matching CSS
 * custom property (`styles/tokens.css`) can never drift apart.
 */
export const carocrmTheme: ThemeConfig = {
  token: {
    colorPrimary: COLOR.accent,
    colorInfo: COLOR.stateInfo,
    colorLink: COLOR.accent,
    colorSuccess: COLOR.stateSuccess,
    colorWarning: COLOR.stateWarning,
    colorError: COLOR.stateError,
    colorTextBase: COLOR.inkPrimary,
    colorTextSecondary: COLOR.inkSecondary,
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
      bodyBg: COLOR.surfacePage,
      headerBg: COLOR.surfaceRaised,
      headerHeight: 70,
      headerPadding: '0 24px',
      siderBg: COLOR.surfaceRaised,
      footerBg: COLOR.surfaceRaised,
      footerPadding: '24px',
    },
    Menu: {
      itemHeight: 40,
      itemMarginInline: 8,
      itemBorderRadius: 8,
      itemBg: 'transparent',
      itemSelectedBg: COLOR.menuSelectedBg,
      itemSelectedColor: COLOR.accent,
      itemColor: COLOR.inkMenu,
      subMenuItemBg: 'transparent',
      iconMarginInlineEnd: 10,
    },
    Card: {
      borderRadiusLG: 8,
      paddingLG: 22,
      headerBg: 'transparent',
      headerHeight: 55,
      headerFontSize: 15,
      colorBorderSecondary: COLOR.lineStrong,
    },
    Pagination: {
      itemSize: 32,
      borderRadius: 6,
    },
    Table: {
      headerBg: COLOR.tableHeaderBg,
      headerColor: COLOR.inkPrimary,
      headerSplitColor: 'transparent',
      borderColor: COLOR.lineStrong,
      cellPaddingBlock: 12,
      cellPaddingInline: 16,
      rowHoverBg: COLOR.tableRowHover,
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

/**
 * Build a theme for a brand accent name (General settings → `primaryColor`). Defaults to blue when
 * the name is unknown or absent. This recolours Ant Design's primary/info/link tokens and the menu's
 * selected row; the shell's own accent usages follow because `BrandTheme` also sets the
 * `--carocrm-accent*` CSS variables from the same tone set.
 */
export function themeForBrand(primaryColor: string | undefined | null): ThemeConfig {
  const tone = accentTone(primaryColor);
  return {
    ...carocrmTheme,
    token: {
      ...carocrmTheme.token,
      colorPrimary: tone.fg,
      colorInfo: tone.fg,
      colorLink: tone.fg,
    },
    components: {
      ...carocrmTheme.components,
      Menu: {
        ...carocrmTheme.components?.Menu,
        itemSelectedBg: tone.soft,
        itemSelectedColor: tone.fg,
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

/** The accent pair for a name, or the neutral pair when the entry carries none. */
export function navAccent(name: string | undefined): { fg: string; soft: string } {
  if (name === undefined) return { fg: COLOR.inkFaint, soft: COLOR.surfaceRaised };
  return NAV_ACCENTS[name] ?? { fg: COLOR.inkFaint, soft: COLOR.surfaceRaised };
}

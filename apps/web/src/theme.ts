import type { ThemeConfig } from 'antd';

/**
 * CaroCRM design tokens: primary #438eff, Inter, layout #f5f5f5, white 260px sider /
 * 70px header with #eff2f7 separators, 8px cards with a #f0f0f0 border and no shadow.
 */
export const carocrmTheme: ThemeConfig = {
  token: {
    colorPrimary: '#438eff',
    colorInfo: '#438eff',
    colorLink: '#438eff',
    colorSuccess: '#55c27f',
    colorWarning: '#f8ac59',
    colorError: '#fa626b',
    colorTextBase: '#31373d',
    colorTextSecondary: '#737b85',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
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
      bodyBg: '#f5f5f5',
      headerBg: '#ffffff',
      headerHeight: 70,
      headerPadding: '0 24px',
      siderBg: '#ffffff',
      footerBg: '#ffffff',
      footerPadding: '24px',
    },
    Menu: {
      itemHeight: 40,
      itemMarginInline: 8,
      itemBorderRadius: 8,
      itemBg: 'transparent',
      itemSelectedBg: '#f0f8ff',
      itemSelectedColor: '#438eff',
      itemColor: '#5b636d',
      subMenuItemBg: 'transparent',
      iconMarginInlineEnd: 10,
    },
    Card: {
      borderRadiusLG: 8,
      paddingLG: 22,
      headerBg: 'transparent',
      headerHeight: 55,
      headerFontSize: 15,
      colorBorderSecondary: '#f0f0f0',
    },
    Pagination: {
      itemSize: 32,
      borderRadius: 6,
    },
    Table: {
      headerBg: '#fafafa',
      headerColor: '#31373d',
      headerSplitColor: 'transparent',
      borderColor: '#f0f0f0',
      cellPaddingBlock: 12,
      cellPaddingInline: 16,
      rowHoverBg: '#f8fbff',
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
 * Menu accent tokens (PLAN_Phase_20_Settings_UX.md §4.4). An accent is one of eight named tokens,
 * never a free colour: the server validates the name against the same list, so a settings document
 * can only choose a treatment the design system already owns. Colour marks a group, it is never the
 * only signal — the label and icon carry the meaning too (§5.8).
 */
export const NAV_ACCENTS: Record<string, { fg: string; soft: string }> = {
  blue: { fg: '#438eff', soft: '#f0f8ff' },
  green: { fg: '#55c27f', soft: '#f2fbf6' },
  orange: { fg: '#f8ac59', soft: '#fff8f0' },
  red: { fg: '#fa626b', soft: '#fff5f5' },
  purple: { fg: '#722ed1', soft: '#f7f3ff' },
  cyan: { fg: '#13c2c2', soft: '#f0fbfb' },
  magenta: { fg: '#eb2f96', soft: '#fff0f8' },
  gold: { fg: '#d4b106', soft: '#fdfbe8' },
};

export const NAV_ACCENT_NAMES: readonly string[] = Object.keys(NAV_ACCENTS);

/** The accent pair for a name, or the neutral pair when the entry carries none. */
export function navAccent(name: string | undefined): { fg: string; soft: string } {
  return (name === undefined ? undefined : NAV_ACCENTS[name]) ?? { fg: '#a1a8b3', soft: '#ffffff' };
}

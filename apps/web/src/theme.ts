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
    // Select and DatePicker must match Input's height or Space.Compact rows sit crooked
    Select: { borderRadius: 6, controlHeight: 36 },
    DatePicker: { borderRadius: 6, controlHeight: 36 },
    Tag: { borderRadiusSM: 4 },
    Statistic: { contentFontSize: 24 },
    Descriptions: { itemPaddingBottom: 12 },
  },
};

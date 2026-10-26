import { Button, Result, Typography } from 'antd';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { t } from '../state/i18n.js';

interface Props {
  children: ReactNode;
  /**
   * `app` is the outermost boundary: its fallback replaces the whole screen, so the only useful
   * action is a reload. `route` keeps the shell (header, menu, footer) and can therefore offer
   * "try again" and "back to home".
   */
  scope?: 'app' | 'route';
}

interface State {
  error: Error | null;
}

/**
 * Render-failure boundary (PLAN_Phase_20_Settings_UX.md §20.22).
 *
 * Without one, a throw inside any component unmounts the whole React tree and the operator is left
 * with a blank page and no explanation — one malformed record payload or one bad metadata field
 * definition was enough. The boundary turns that into a readable card.
 *
 * Two instances are mounted on purpose (`main.tsx` and `AppShell`):
 *
 * - the outer one catches a failure in the shell itself, where nothing else can be trusted;
 * - the inner one wraps only the routed page, so a crash in one screen leaves the navigation usable
 *   and the operator can walk to a screen that works. It is keyed by pathname, so navigating away
 *   resets it instead of pinning the failure to every later page.
 *
 * The error is always logged with the route: the same component can fail on one record and not on
 * another, and the path is the only thing that tells those two apart in a console.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[carocrm] render failed', {
      route: window.location.pathname,
      error,
      componentStack: info.componentStack,
    });
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    const scope = this.props.scope ?? 'app';
    return (
      <div className="carocrm-crash" role="alert">
        <Result
          status="error"
          title={t('core.renderFailedTitle')}
          subTitle={t('core.renderFailedHint')}
          extra={
            scope === 'route' ? (
              <>
                <Button type="primary" onClick={this.retry}>
                  {t('core.tryAgain')}
                </Button>
                <Link to="/home" onClick={this.retry}>
                  <Button>{t('core.goHome')}</Button>
                </Link>
              </>
            ) : (
              <Button type="primary" onClick={() => window.location.reload()}>
                {t('core.reloadPage')}
              </Button>
            )
          }
        >
          {import.meta.env.DEV ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              <Typography.Text code>{error.message}</Typography.Text>
            </Typography.Paragraph>
          ) : null}
        </Result>
      </div>
    );
  }
}

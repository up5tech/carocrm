import { DisconnectOutlined } from '@ant-design/icons';
import { onlineManager } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { t } from '../state/i18n.js';

/**
 * Offline banner (PLAN_Phase_20_Settings_UX.md §20.22, plan §1.1 "offline states everywhere").
 *
 * React Query already owns the network state: `onlineManager` listens to `navigator.onLine` and the
 * `online`/`offline` events, and pauses every query while the browser is offline instead of firing
 * requests that can only fail. Subscribing to it — rather than adding a second listener — means the
 * banner and the query cache can never disagree about whether the app is connected.
 *
 * The banner explains the state; it does not block anything. Reads already on screen stay readable
 * (that is the point of showing it instead of a spinner), and writes will fail with the server's own
 * message if the connection is not back yet.
 */
export function OfflineBanner() {
  const { message } = AntApp.useApp();
  const online = useSyncExternalStore(
    (onStoreChange) => onlineManager.subscribe(onStoreChange),
    () => onlineManager.isOnline(),
  );
  // Only announce a *recovery*: the first render of an offline session must not claim it just came
  // back, and the initial `true` must not fire a toast on every page load.
  const wasOffline = useRef(false);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      void message.success(t('core.backOnline'));
    }
  }, [online, message]);

  if (online) return null;

  return (
    <div className="carocrm-offline" role="status" aria-live="polite">
      <DisconnectOutlined />
      <span className="carocrm-offline-title">{t('core.offlineTitle')}</span>
      <span className="carocrm-offline-hint">{t('core.offlineHint')}</span>
    </div>
  );
}

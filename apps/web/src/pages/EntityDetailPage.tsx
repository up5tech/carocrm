import { DeleteOutlined, DisconnectOutlined, EditOutlined, LinkOutlined, PlusOutlined, ProjectOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Descriptions, Popconfirm, Select, Space, Spin, Table, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api,ApiError } from '../api/client.js';
import type { EntityDefinition, Metadata } from '../api/types.js';
import { CampaignLifecycleActions } from '../components/CampaignLifecycleActions.js';
import { CaseConversation } from '../components/CaseConversation.js';
import { CaseLifecycleActions } from '../components/CaseLifecycleActions.js';
import { CaseQueueWorkload } from '../components/CaseQueueWorkload.js';
import { CommunicationsPanel } from '../components/CommunicationsPanel.js';
import { FieldValue, useLinkOptions } from '../components/fields.js';
import { OpportunityDocumentActions } from '../components/OpportunityDocumentActions.js';
import { PortalCaseConversation } from '../components/PortalCaseConversation.js';
import { type RelationAccess, RelationTabs } from '../components/RelationTabs.js';
import { SalesDocumentLinesPanel } from '../components/SalesDocumentLinesPanel.js';
import { StreamPanel } from '../components/StreamPanel.js';
import { salesDocumentKind } from '../sales/documents.js';
import { PORTAL_HIDDEN_CASE_FIELDS } from '../service-desk/portal-case-fields.js';
import { t } from '../state/i18n.js';
import { evaluateEntityLogic } from '../state/logic.js';
import {
  detailEntries,
  type FieldEntry,
  fieldLabel,
  layoutFieldNames,
  layoutPanelsFor,
  orderByLayout,
  panelFieldNames,
  recordLabel,
  useEntity,
  useMetadata,
} from '../state/metadata.js';
import { portalBase } from '../state/portal.js';
import { useSession } from '../state/session.js';

interface PanelProps {
  parent: string;
  parentId: string;
  name: string;
  /** Admin-supplied display name for this relation; falls back to the humanized relation name. */
  label?: string | null | undefined;
  targetDefinition: EntityDefinition | undefined;
  /** Route base of the current app: `/portal` for portal users (PLAN §37). */
  base: string;
  /** Reports whether the caller may read the relation (PLAN §5.11). */
  onAccess?: ((access: RelationAccess) => void) | undefined;
  /** Renders nothing when the relation is unreadable. Off by default: the stacked page is unchanged. */
  hideWhenDenied?: boolean | undefined;
}

/** A refused `/Related` call is an authorization decision, not a transport failure. */
function isDenied(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** One relationship panel (PLAN §20 relationship panels) with link/unlink actions. */
function RelationPanel({ parent, parentId, name, label, targetDefinition, base, onAccess, hideWhenDenied }: PanelProps) {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const targetName = targetDefinition?.name;
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState(false);
  const linkOptions = useLinkOptions(targetName, term);
  // The callback is read through a ref: it is a fresh arrow on every render of the parent, and the
  // load must not restart because of it.
  const onAccessRef = useRef(onAccess);
  onAccessRef.current = onAccess;

  const load = useCallback(async () => {
    if (!targetName) return;
    setLoading(true);
    try {
      const related = await api.related(parent, parentId, name, { maxSize: 50, total: false });
      setRows(related.list);
      setDenied(false);
      onAccessRef.current?.('granted');
    } catch (error) {
      setRows([]);
      const refused = isDenied(error);
      setDenied(refused);
      onAccessRef.current?.(refused ? 'denied' : 'granted');
    } finally {
      setLoading(false);
    }
  }, [parent, parentId, name, targetName]);

  const linkedIds = useMemo(() => new Set(rows.map((row) => String(row['id']))), [rows]);
  const candidates = linkOptions.filter((option) => !linkedIds.has(option.value));

  useEffect(() => {
    void load();
  }, [load]);

  // A relation the caller may not read renders nothing in tab mode; the stacked page keeps today's
  // empty card, so a user who never opens the control sees the same page as before (§5.11).
  if (denied && hideWhenDenied === true) return null;

  return (
    <Card
      className="carocrm-card"
      title={<Typography.Text strong>{label ?? fieldLabel(name)}</Typography.Text>}
      extra={
        <Space.Compact>
          <Select
            style={{ width: 220 }}
            placeholder={t('web.detail.linkExisting')}
            showSearch
            filterOption={false}
            onSearch={setTerm}
            value={selected}
            onChange={(value) => { setSelected(value); setTerm(''); }}
            options={candidates}
          />
          <Button
            icon={<LinkOutlined />}
            disabled={!selected}
            onClick={async () => {
              if (!selected) return;
              try {
                await api.link(parent, parentId, name, selected);
                setSelected(undefined);
                void message.success(t('web.detail.linked'));
                await load();
              } catch (error) {
                void message.error(error instanceof Error ? error.message : t('web.detail.linkFailed'));
              }
            }}
          >
            {t('web.detail.link')}
          </Button>
          {targetName ? (
            <Button icon={<PlusOutlined />} onClick={() => navigate(`${base}/${targetName}/create`)}>
              {t('web.detail.new')}
            </Button>
          ) : null}
        </Space.Compact>
      }
    >
      <Table
        rowKey={(row) => String(row['id'])}
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          {
            title: targetDefinition?.label ?? name,
            dataIndex: 'name',
            render: (_: unknown, row: Record<string, unknown>) => (
              <Link to={`${base}/${targetName ?? ''}/${String(row['id'])}`}>{recordLabel(row, targetDefinition)}</Link>
            ),
          },
          {
            title: '',
            key: 'actions',
            width: 60,          render: (_: unknown, row: Record<string, unknown>) => (
            <Popconfirm
              title={t('web.detail.unlink')}
              onConfirm={async () => {
                  try {
                    await api.unlink(parent, parentId, name, String(row['id']));
                    await load();
                  } catch (error) {
                    void message.error(error instanceof Error ? error.message : t('web.detail.unlinkFailed'));
                  }
                }}
              >
                <Button size="small" type="text" icon={<DisconnectOutlined />} />
              </Popconfirm>
            ),
          },
        ]}
      />
    </Card>
  );
}

/**
 * The relation area of a record page (PLAN_Phase_20_Settings_UX.md §5.11, sub-phase 20.18).
 *
 * The entity's `detailTabs` metadata decides whether the relations render as today's stacked panels
 * or as tabs an administrator arranged in Entity Manager → Layout → detail. This component only
 * reads that section and hands the panels over; the record page offers no editor of its own.
 *
 * Three things stay outside the tab area, because they are not link lists:
 *
 * - a commercial document's `items` panel — the money the document is calculated from, which can
 *   only be written through the document command (§5.11 rule 11);
 * - Stream and Communications, which keep their fixed position below the relation area (§5.4);
 * - the portal, which stays stacked (§5.11 rule 9).
 */
function RelationSection({
  entity,
  id,
  definition,
  metadata,
  base,
}: {
  entity: string;
  id: string;
  definition: EntityDefinition | undefined;
  metadata: Metadata | undefined;
  base: string;
}) {
  const relations = useMemo(() => Object.keys(definition?.relations ?? {}), [definition]);
  // A commercial document's lines are not a link list: they are the money the document is
  // calculated from. The panel stays outside the tab area, in front of the relation tabs.
  const documentKind = salesDocumentKind(entity);
  const documentRelation = documentKind !== undefined && relations.includes('items') ? 'items' : undefined;
  const linkRelations = useMemo(
    () => relations.filter((relation) => relation !== documentRelation),
    [relations, documentRelation],
  );

  const labelOf = useCallback(
    (relation: string) => definition?.relations[relation]?.label ?? fieldLabel(relation),
    [definition],
  );

  // The portal stays stacked: customer-facing surfaces are out of scope (§5.11 rule 9), so the
  // entity's arrangement is ignored there.
  const arrangement = base === '/portal' ? undefined : definition?.detailTabs;
  const tabsMode = arrangement?.mode === 'tabs';

  const renderPanel = useCallback(
    (relation: string, report: (access: RelationAccess) => void) => (
      <RelationPanel
        key={relation}
        parent={entity}
        parentId={id}
        name={relation}
        label={definition?.relations[relation]?.label}
        base={base}
        targetDefinition={metadata?.[definition?.relations[relation]?.target ?? ''] ?? undefined}
        onAccess={report}
        // In tab mode a relation the caller may not read renders nothing; the stacked page keeps
        // today's empty card, so an entity whose layout is untouched sees the same page (§5.11).
        hideWhenDenied={tabsMode}
      />
    ),
    [entity, id, definition, metadata, base, tabsMode],
  );

  return (
    <>
      {documentRelation !== undefined && documentKind !== undefined ? (
        <SalesDocumentLinesPanel kind={documentKind} id={id} />
      ) : null}
      <RelationTabs
        arrangement={arrangement}
        relationNames={linkRelations}
        labelOf={labelOf}
        renderPanel={renderPanel}
      />
    </>
  );
}

export function EntityDetailPage() {
  const { entity, id } = useParams<{ entity: string; id: string }>();
  const navigate = useNavigate();
  const { principal } = useSession();
  const base = portalBase(principal?.type);
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const definition = useEntity(entity);
  const [record, setRecord] = useState<Record<string, unknown> | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!entity || !id) return;
    setLoading(true);
    try {
      setRecord(await api.get(entity, id));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.detail.notFound'));
      setRecord(undefined);
    } finally {
      setLoading(false);
    }
  }, [entity, id, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const logic = useMemo(
    () => evaluateEntityLogic(definition.data, record ?? {}),
    [definition.data, record],
  );
  const entries = useMemo(
    () =>
      detailEntries(definition.data)
        .filter((entry) => logic.fields[entry.name]?.visible !== false)
        .filter((entry) => base !== '/portal' || entity !== 'Case' || !PORTAL_HIDDEN_CASE_FIELDS.has(entry.name)),
    [definition.data, logic, base, entity],
  );
  // PLAN §8: an entity without a 'detail' layout keeps the single field-ordered Descriptions.
  const panels = useMemo(() => layoutPanelsFor(definition.data, 'detail'), [definition.data]);
  const ordered = useMemo(() => orderByLayout(entries, panels), [entries, panels]);
  const covered = useMemo(() => layoutFieldNames(panels), [panels]);
  const others = useMemo(() => ordered.filter((entry) => !covered.has(entry.name)), [ordered, covered]);

  const labelStyle = { width: 200, color: '#737b85', fontWeight: 400, paddingBlock: 10 };
  const contentStyle = { paddingBlock: 10, paddingInlineEnd: 24 };
  const describe = (list: FieldEntry[]) =>
    list.map((entry) => ({
      key: entry.name,
      label: fieldLabel(entry.name, entry.field, metadata.data),
      children: <FieldValue field={entry.field} value={record?.[entry.name]} />,
    }));

  if (!entity || !id) return <Card>{t('web.detail.missingParams')}</Card>;

  return (
    <Spin spinning={loading}>
      {/* A column stack rather than an antd `Space`: a flex item's default `min-width: auto` lets a
          wide child (the line-item table) grow the page instead of scrolling inside its card. See
          `.carocrm-card-stack` in carocrm.css. */}
      <div className="carocrm-card-stack">
        <Card
          className="carocrm-card"
          title={
            <Space>
              <Typography.Text strong>{definition.data?.label ?? entity}</Typography.Text>
              <Typography.Text type="secondary">{recordLabel(record, definition.data)}</Typography.Text>
            </Space>
          }
          extra={
            <Space>
              {/* Phase 19: a Project opens its own views; the tabs are navigation, not permission —
                  the API decides what each one may show. */}
              {entity === 'Project' && base !== '/portal'
                ? [
                    { key: 'plan', to: `/Project/${id}/plan`, label: t('web.projects.tabPlan') },
                    { key: 'board', to: `/Project/${id}/board`, label: t('web.projects.tabBoard') },
                    { key: 'gantt', to: `/Project/${id}/gantt`, label: t('web.projects.tabGantt') },
                    { key: 'members', to: `/Project/${id}/members`, label: t('web.projects.tabMembers') },
                    { key: 'settings', to: `/Project/${id}/settings`, label: t('web.projects.tabSettings') },
                  ].map((view) => (
                    <Button key={view.key} icon={<ProjectOutlined />} onClick={() => navigate(view.to)}>
                      {view.label}
                    </Button>
                  ))
                : null}
              <Button icon={<EditOutlined />} type="primary" onClick={() => navigate(`${base}/${entity}/${id}/edit`)}>
                {t('web.detail.edit')}
              </Button>
              {base === '/portal' && entity === 'Case' ? null : (
                <Popconfirm
                  title={t('web.detail.deleteThisRecord')}
                  onConfirm={async () => {
                    try {
                      await api.remove(entity, id);
                      void message.success(t('web.detail.deleted'));
                      navigate(`${base}/${entity}`);
                    } catch (error) {
                      void message.error(error instanceof Error ? error.message : t('web.detail.deleteFailed'));
                    }
                  }}
                >
                  <Button danger icon={<DeleteOutlined />}>
                    {t('web.detail.delete')}
                  </Button>
                </Popconfirm>
              )}
            </Space>
          }
        >
          {panels.length === 0 ? (
            <Descriptions
              column={{ xs: 1, md: 2 }}
              colon={false}
              labelStyle={labelStyle}
              contentStyle={contentStyle}
              items={describe(ordered)}
            />
          ) : null}
        </Card>

        {/* Phase 19-S.7/19-S.17 — the commercial hand-off from a deal. The panel only navigates: the
            document needs priced lines, which the create screen's line editor collects, and the save
            there goes through the Opportunity command so the party, the provenance and the
            double-billing guards all apply. */}
        {entity === 'Opportunity' && base !== '/portal' ? <OpportunityDocumentActions opportunityId={id} /> : null}

        {/* Phase 19-SD.4/SD.5 — a Case carries the server-defined state machine and assignment entry
            points: the buttons render exactly the commands the server says the actor may run, and a
            CaseQueue shows who is available and how loaded they are. The server decides both. */}
        {entity === 'Case' && base !== '/portal' ? <CaseLifecycleActions caseId={id} onChanged={load} /> : null}
        {entity === 'CaseQueue' && base !== '/portal' ? <CaseQueueWorkload queueId={id} /> : null}

        {/* Phase 19-MA.3 — a Campaign carries the server-defined lifecycle and its send-readiness report:
            the buttons are exactly the commands the server says this actor may run in this status, and the
            blockers are the server's findings, never a client-side re-derivation (§8.2, AGENTS.md §5.3). */}
        {entity === 'Campaign' && base !== '/portal' ? <CampaignLifecycleActions campaignId={id} onChanged={load} /> : null}

        {panels.map((panel) => (          <Card
            key={panel.name}
            className="carocrm-card"
            title={<Typography.Text strong>{panel.label ?? panel.name}</Typography.Text>}
          >
            <Descriptions
              column={{ xs: 1, md: 2 }}
              colon={false}
              labelStyle={labelStyle}
              contentStyle={contentStyle}
              items={describe(ordered.filter((entry) => panelFieldNames(panel).has(entry.name)))}
            />
          </Card>
        ))}

        {/* Fields no panel places stay visible under **Other** — the layout editor shows the same
            computed group, so the page and the settings never disagree (§5.5). An entity with no
            detail layout already renders one field list in the card above; an Other card there
            would repeat every field. */}
        {panels.length > 0 && others.length > 0 ? (
          <Card className="carocrm-card" title={<Typography.Text strong>{t('core.common.other')}</Typography.Text>}>
            <Descriptions column={{ xs: 1, md: 2 }} colon={false} labelStyle={labelStyle} contentStyle={contentStyle} items={describe(others)} />
          </Card>
        ) : null}

        {/* The relation area: today's stacked panels, or the tabs the user arranged for this entity
            (§5.11, sub-phase 20.18). A commercial document's line items stay in front of it. */}
        {entity && id ? (
          <RelationSection entity={entity} id={id} definition={definition.data} metadata={metadata.data} base={base} />
        ) : null}

        {/* Phase 19-VC.17 — communication history in the record's own context. The panel asks the
            server for this record; it renders nothing when the record is unreadable or has no
            history, and it never loads bodies until a call is opened. Portal users get no panel:
            customer-facing surfaces stay out of scope (see the compatibility doc). */}
        {base !== '/portal' ? <CommunicationsPanel entityType={entity} entityId={id} /> : null}

        {/* Phase 19-SD.6 — a Case gets the visibility-aware conversation panel: an explicit public /
            internal composer and a timeline that badges every entry's visibility. SD.11 gives the
            portal its own customer-safe conversation: public entries only, replies posted through
            the generic Note endpoint that forces portal visibility. Other records keep the generic
            stream panel (whose posts are internal by default). */}
        {entity === 'Case' ? (
          base === '/portal' ? (
            <PortalCaseConversation caseId={id} />
          ) : (
            <CaseConversation caseId={id} definition={definition.data} onChanged={load} />
          )
        ) : (
          <StreamPanel entity={entity} id={id} definition={definition.data} canPost />
        )}
      </div>
    </Spin>
  );
}

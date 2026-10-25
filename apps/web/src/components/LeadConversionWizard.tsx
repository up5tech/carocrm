import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Modal, Radio, Select, Space, Steps, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import type {
  LeadConversionAffordance,
  LeadConversionPreviewView,
  LeadConversionResult,
  LeadConversionTargetPreview,
  Metadata,
} from '../api/types.js';
import { errorText, named } from '../pages/lead-score/shared.js';
import { formatDateTime, t } from '../state/i18n.js';
import { useMetadata } from '../state/metadata.js';

/**
 * Phase 19-LS.14 — the conversion card and its wizard
 * (`PLAN_Phase_19_LeadScore.md` §7.1–§7.4, §11.4, §16 `19-LS.14`; contract §8, §12.2; compat §4.1–§4.3).
 *
 * The screen is deliberately thin, for the same reason the Lead Score card is: **the server owns every
 * decision this form presents.** The card is shown because
 * `GET /LeadScore/action/conversion/affordance` answered `canConvert: true` — a 200 with reasons, not an
 * error, so a button can disappear without a toast. The review step is the server's own preview: which values
 * would be written, which would not and why, which required values are missing, the before/after of every
 * conflict, the duplicate candidates, and the confirmations the person must be shown. Confirming sends the
 * preview's fingerprint back; if the Lead moved in between, the command answers `LEADSCORE_PREVIEW_STALE` and
 * this screen **re-takes the preview** instead of pretending the old one still holds.
 *
 * Recovery is the operation key, not a fresh attempt. The request body — key included — is written to
 * `sessionStorage` *before* the call, so a timeout, a dropped response or a reload leaves something to resume;
 * resuming re-sends that exact body, and the key makes a second set of records impossible (plan §11.4).
 *
 * 19-LS.16 added the third target without adding a second form: the rows come from the affordance's `targets`,
 * the Opportunity choice reuses the same create/link controls and the same preview, and a relationship the
 * command sets by policy (`accountId` on a linked deal) arrives as a read-only before/after rather than a
 * checkbox. Sales' own fields are not on this screen; they are edited on the record, after conversion.
 */

const PENDING_PREFIX = 'leadConversion:pending:';

type TargetAction = 'none' | 'create' | 'link';

interface ChoiceState {
  readonly account: TargetAction;
  readonly contact: TargetAction;
  readonly opportunity: TargetAction;
  readonly accountId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly opportunityId?: string | undefined;
}

/** The target types this component knows how to render; the server's `targets` is the allowlist. */
const KNOWN_TARGETS = ['Contact', 'Account', 'Opportunity'] as const;

function choiceOf(choices: ChoiceState, type: string): TargetAction {
  if (type === 'Account') return choices.account;
  if (type === 'Contact') return choices.contact;
  if (type === 'Opportunity') return choices.opportunity;
  return 'none';
}

function chosenId(choices: ChoiceState, type: string): string | undefined {
  if (type === 'Account') return choices.accountId;
  if (type === 'Contact') return choices.contactId;
  if (type === 'Opportunity') return choices.opportunityId;
  return undefined;
}

function withChoice(choices: ChoiceState, type: string, action: TargetAction): ChoiceState {
  if (type === 'Account') return { ...choices, account: action, ...(action === 'link' ? {} : { accountId: undefined }) };
  if (type === 'Contact') return { ...choices, contact: action, ...(action === 'link' ? {} : { contactId: undefined }) };
  if (type === 'Opportunity') return { ...choices, opportunity: action, ...(action === 'link' ? {} : { opportunityId: undefined }) };
  return choices;
}

function withId(choices: ChoiceState, type: string, id: string): ChoiceState {
  if (type === 'Account') return { ...choices, accountId: id };
  if (type === 'Contact') return { ...choices, contactId: id };
  if (type === 'Opportunity') return { ...choices, opportunityId: id };
  return choices;
}

interface ConvertBody {
  readonly leadId: string;
  readonly operationKey: string;
  readonly targets: { type: string; action: 'create' | 'link'; existingId?: string }[];
  readonly fieldMerge?: { target: string; field: string; value: unknown }[];
  readonly previewHash: string;
  readonly acknowledged: string[];
  readonly overrideDuplicateFor?: string[];
  readonly allowReparent?: boolean;
}

/** The card on the record: status, links once converted, and the button that opens the wizard. */
export function LeadConversionSection({ leadId, leadName, onChanged }: { leadId: string; leadName: string; onChanged?: () => void }) {
  const affordance = useQuery({
    queryKey: ['leadScore', 'conversion', leadId],
    queryFn: () => api.leadScoreConversionAffordance(leadId),
    retry: false,
    staleTime: 10_000,
  });
  const [open, setOpen] = useState(false);
  const data: LeadConversionAffordance | undefined = affordance.data;
  // A read that refused (module off, no Lead read) shows nothing rather than an error card on the record.
  if (data === undefined) return null;

  return (
    <Card className="carocrm-card" title={t('leadscore.conversion.title')} size="small">
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {data.alreadyConverted ? (
          <>
            <Typography.Text type="secondary">{t('leadscore.conversion.done', { date: formatDateTime(data.convertedAt) })}</Typography.Text>
            <Space wrap size={12}>
              {data.convertedContactId === null ? null : (
                <Link to={`/Contact/${encodeURIComponent(data.convertedContactId)}`}>{t('leadscore.conversion.convertedContact')}</Link>
              )}
              {data.convertedAccountId === null ? null : (
                <Link to={`/Account/${encodeURIComponent(data.convertedAccountId)}`}>{t('leadscore.conversion.convertedAccount')}</Link>
              )}
              {data.convertedOpportunityId === null ? null : (
                <Link to={`/Opportunity/${encodeURIComponent(data.convertedOpportunityId)}`}>{t('leadscore.conversion.convertedOpportunity')}</Link>
              )}
            </Space>
          </>
        ) : (
          <>
            <Typography.Text type="secondary">
              {data.canConvert ? t('leadscore.conversion.hint') : reasonsText(data.reasons)}
            </Typography.Text>
            <Button type="primary" disabled={!data.canConvert} onClick={() => setOpen(true)}>
              {t('leadscore.conversion.open')}
            </Button>
          </>
        )}
      </Space>
      {open ? (
        <LeadConversionWizard
          leadId={leadId}
          leadName={leadName}
          canOverride={data.canOverride}
          availableTargets={data.targets}
          open={open}
          onClose={() => setOpen(false)}
          onConverted={() => {
            // The wizard shows its own result step; closing here would hide the record links it just created.
            void affordance.refetch();
            onChanged?.();
          }}
        />
      ) : null}
    </Card>
  );
}

function reasonsText(reasons: readonly string[]): string {
  if (reasons.length === 0) return '';
  return reasons
    .map((reason) => named(`leadscore.conversion.reason.${reason}`, reason))
    .join(' ');
}

export function LeadConversionWizard({
  leadId,
  leadName,
  canOverride,
  availableTargets,
  open,
  onClose,
  onConverted,
}: {
  leadId: string;
  leadName: string;
  /** Whether the duplicate-override box may be offered at all (contract §9.5). */
  canOverride: boolean;
  /** What the affordance says this installation may build — Account/Contact/Opportunity, filtered server-side. */
  availableTargets: readonly string[];
  open: boolean;
  onClose: () => void;
  onConverted: () => void;
}) {
  const metadata = useMetadata();
  const types = useMemo(() => KNOWN_TARGETS.filter((type) => availableTargets.includes(type)), [availableTargets]);
  const [step, setStep] = useState(0);
  const [choices, setChoices] = useState<ChoiceState>({ account: 'none', contact: 'none', opportunity: 'none' });
  const [preview, setPreview] = useState<LeadConversionPreviewView | undefined>(undefined);
  const [operationKey, setOperationKey] = useState('');
  const [result, setResult] = useState<LeadConversionResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<'preview' | 'convert' | undefined>(undefined);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [merges, setMerges] = useState<Record<string, boolean>>({});
  const [allowReparent, setAllowReparent] = useState(false);
  const [resumable, setResumable] = useState<ConvertBody | undefined>(undefined);

  // A body written before a call that never answered. It is offered, never re-sent silently.
  useEffect(() => {
    if (!open) return;
    const raw = window.sessionStorage.getItem(PENDING_PREFIX + leadId);
    if (raw === null) return;
    try {
      setResumable(JSON.parse(raw) as ConvertBody);
    } catch {
      window.sessionStorage.removeItem(PENDING_PREFIX + leadId);
    }
  }, [leadId, open]);

  const linkable = (type: string) => choiceOf(choices, type) === 'link';
  const contacts = useQuery({
    queryKey: ['leadConversion', 'pick', 'Contact'],
    queryFn: async () => (await api.list('Contact', { maxSize: 50, orderBy: 'modifiedAt,desc' })).list,
    enabled: open && linkable('Contact'),
    staleTime: 30_000,
  });
  const accounts = useQuery({
    queryKey: ['leadConversion', 'pick', 'Account'],
    queryFn: async () => (await api.list('Account', { maxSize: 50, orderBy: 'modifiedAt,desc' })).list,
    enabled: open && linkable('Account'),
    staleTime: 30_000,
  });
  const opportunities = useQuery({
    queryKey: ['leadConversion', 'pick', 'Opportunity'],
    queryFn: async () => (await api.list('Opportunity', { maxSize: 50, orderBy: 'modifiedAt,desc' })).list,
    enabled: open && linkable('Opportunity'),
    staleTime: 30_000,
  });
  const records = useMemo<Record<string, { id: string; label: string }[]>>(() => {
    const toOptions = (rows: readonly Record<string, unknown>[] | undefined) =>
      (rows ?? []).map((record) => ({ id: String(record['id'] ?? ''), label: String(record['name'] ?? record['id'] ?? '') }));
    return { Contact: toOptions(contacts.data), Account: toOptions(accounts.data), Opportunity: toOptions(opportunities.data) };
  }, [accounts.data, contacts.data, opportunities.data]);

  const targets = useMemo<{ type: string; action: 'create' | 'link'; existingId?: string }[]>(() => {
    const chosen: { type: string; action: 'create' | 'link'; existingId?: string }[] = [];
    for (const type of types) {
      const action = choiceOf(choices, type);
      if (action === 'none') continue;
      if (action === 'link') {
        const existingId = chosenId(choices, type);
        if (existingId !== undefined) chosen.push({ type, action, existingId });
        continue;
      }
      chosen.push({ type, action });
    }
    return chosen;
  }, [choices, types]);
  const mergeList = useMemo(
    () =>
      (preview?.targets ?? []).flatMap((target) =>
        target.conflicts
          .filter((conflict) => merges[`${target.type}:${conflict.field}`] === true)
          .map((conflict) => ({ target: target.type, field: conflict.field, value: conflict.proposed })),
      ),
    [merges, preview],
  );

  const takePreview = async (withMerges: boolean): Promise<LeadConversionPreviewView | undefined> => {
    setBusy('preview');
    setError(undefined);
    try {
      const view = await api.leadScoreConversionPreview({
        leadId,
        targets,
        ...(withMerges && mergeList.length > 0 ? { fieldMerge: mergeList } : {}),
      });
      setPreview(view);
      if (operationKey === '') setOperationKey(newOperationKey());
      return view;
    } catch (caught) {
      setError(`${t('leadscore.conversion.wizard.previewFailed')} ${errorText(caught)}`);
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const convert = useMutation({
    mutationFn: (body: ConvertBody) => api.leadScoreConversionConvert(body),
  });

  const send = async (body: ConvertBody): Promise<void> => {
    // Written before the call: if the answer never arrives, this body is the resume.
    window.sessionStorage.setItem(PENDING_PREFIX + leadId, JSON.stringify(body));
    setBusy('convert');
    setError(undefined);
    setNote(undefined);
    try {
      const done = await convert.mutateAsync(body);
      window.sessionStorage.removeItem(PENDING_PREFIX + leadId);
      setResumable(undefined);
      setResult(done);
      setStep(2);
      onConverted();
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : '';
      if (code === 'LEADSCORE_PREVIEW_STALE') {
        // Nothing was written (the command refuses before it claims), so taking the preview again is the
        // whole recovery — and it is the server's preview, not a client-side re-derivation.
        window.sessionStorage.removeItem(PENDING_PREFIX + leadId);
        setNote(t('leadscore.conversion.wizard.stale'));
        setOperationKey(newOperationKey());
        await takePreview(true);
      } else if (caught instanceof ApiError && caught.status < 500 && code !== 'LEADSCORE_CONVERSION_IN_FLIGHT') {
        // A refusal that will not change by repeating it: the stored body would replay a failed_final row.
        window.sessionStorage.removeItem(PENDING_PREFIX + leadId);
        setError(`${t('leadscore.conversion.wizard.failed')} ${errorText(caught)}`);
      } else {
        // Unknown: the work may or may not have committed. Keep the body and offer the same key again.
        setResumable(body);
        setError(errorText(caught));
      }
    } finally {
      setBusy(undefined);
    }
  };

  const confirm = async (): Promise<void> => {
    if (preview === undefined) return;
    // Re-take the preview with the merges the person ticked, so the fingerprint describes exactly this plan.
    const fresh = await takePreview(true);
    if (fresh === undefined) return;
    if (fresh.previewHash !== preview.previewHash) {
      // The Lead or the map moved while the person was reading: show the plan that would run now and let
      // them confirm *that*, instead of converting a plan they never saw (plan §11.4, contract §8.3).
      setPreview(fresh);
      setNote(t('leadscore.conversion.wizard.stale'));
      return;
    }
    if (fresh.permission.canExecute === false) {
      setPreview(fresh);
      return;
    }
    const overrideTypes = fresh.targets.map((target) => target.type).filter((type) => overrides[type] === true);
    await send({
      leadId,
      operationKey: operationKey === '' ? newOperationKey() : operationKey,
      targets: fresh.targets.map((target) => ({
        type: target.type,
        action: target.action === 'link' ? 'link' : 'create',
        ...(target.existingId === null ? {} : { existingId: target.existingId }),
      })),
      ...(mergeList.length > 0 ? { fieldMerge: mergeList } : {}),
      previewHash: fresh.previewHash,
      acknowledged: [...fresh.confirmationTypes],
      ...(overrideTypes.length > 0 ? { overrideDuplicateFor: overrideTypes } : {}),
      ...(allowReparent ? { allowReparent: true } : {}),
    });
  };

  const footer =
    step === 2
      ? [<Button key="done" type="primary" onClick={onClose}>{t('leadscore.conversion.wizard.done')}</Button>]
      : step === 0
        ? [
            <Button key="cancel" onClick={onClose}>{t('leadscore.conversion.wizard.back')}</Button>,
            <Button key="review" type="primary" loading={busy === 'preview'} disabled={targets.length === 0} onClick={() => void takePreview(false).then((view) => { if (view !== undefined) { setStep(1); setMerges({}); } })}>
              {t('leadscore.conversion.wizard.review')}
            </Button>,
          ]
        : [
            <Button key="back" onClick={() => { setStep(0); setPreview(undefined); setMerges({}); setNote(undefined); setError(undefined); }}>
              {t('leadscore.conversion.wizard.back')}
            </Button>,
            <Button key="convert" type="primary" danger loading={busy === 'convert'} disabled={preview === undefined || !preview.permission.canExecute || busy !== undefined} onClick={() => void confirm()}>
              {busy === 'convert' ? t('leadscore.conversion.wizard.converting') : t('leadscore.conversion.wizard.convert')}
            </Button>,
          ];

  return (
    <Modal
      open={open}
      title={t('leadscore.conversion.wizard.title', { name: leadName })}
      width={860}
      onCancel={onClose}
      footer={footer}
      destroyOnClose
      className="carocrm-conversion-modal"
    >
      <Steps size="small" current={step} items={[{ title: t('leadscore.conversion.wizard.stepTargets') }, { title: t('leadscore.conversion.wizard.stepReview') }, { title: t('leadscore.conversion.wizard.stepResult') }]} style={{ marginBottom: 16 }} />

      {resumable === undefined ? null : (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('leadscore.conversion.wizard.resumeTitle')}
          description={t('leadscore.conversion.wizard.resumeHint')}
          action={
            <Space>
              <Button size="small" type="primary" onClick={() => void send(resumable)}>{t('leadscore.conversion.wizard.resume')}</Button>
              <Button size="small" onClick={() => { window.sessionStorage.removeItem(PENDING_PREFIX + leadId); setResumable(undefined); }}>{t('leadscore.conversion.wizard.discard')}</Button>
            </Space>
          }
        />
      )}
      {note === undefined ? null : <Alert type="info" showIcon style={{ marginBottom: 12 }} message={note} />}
      {error === undefined ? null : (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={error}
          action={
            resumable === undefined ? undefined : (
              <Button size="small" onClick={() => void send(resumable)}>{t('leadscore.conversion.wizard.retry')}</Button>
            )
          }
        />
      )}

      {step === 0 ? (
        <TargetsStep
          types={types}
          choices={choices}
          onChange={setChoices}
          records={records}
        />
      ) : null}

      {step === 1 && preview !== undefined ? (
        <ReviewStep
          preview={preview}
          canOverride={canOverride}
          metadata={metadata.data}
          overrides={overrides}
          onOverride={(type, value) => setOverrides((prev) => ({ ...prev, [type]: value }))}
          merges={merges}
          onMerge={(key, value) => {
            setMerges((prev) => ({ ...prev, [key]: value }));
            // The merge is part of the fingerprint; re-preview so the screen never shows a plan that differs
            // from the one the button would send.
            window.setTimeout(() => void takePreview(true), 0);
          }}
          allowReparent={allowReparent}
          onAllowReparent={setAllowReparent}
        />
      ) : null}

      {step === 2 && result !== undefined ? <ResultStep result={result} /> : null}
    </Modal>
  );
}

function TargetsStep({
  types,
  choices,
  onChange,
  records,
}: {
  types: readonly string[];
  choices: ChoiceState;
  onChange: (next: ChoiceState) => void;
  records: Record<string, { id: string; label: string }[]>;
}) {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Text type="secondary">{t('leadscore.conversion.wizard.pickHint')}</Typography.Text>
      {types.map((type) => {
        const options = records[type] ?? [];
        const value = choiceOf(choices, type);
        return (
          <div key={type} className="carocrm-conversion-target">
            <Typography.Text strong>{t(`leadscore.conversion.wizard.target.${type}`)}</Typography.Text>
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              size="small"
              value={value}
              onChange={(event) => onChange(withChoice(choices, type, event.target.value as TargetAction))}
              options={[
                { value: 'none', label: t('leadscore.conversion.wizard.action.none') },
                { value: 'create', label: t('leadscore.conversion.wizard.action.create') },
                { value: 'link', label: t('leadscore.conversion.wizard.action.link') },
              ]}
            />
            {value === 'link' ? (
              <Select
                showSearch
                optionFilterProp="label"
                style={{ minWidth: 320 }}
                placeholder={t('leadscore.conversion.wizard.pick')}
                value={chosenId(choices, type) ?? null}
                onChange={(id: string) => onChange(withId(choices, type, id))}
                options={options.map((option) => ({ value: option.id, label: option.label }))}
              />
            ) : null}
          </div>
        );
      })}
    </Space>
  );
}

function ReviewStep({
  preview,
  canOverride,
  metadata,
  overrides,
  onOverride,
  merges,
  onMerge,
  allowReparent,
  onAllowReparent,
}: {
  preview: LeadConversionPreviewView;
  canOverride: boolean;
  metadata: Metadata | undefined;
  overrides: Record<string, boolean>;
  onOverride: (type: string, value: boolean) => void;
  merges: Record<string, boolean>;
  onMerge: (key: string, value: boolean) => void;
  allowReparent: boolean;
  onAllowReparent: (value: boolean) => void;
}) {
  const label = (entity: string, field: string): string => metadata?.[entity]?.fields?.[field]?.label ?? field;
  const duplicating = (preview.duplicates?.requiresChoice ?? false);
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {preview.duplicates === null ? null : (
        <section>
          <Typography.Text strong>{t('leadscore.conversion.wizard.duplicates')}</Typography.Text>
          {(preview.duplicates.candidates.length === 0) ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t('leadscore.conversion.wizard.duplicateHidden', { count: String(preview.duplicates.hiddenMatches) })}
            </Typography.Paragraph>
          ) : (
            <ul className="carocrm-conversion-list">
              {preview.duplicates.candidates.map((candidate) => (
                <li key={`${candidate.entity}:${candidate.id}`}>
                  {t('leadscore.conversion.wizard.duplicate', {
                    label: candidate.label ?? candidate.id,
                    matchClass: named(`leadscore.conversion.match.${candidate.matchClass}`, candidate.matchClass),
                    reasons: candidate.reasons.map((reason) => named(`leadscore.conversion.reason.match.${reason}`, reason)).join(', '),
                  })}
                </li>
              ))}
            </ul>
          )}
          {preview.duplicates.hiddenMatches > 0 && preview.duplicates.candidates.length > 0 ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t('leadscore.conversion.wizard.duplicateHidden', { count: String(preview.duplicates.hiddenMatches) })}
            </Typography.Paragraph>
          ) : null}
          {duplicating
            ? preview.targets
                .filter((target) => target.action === 'create' && target.type !== 'Opportunity')
                .map((target) => (
                  <Checkbox
                    key={target.type}
                    disabled={!canOverride}
                    checked={overrides[target.type] === true}
                    onChange={(event) => onOverride(target.type, event.target.checked)}
                  >
                    {t('leadscore.conversion.wizard.duplicateOverride')} · {t(`leadscore.conversion.wizard.target.${target.type}`)}
                  </Checkbox>
                ))
            : null}
        </section>
      )}

      {preview.targets.map((target) => (
        <TargetReview key={target.type} target={target} label={label} merges={merges} onMerge={onMerge} />
      ))}

      {preview.confirmationTypes.includes('contact_reparent') ? (
        <Checkbox checked={allowReparent} onChange={(event) => onAllowReparent(event.target.checked)}>
          {t('leadscore.conversion.wizard.reparent')}
        </Checkbox>
      ) : null}

      <section>
        <Typography.Text strong>{t('leadscore.conversion.wizard.confirmation')}</Typography.Text>
        <ul className="carocrm-conversion-list">
          {preview.confirmationTypes.map((type) => (
            <li key={type}>{named(`leadscore.conversion.wizard.confirm.${type}`, type)}</li>
          ))}
        </ul>
      </section>

      {preview.permission.canExecute ? null : (
        <Alert type="warning" showIcon message={blockedText(preview.permission.reasons, preview.targets.map((target) => target.type))} />
      )}
    </Space>
  );
}

function TargetReview({
  target,
  label,
  merges,
  onMerge,
}: {
  target: LeadConversionTargetPreview;
  label: (entity: string, field: string) => string;
  merges: Record<string, boolean>;
  onMerge: (key: string, value: boolean) => void;
}) {
  const entity = target.type;
  return (
    <section className="carocrm-conversion-target-review">
      <Space size={8} wrap>
        <Typography.Text strong>{t(`leadscore.conversion.wizard.target.${entity}`)}</Typography.Text>
        <Tag>{t(`leadscore.conversion.wizard.action.${target.action}`)}</Tag>
        {target.existing === null ? null : <Typography.Text type="secondary">{target.existing.label ?? target.existing.id}</Typography.Text>}
        {target.relationship.map((link) => (
          <Tag key={`${link.type}:${link.id ?? 'new'}`} color="blue">
            {t('leadscore.conversion.wizard.relationship')} · {t(`leadscore.conversion.wizard.target.${link.type}`)} · {t(`leadscore.conversion.wizard.action.${link.action}`)}
          </Tag>
        ))}
      </Space>

      {target.proposed.length === 0 ? null : (
        <div>
          <Typography.Text type="secondary">{t('leadscore.conversion.wizard.proposed')}</Typography.Text>
          <ul className="carocrm-conversion-list">
            {target.proposed.map((entry) => (
              <li key={entry.field}>
                <Typography.Text code>{label(entity, entry.field)}</Typography.Text> {valueText(entry.value)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {target.required.length === 0 ? null : (
        <Typography.Paragraph type="danger" style={{ marginBottom: 0 }}>
          {t('leadscore.conversion.wizard.required')}: {target.required.map((field) => label(entity, field)).join(', ')}
        </Typography.Paragraph>
      )}

      {target.conflicts.length === 0 ? null : (
        <div>
          <Typography.Text type="secondary">{t('leadscore.conversion.wizard.conflicts')}</Typography.Text>
          <ul className="carocrm-conversion-list">
            {target.conflicts.map((conflict) => (
              <li key={conflict.field}>
                <Typography.Text code>{label(entity, conflict.field)}</Typography.Text> {valueText(conflict.current)} → {valueText(conflict.proposed)}
                {conflict.readOnly === true ? (
                  <Typography.Text type="secondary" style={{ marginInlineStart: 8, fontSize: 12 }}>
                    {t('leadscore.conversion.wizard.relationshipChange')}
                  </Typography.Text>
                ) : target.action === 'link' ? (
                  <Checkbox
                    style={{ marginInlineStart: 8 }}
                    checked={merges[`${entity}:${conflict.field}`] === true}
                    onChange={(event) => onMerge(`${entity}:${conflict.field}`, event.target.checked)}
                  >
                    {t('leadscore.conversion.wizard.conflictApply')}
                  </Checkbox>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {target.skipped.length === 0 ? null : (
        <div>
          <Typography.Text type="secondary">{t('leadscore.conversion.wizard.skipped')}</Typography.Text>
          <ul className="carocrm-conversion-list">
            {target.skipped.map((entry, index) => (
              <li key={`${entry.from ?? ''}:${entry.to ?? ''}:${String(index)}`}>
                <Typography.Text code>{entry.from === undefined ? '' : label('Lead', entry.from)}</Typography.Text> —{' '}
                {named(`leadscore.conversion.wizard.skip.${entry.reason}`, entry.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('leadscore.conversion.wizard.notCopied')}: {target.notCopied.map((field) => label(entity, field)).join(', ')}
      </Typography.Text>
    </section>
  );
}

function ResultStep({ result }: { result: LeadConversionResult }) {
  const rows: { key: string; label: string; id: string | null; entity: string }[] = [
    { key: 'createdContactId', label: t('leadscore.conversion.wizard.createdContact'), id: result.createdContactId, entity: 'Contact' },
    { key: 'createdAccountId', label: t('leadscore.conversion.wizard.createdAccount'), id: result.createdAccountId, entity: 'Account' },
    { key: 'createdOpportunityId', label: t('leadscore.conversion.wizard.createdOpportunity'), id: result.createdOpportunityId, entity: 'Opportunity' },
    { key: 'linkedContactId', label: t('leadscore.conversion.wizard.linkedContact'), id: result.linkedContactId, entity: 'Contact' },
    { key: 'linkedAccountId', label: t('leadscore.conversion.wizard.linkedAccount'), id: result.linkedAccountId, entity: 'Account' },
    { key: 'linkedOpportunityId', label: t('leadscore.conversion.wizard.linkedOpportunity'), id: result.linkedOpportunityId, entity: 'Opportunity' },
  ].filter((row) => row.id !== null);
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert type="success" showIcon message={t('leadscore.conversion.wizard.resultTitle')} />
      <ul className="carocrm-conversion-list">
        {rows.map((row) => (
          <li key={row.key}>
            {row.label}:{' '}
            <Link to={`/${row.entity}/${encodeURIComponent(row.id ?? '')}`}>{row.id}</Link>
          </li>
        ))}
      </ul>
      <Typography.Text type="secondary">
        {t('leadscore.conversion.wizard.stepResult')} · {formatDateTime(result.completedAt)}
      </Typography.Text>
    </Space>
  );
}

function blockedText(reasons: readonly string[], types: readonly string[]): string {
  return reasons
    .map((reason) => {
      // Longest first, so a reason ending in `_Account` is never read as a `Contact` one.
      const target = [...types].sort((left, right) => right.length - left.length).find((type) => reason.endsWith(`_${type}`));
      if (reason.startsWith('required_missing_')) return named('leadscore.conversion.wizard.blocked.required', 'Required') + ` · ${target ?? ''}`;
      if (reason.startsWith('cannot_create_')) return named('leadscore.conversion.wizard.blocked.cannotCreate', 'Cannot create') + ` · ${target ?? ''}`;
      if (reason.startsWith('cannot_read_')) return named('leadscore.conversion.wizard.blocked.cannotRead', 'Cannot read') + ` · ${target ?? ''}`;
      if (reason.startsWith('target_unreadable_')) return named('leadscore.conversion.wizard.blocked.targetUnreadable', 'Target not readable') + ` · ${target ?? ''}`;
      if (reason.startsWith('merge_not_allowed_')) return named('leadscore.conversion.wizard.blocked.mergeNotAllowed', 'Merge not allowed') + ` · ${target ?? ''}`;
      if (reason === 'lead_not_editable') return named('leadscore.conversion.wizard.blocked.leadNotEditable', 'Lead not editable');
      return named(`leadscore.conversion.reason.${reason}`, reason);
    })
    .join(' · ');
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function newOperationKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `lc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

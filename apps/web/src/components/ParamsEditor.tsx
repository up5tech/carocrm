import { Input, Space, Typography } from 'antd';

/**
 * Structured parameter forms for the shared action catalog (PLAN §35 actions, reused by PLAN §36
 * service tasks).
 *
 * Automation is edited through forms, never raw JSON, so each action gets the inputs it actually
 * needs. `{{field}}` placeholders stay available in text values — that is how a step says "the
 * account this started from".
 */
export function ParamsEditor({
  action,
  params,
  onChange,
}: {
  action: string;
  params: Record<string, unknown>;
  onChange: (params: Record<string, unknown>) => void;
}) {
  const fields = paramFieldsOf(action, params);
  if (fields.length === 0) return <Typography.Text type="secondary">No parameters.</Typography.Text>;

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {fields.map((field) => (
        <Input
          key={field.key}
          size="small"
          placeholder={field.placeholder}
          value={String(params[field.key] ?? '')}
          onChange={(event) => onChange({ ...params, [field.key]: event.target.value })}
        />
      ))}
      {Object.keys(params)
        .filter((key) => !fields.some((field) => field.key === key))
        .map((key) => (
          <Input
            key={key}
            size="small"
            value={String(params[key] ?? '')}
            placeholder={key}
            onChange={(event) => onChange({ ...params, [key]: event.target.value })}
          />
        ))}
    </Space>
  );
}

function paramFieldsOf(action: string | undefined, params: Record<string, unknown>): { key: string; placeholder: string }[] {
  switch (action) {
    case 'updateRecord':
      return [{ key: 'fields', placeholder: 'field=value, field2=value2' }];
    case 'createRecord':
      return [
        { key: 'entityType', placeholder: 'entity type (Task)' },
        { key: 'fields', placeholder: 'name=Follow up, status=Planned' },
      ];
    case 'createNotification':
      return [
        { key: 'userId', placeholder: 'user id, or {{assignedUserId}}' },
        { key: 'message', placeholder: 'message' },
      ];
    case 'sendEmail':
      return [
        { key: 'to', placeholder: 'to (use {{emailAddress}})' },
        { key: 'subject', placeholder: 'subject' },
        { key: 'body', placeholder: 'body' },
      ];
    case 'runJob':
      return [{ key: 'jobName', placeholder: 'job name' }];
    default:
      return Object.keys(params).map((key) => ({ key, placeholder: key }));
  }
}

/** Default parameter shapes per action, so a new step starts with the inputs it will need. */
export function defaultParamsOf(action: string | undefined): Record<string, unknown> {
  switch (action) {
    case 'updateRecord':
      return { fields: {} };
    case 'createRecord':
      return { entityType: 'Task', fields: {} };
    case 'createNotification':
      return { userId: '', message: '' };
    case 'sendEmail':
      return { to: '', subject: '', body: '' };
    case 'runJob':
      return { jobName: '' };
    default:
      return {};
  }
}

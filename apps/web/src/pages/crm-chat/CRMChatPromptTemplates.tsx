import { DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Dropdown, Input, Modal, Popconfirm, Space, Tooltip, Typography } from 'antd';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { CRMChatPromptView } from '../../api/types.js';
import { t } from '../../state/i18n.js';

const { Text } = Typography;

export interface CRMChatPromptTemplatesProps {
  /** Whether the caller may create, edit and remove templates. */
  readonly canManage: boolean;
  /** The text currently in the composer, so a template can be saved from it. */
  readonly currentPrompt: string;
  /** The text the composer should receive. */
  readonly onInsert: (promptTemplate: string) => void;
}

/**
 * Phase 19-CHAT.14 — saved prompt templates (PLAN_Phase_19_CRM_Chat.md §7.6, §17 `19-CHAT.14`;
 * contract §6.5, §7.6).
 *
 * A template is **data**. It is a named piece of text the user keeps; inserting one puts its text
 * into the composer, where it is submitted like any other message and runs under the submitter's
 * own authorization. Nothing in this component can choose a tool, an entity, a role or a
 * permission, and the server enforces that too: the template is stored in a text column and is
 * never evaluated.
 *
 * The UI says so rather than implying a shortcut that does not exist. A template is not a macro, a
 * script, or a saved execution — it is a saved sentence.
 */
export function CRMChatPromptTemplates(props: CRMChatPromptTemplatesProps) {
  const { canManage, currentPrompt, onInsert } = props;

  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CRMChatPromptView | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [description, setDescription] = useState('');

  const prompts = useQuery({
    queryKey: ['crmChat', 'prompts'],
    queryFn: () => api.crmChatPrompts(),
    staleTime: 30_000,
    retry: false,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['crmChat', 'prompts'] });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (editing === null) {
        return api.crmChatCreatePrompt({
          name: name.trim(),
          promptTemplate: body.trim(),
          ...(description.trim() === '' ? {} : { description: description.trim() }),
        });
      }
      return api.crmChatPatchPrompt(editing.id, {
        name: name.trim(),
        promptTemplate: body.trim(),
        description: description.trim() === '' ? null : description.trim(),
      });
    },
    onSuccess: () => {
      invalidate();
      setEditing(null);
      setCreating(false);
      setName('');
      setBody('');
      setDescription('');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.crmChatDeletePrompt(id),
    onSuccess: invalidate,
  });

  const openEditor = (prompt: CRMChatPromptView | null): void => {
    setEditing(prompt);
    setCreating(prompt === null);
    setName(prompt?.name ?? '');
    setBody(prompt?.promptTemplate ?? '');
    setDescription(prompt?.description ?? '');
  };

  const list = prompts.data?.list ?? [];
  const enabled = list.filter((prompt) => prompt.enabled);

  return (
    <Space size={4} wrap>
      <Dropdown
        disabled={enabled.length === 0}
        menu={{
          items: enabled.map((prompt) => ({
            key: prompt.id,
            label: (
              <div>
                <div>{prompt.name}</div>
                {prompt.description === null ? null : (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {prompt.description}
                  </Text>
                )}
              </div>
            ),
            onClick: () => onInsert(prompt.promptTemplate),
          })),
        }}
      >
        <Button size="small" icon={<SaveOutlined />}>
          {t('web.crmChat.prompts.insert')}
        </Button>
      </Dropdown>

      {canManage ? (
        <>
          <Tooltip title={t('web.crmChat.prompts.saveHint')}>
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={currentPrompt.trim() === ''}
              onClick={() => {
                setEditing(null);
                setCreating(true);
                setName('');
                setBody(currentPrompt);
                setDescription('');
              }}
            >
              {t('web.crmChat.prompts.save')}
            </Button>
          </Tooltip>

          {list.length === 0 ? null : (
            <Dropdown
              menu={{
                items: list.map((prompt) => ({
                  key: prompt.id,
                  label: (
                    <Space>
                      <span>{prompt.name}</span>
                      <Button
                        size="small"
                        type="text"
                        icon={<EditOutlined />}
                        aria-label={t('web.crmChat.prompts.edit')}
                        onClick={(event) => {
                          event.stopPropagation();
                          openEditor(prompt);
                        }}
                      />
                      <Popconfirm
                        title={t('web.crmChat.prompts.deleteConfirm')}
                        onConfirm={(event) => {
                          event?.stopPropagation();
                          remove.mutate(prompt.id);
                        }}
                        okText={t('web.crmChat.prompts.delete')}
                        cancelText={t('core.common.cancel')}
                      >
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          aria-label={t('web.crmChat.prompts.delete')}
                          onClick={(event) => event.stopPropagation()}
                        />
                      </Popconfirm>
                    </Space>
                  ),
                  onClick: () => onInsert(prompt.promptTemplate),
                })),
              }}
            >
              <Button size="small" icon={<EditOutlined />}>
                {t('web.crmChat.prompts.manage')}
              </Button>
            </Dropdown>
          )}
        </>
      ) : null}

      <Modal
        open={creating || editing !== null}
        title={editing === null ? t('web.crmChat.prompts.createTitle') : t('web.crmChat.prompts.editTitle')}
        okText={t('core.common.save')}
        cancelText={t('core.common.cancel')}
        onCancel={() => {
          setEditing(null);
          setCreating(false);
        }}
        onOk={() => save.mutate()}
        confirmLoading={save.isPending}
        okButtonProps={{ disabled: name.trim() === '' || body.trim() === '' }}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Input
            value={name}
            maxLength={120}
            placeholder={t('web.crmChat.prompts.name')}
            onChange={(event) => setName(event.target.value)}
          />
          <Input.TextArea
            rows={5}
            value={body}
            maxLength={8000}
            placeholder={t('web.crmChat.prompts.body')}
            onChange={(event) => setBody(event.target.value)}
          />
          <Input
            value={description}
            maxLength={500}
            placeholder={t('web.crmChat.prompts.description')}
            onChange={(event) => setDescription(event.target.value)}
          />
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('web.crmChat.prompts.dataOnly')}
          </Text>
          {save.isError ? (
            <Text type="danger" style={{ fontSize: 12 }}>
              {save.error instanceof Error ? save.error.message : t('web.crmChat.prompts.saveFailed')}
            </Text>
          ) : null}
        </Space>
      </Modal>

      {prompts.isError ? (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {t('web.crmChat.prompts.unavailable')}
        </Text>
      ) : null}
    </Space>
  );
}

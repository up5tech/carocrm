import { Alert, Button, Form, Input } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useSession } from '../state/session.js';

export function LoginPage() {
  const { signIn, loading, error } = useSession();
  const navigate = useNavigate();
  const [form] = Form.useForm<{ userName: string; password: string }>();
  const [submitting, setSubmitting] = useState(false);

  return (
    <div className="lizant-auth">
      <div className="lizant-auth-card">
        <div className="lizant-auth-brand">
          <span className="lizant-brand-mark">C</span>
          <span>CaroCRM</span>
        </div>
        <p className="lizant-auth-sub">Sign in to your workspace</p>
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            setSubmitting(true);
            const ok = await signIn(values.userName, values.password);
            setSubmitting(false);
            if (ok) navigate('/home', { replace: true });
          }}
        >
          <Form.Item name="userName" label="User name" rules={[{ required: true }]}>
            <Input autoFocus autoComplete="username" size="large" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" size="large" />
          </Form.Item>
          {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
          <Button type="primary" htmlType="submit" size="large" block loading={submitting || loading}>
            Sign in
          </Button>
        </Form>
      </div>
    </div>
  );
}

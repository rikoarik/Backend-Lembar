import { describe, expect, it } from 'vitest';

import { renderTemplate } from '../../../src/modules/notifications/domain/NotificationService.js';
import { SEEDED_NOTIFICATION_TEMPLATES } from '../../../src/modules/notifications/persistence/NotificationRepository.js';

describe('notification templates', () => {
  const matrix = [
    {
      templateKey: 'auth.recovery',
      locale: 'id-ID',
      payload: { code: '482915' },
      subject: 'Kode pemulihan kata sandi',
      bodyText: 'Gunakan kode 482915 untuk memulihkan kata sandi Anda.',
    },
    {
      templateKey: 'auth.recovery',
      locale: 'en-US',
      payload: { code: '482915' },
      subject: 'Password recovery code',
      bodyText: 'Use code 482915 to recover your password.',
    },
    {
      templateKey: 'workspace.invite',
      locale: 'id-ID',
      payload: {
        inviter_name: 'Bu Rini',
        workspace_name: 'Tim Kurikulum',
        accept_url: 'https://lembar.test/accept/x',
      },
      subject: 'Undangan ke Tim Kurikulum',
      bodyText:
        'Bu Rini mengundang Anda ke Tim Kurikulum. Terima undangan: https://lembar.test/accept/x',
    },
    {
      templateKey: 'workspace.invite',
      locale: 'en-US',
      payload: {
        inviter_name: 'Bu Rini',
        workspace_name: 'Curriculum Team',
        accept_url: 'https://lembar.test/accept/x',
      },
      subject: 'Invitation to Curriculum Team',
      bodyText:
        'Bu Rini invited you to Curriculum Team. Accept the invitation: https://lembar.test/accept/x',
    },
  ] as const;

  it.each(matrix)(
    'renders $templateKey for $locale',
    ({ templateKey, locale, payload, subject, bodyText }) => {
      const template = SEEDED_NOTIFICATION_TEMPLATES.find(
        (row) => row.templateKey === templateKey && row.locale === locale,
      );
      expect(template).toBeDefined();
      expect(renderTemplate(template!.subject, payload)).toBe(subject);
      expect(renderTemplate(template!.bodyText, payload)).toBe(bodyText);
    },
  );
});

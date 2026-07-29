import { createHash, createHmac } from 'node:crypto';

export interface EligibleTrialProfile {
  email: string;
  phone: string;
  plan: 'free' | 'pro';
}

export interface TrialStore {
  getEligibleProfile(userId: string, workspaceId: string): Promise<EligibleTrialProfile>;
  claim(input: {
    userId: string;
    workspaceId: string;
    emailHash: string;
    phoneHash: string;
    deviceHash: string;
    ipHash: string;
    startsAt: Date;
    endsAt: Date;
  }): Promise<{ startsAt: Date; endsAt: Date }>;
}

export class TrialEligibilityError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export class TrialService {
  constructor(
    private readonly repo: TrialStore,
    private readonly identityPepper: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (identityPepper.length < 16) throw new Error('Trial identity pepper is not configured');
  }

  async claim(input: { userId: string; workspaceId: string; deviceToken: string; ip: string }) {
    if (!input.deviceToken.trim()) throw new TrialEligibilityError('TRIAL_DEVICE_REQUIRED');
    const profile = await this.repo.getEligibleProfile(input.userId, input.workspaceId);
    const email = normalizeEmail(profile.email);
    const phone = normalizeIndonesianPhone(profile.phone);
    if (!email || !phone) throw new TrialEligibilityError('TRIAL_PROFILE_INCOMPLETE');
    if (profile.plan !== 'free') throw new TrialEligibilityError('TRIAL_PLAN_INELIGIBLE');
    const startsAt = this.now();
    const endsAt = new Date(startsAt.getTime() + 60 * 86_400_000);
    return this.repo.claim({
      userId: input.userId,
      workspaceId: input.workspaceId,
      emailHash: hashIdentity(`email:${email}`, this.identityPepper),
      phoneHash: hashIdentity(`phone:${phone}`, this.identityPepper),
      deviceHash: hashDeviceToken(input.deviceToken),
      ipHash: hashIdentity(`ip:${input.ip}`, this.identityPepper),
      startsAt,
      endsAt,
    });
  }
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeIndonesianPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.startsWith('62')) return `+${digits}`;
  if (digits.startsWith('0')) return `+62${digits.slice(1)}`;
  if (digits.startsWith('8')) return `+62${digits}`;
  return '';
}

export function hashIdentity(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex');
}

export function hashDeviceToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

import { randomUUID } from 'node:crypto';
import type { Database } from '../../../infrastructure/database/db.js';
import { throwApiError } from '../../../common/errors/apiError.js';
import { hashPassword, verifyPassword } from '../infrastructure/password.js';
import { generateJwt, verifyJwt, type JwtConfig } from '../infrastructure/jwtMultiRole.js';
import { jwtUsers, USER_ROLES, type UserRole } from '../persistence/jwtUsersSchema.js';
import { tenants } from '../../../infrastructure/database/schema.js';
import { eq, or } from 'drizzle-orm';
import { ApiError } from '../../../common/errors/envelope.js';

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  username?: string;
  phone?: string;
  roles?: UserRole[];
}

export interface LoginInput {
  /** email / username / phone */
  email?: string;
  identifier?: string;
  password: string;
}

export interface UpdateRolesInput {
  roles: UserRole[];
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    username?: string | null;
    phone?: string | null;
    roles: UserRole[];
    workspaceId: string | null;
  };
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
  username?: string | null;
  phone?: string | null;
  roles: UserRole[];
  workspaceId: string | null;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_.]{3,24}$/;
const PHONE_DIGITS_PATTERN = /^\d{8,15}$/;
const PASSWORD_UPPER = /[A-Z]/;
const PASSWORD_NUMBER = /\d/;
const PASSWORD_SYMBOL = /[^A-Za-z0-9]/;

export class JwtMultiRoleAuthService {
  constructor(
    private readonly db: Database,
    private readonly jwtConfig: JwtConfig,
  ) {}

  async register(input: RegisterInput): Promise<AuthResponse> {
    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    const username = (input.username ?? name).trim().toLowerCase();
    const phone = this.normalizePhone(input.phone);

    if (!this.isValidEmail(email)) {
      throwApiError('invalid_email', 'Format email tidak valid');
    }

    if (!USERNAME_PATTERN.test(username)) {
      throwApiError(
        'invalid_username',
        'Username 3-24 karakter: huruf, angka, titik, atau underscore',
      );
    }

    this.assertPasswordPolicy(input.password);

    if (!name) {
      throwApiError('invalid_name', 'Name tidak boleh kosong');
    }

    if (phone && !PHONE_DIGITS_PATTERN.test(phone)) {
      throwApiError('invalid_phone', 'Nomor telepon tidak valid');
    }

    const roles = input.roles && input.roles.length > 0 ? input.roles : (['subscriber'] as UserRole[]);
    const invalidRoles = roles.filter((role) => !(USER_ROLES as readonly string[]).includes(role));
    if (invalidRoles.length > 0) {
      throwApiError(
        'invalid_roles',
        `Roles tidak valid: ${invalidRoles.join(', ')}. Allowed: ${USER_ROLES.join(', ')}`,
      );
    }

    // Uniqueness checks
    const [existingEmail] = await this.db
      .select()
      .from(jwtUsers)
      .where(eq(jwtUsers.email, email))
      .limit(1);
    if (existingEmail) throwApiError('email_exists', 'Email sudah terdaftar');

    const [existingUsername] = await this.db
      .select()
      .from(jwtUsers)
      .where(eq(jwtUsers.username, username))
      .limit(1);
    if (existingUsername) throwApiError('username_exists', 'Username sudah dipakai');

    if (phone) {
      const [existingPhone] = await this.db
        .select()
        .from(jwtUsers)
        .where(eq(jwtUsers.phone, phone))
        .limit(1);
      if (existingPhone) throwApiError('phone_exists', 'Nomor telepon sudah terdaftar');
    }

    const passwordHash = await hashPassword(input.password);

    const workspaceSlug = this.generateWorkspaceSlug(email);
    const [workspace] = await this.db
      .insert(tenants)
      .values({
        slug: workspaceSlug,
        name: `${name}'s Workspace`,
      })
      .returning();

    if (!workspace) {
      throwApiError('workspace_creation_failed', 'Gagal membuat workspace');
    }

    const [user] = await this.db
      .insert(jwtUsers)
      .values({
        email,
        username,
        phone: phone || null,
        passwordHash,
        name,
        roles,
        workspaceId: workspace.id,
      })
      .returning();

    if (!user) {
      throwApiError('user_creation_failed', 'Gagal membuat user');
    }

    return this.toAuthResponse(user);
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const identifier = (input.identifier ?? input.email ?? '').trim();
    if (!identifier || !input.password) {
      throwApiError('missing_fields', 'Email/username/telepon dan password diperlukan');
    }

    const user = await this.findUserByIdentifier(identifier);
    if (!user) {
      throwApiError('invalid_credentials', 'Email/username/telepon atau password salah');
    }

    const isValid = await verifyPassword(input.password, user.passwordHash);
    if (!isValid) {
      throwApiError('invalid_credentials', 'Email/username/telepon atau password salah');
    }

    return this.toAuthResponse(user);
  }

  async getCurrentUser(token: string): Promise<UserInfo> {
    try {
      const payload = verifyJwt(token, this.jwtConfig.secret);
      const [user] = await this.db
        .select()
        .from(jwtUsers)
        .where(eq(jwtUsers.id, payload.userId))
        .limit(1);

      if (!user) {
        throwApiError('user_not_found', 'User tidak ditemukan');
      }

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        phone: user.phone,
        roles: user.roles,
        workspaceId: user.workspaceId,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throwApiError('invalid_token', 'Token tidak valid atau expired');
    }
  }

  async updateRoles(userId: string, input: UpdateRolesInput): Promise<UserInfo> {
    if (!input.roles || input.roles.length === 0) {
      throwApiError('invalid_roles', 'Roles tidak boleh kosong');
    }

    const invalidRoles = input.roles.filter((role) => !(USER_ROLES as readonly string[]).includes(role));
    if (invalidRoles.length > 0) {
      throwApiError(
        'invalid_roles',
        `Roles tidak valid: ${invalidRoles.join(', ')}. Allowed: ${USER_ROLES.join(', ')}`,
      );
    }

    const [user] = await this.db
      .update(jwtUsers)
      .set({
        roles: input.roles,
        updatedAt: new Date(),
      })
      .where(eq(jwtUsers.id, userId))
      .returning();

    if (!user) {
      throwApiError('user_not_found', 'User tidak ditemukan');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username,
      phone: user.phone,
      roles: user.roles,
      workspaceId: user.workspaceId,
    };
  }

  private async findUserByIdentifier(identifier: string) {
    const value = identifier.trim();
    const lower = value.toLowerCase();
    const phone = this.normalizePhone(value);

    if (value.includes('@')) {
      const [user] = await this.db
        .select()
        .from(jwtUsers)
        .where(eq(jwtUsers.email, lower))
        .limit(1);
      return user ?? null;
    }

    if (phone && PHONE_DIGITS_PATTERN.test(phone)) {
      const [user] = await this.db
        .select()
        .from(jwtUsers)
        .where(or(eq(jwtUsers.phone, phone), eq(jwtUsers.username, lower)))
        .limit(1);
      return user ?? null;
    }

    const [user] = await this.db
      .select()
      .from(jwtUsers)
      .where(eq(jwtUsers.username, lower))
      .limit(1);
    return user ?? null;
  }

  private toAuthResponse(user: typeof jwtUsers.$inferSelect): AuthResponse {
    const token = generateJwt(
      {
        userId: user.id,
        email: user.email,
        roles: user.roles,
        workspaceId: user.workspaceId,
      },
      this.jwtConfig,
    );

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        phone: user.phone,
        roles: user.roles,
        workspaceId: user.workspaceId,
      },
    };
  }

  private assertPasswordPolicy(password: string) {
    if (
      password.length < 12 ||
      !PASSWORD_UPPER.test(password) ||
      !PASSWORD_NUMBER.test(password) ||
      !PASSWORD_SYMBOL.test(password)
    ) {
      throwApiError(
        'password_policy',
        'Kata sandi minimal 12 karakter, berisi huruf besar, angka, dan simbol',
      );
    }
  }

  private normalizePhone(input?: string | null): string | null {
    if (!input) return null;
    const digits = input.replace(/\D/g, '');
    if (!digits) return null;
    // Convert 08xxxx / 8xxxx to 62xxxx for consistency
    if (digits.startsWith('0')) return `62${digits.slice(1)}`;
    if (digits.startsWith('8')) return `62${digits}`;
    return digits;
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private generateWorkspaceSlug(email: string): string {
    const username = email.split('@')[0];
    if (!username) {
      return `user-${randomUUID().slice(0, 8)}`;
    }
    const sanitized = username.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const random = randomUUID().slice(0, 8);
    return `${sanitized}-${random}`;
  }
}

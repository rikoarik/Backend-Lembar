import { randomUUID } from 'node:crypto';
import type { Database } from '../../../infrastructure/database/db.js';
import { throwApiError } from '../../../common/errors/apiError.js';
import { hashPassword, verifyPassword } from '../infrastructure/password.js';
import { generateJwt, verifyJwt, type JwtConfig, type JwtPayload } from '../infrastructure/jwtMultiRole.js';
import { jwtUsers, USER_ROLES, type UserRole } from '../persistence/jwtUsersSchema.js';
import { tenants } from '../../../infrastructure/database/schema.js';
import { eq } from 'drizzle-orm';
import { ApiError } from '../../../common/errors/envelope.js';

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  roles?: UserRole[];
}

export interface LoginInput {
  email: string;
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
    roles: UserRole[];
    workspaceId: string | null;
  };
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
  roles: UserRole[];
  workspaceId: string | null;
}

export class JwtMultiRoleAuthService {
  constructor(
    private readonly db: Database,
    private readonly jwtConfig: JwtConfig,
  ) {}

  async register(input: RegisterInput): Promise<AuthResponse> {
    // Validasi input
    if (!this.isValidEmail(input.email)) {
      throwApiError('invalid_email', 'Format email tidak valid');
    }

    if (input.password.length < 8) {
      throwApiError('password_too_short', 'Password minimal 8 karakter');
    }

    if (!input.name || input.name.trim().length === 0) {
      throwApiError('invalid_name', 'Name tidak boleh kosong');
    }

    // Validasi roles jika diberikan
    const roles = input.roles && input.roles.length > 0 ? input.roles : (['subscriber'] as UserRole[]);
    const invalidRoles = roles.filter((role) => !(USER_ROLES as readonly string[]).includes(role));
    if (invalidRoles.length > 0) {
      throwApiError(
        'invalid_roles',
        `Roles tidak valid: ${invalidRoles.join(', ')}. Allowed: ${USER_ROLES.join(', ')}`,
      );
    }

    // Cek apakah email sudah terdaftar
    const [existing] = await this.db
      .select()
      .from(jwtUsers)
      .where(eq(jwtUsers.email, input.email))
      .limit(1);

    if (existing) {
      throwApiError('email_exists', 'Email sudah terdaftar');
    }

    // Hash password
    const passwordHash = await hashPassword(input.password);

    // Buat workspace untuk user baru
    const workspaceSlug = this.generateWorkspaceSlug(input.email);
    const [workspace] = await this.db
      .insert(tenants)
      .values({
        slug: workspaceSlug,
        name: `${input.name}'s Workspace`,
      })
      .returning();

    if (!workspace) {
      throwApiError('workspace_creation_failed', 'Gagal membuat workspace');
    }

    // Simpan user
    const [user] = await this.db
      .insert(jwtUsers)
      .values({
        email: input.email,
        passwordHash,
        name: input.name,
        roles: roles,
        workspaceId: workspace.id,
      })
      .returning();

    if (!user) {
      throwApiError('user_creation_failed', 'Gagal membuat user');
    }

    // Generate JWT
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
        roles: user.roles,
        workspaceId: user.workspaceId,
      },
    };
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    if (!input.email || !input.password) {
      throwApiError('missing_fields', 'Email dan password diperlukan');
    }

    // Cari user berdasarkan email
    const [user] = await this.db
      .select()
      .from(jwtUsers)
      .where(eq(jwtUsers.email, input.email))
      .limit(1);

    if (!user) {
      throwApiError('invalid_credentials', 'Email atau password salah');
    }

    // Verifikasi password
    const isValid = await verifyPassword(input.password, user.passwordHash);
    if (!isValid) {
      throwApiError('invalid_credentials', 'Email atau password salah');
    }

    // Generate JWT
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
        roles: user.roles,
        workspaceId: user.workspaceId,
      },
    };
  }

  async getCurrentUser(token: string): Promise<UserInfo> {
    try {
      const payload = verifyJwt(token, this.jwtConfig.secret);

      // Ambil user dari database untuk pastikan masih exist
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
        roles: user.roles,
        workspaceId: user.workspaceId,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      // JWT verification errors
      throwApiError('invalid_token', 'Token tidak valid atau expired');
    }
  }

  async updateRoles(userId: string, input: UpdateRolesInput): Promise<UserInfo> {
    if (!input.roles || input.roles.length === 0) {
      throwApiError('invalid_roles', 'Roles tidak boleh kosong');
    }

    // Validasi roles
    const invalidRoles = input.roles.filter((role) => !(USER_ROLES as readonly string[]).includes(role));
    if (invalidRoles.length > 0) {
      throwApiError(
        'invalid_roles',
        `Roles tidak valid: ${invalidRoles.join(', ')}. Allowed: ${USER_ROLES.join(', ')}`,
      );
    }

    // Update roles
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
      roles: user.roles,
      workspaceId: user.workspaceId,
    };
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

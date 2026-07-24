-- Migration: 0014_jwt_users_role_check
-- Adds CHECK constraint on jwt_users.roles to match users table
-- Rollback: ALTER TABLE jwt_users DROP CONSTRAINT jwt_users_roles_check;

ALTER TABLE "jwt_users" ADD CONSTRAINT "jwt_users_roles_check"
  CHECK ("roles" <@ ARRAY['superadmin','school_admin','teacher','subscriber']::text[]);
